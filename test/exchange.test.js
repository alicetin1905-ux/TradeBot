// Exercises src/exchange.js against an in-memory stand-in for Bybit, so the
// order flow can be checked without network access or API keys.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const exchange = require('../src/exchange');
const { sign, createClient } = require('../src/bybit');
const config = require('../config');

const INST = {
  BTCUSDT: { qtyStep: 0.001, minOrderQty: 0.001, minNotional: 5, tickSize: 0.1 },
  ETHUSDT: { qtyStep: 0.01, minOrderQty: 0.01, minNotional: 5, tickSize: 0.01 },
  SOLUSDT: { qtyStep: 0.1, minOrderQty: 0.1, minNotional: 5, tickSize: 0.01 },
  XRPUSDT: { qtyStep: 1, minOrderQty: 1, minNotional: 5, tickSize: 0.0001 },
  BNBUSDT: { qtyStep: 0.01, minOrderQty: 0.01, minNotional: 5, tickSize: 0.1 },
  DOGEUSDT: { qtyStep: 1, minOrderQty: 1, minNotional: 5, tickSize: 0.00001 },
};

function fakeBybit({ equity = 10000, marks = {} } = {}) {
  let seq = 0;
  const ex = {
    equity, marks: { ...marks }, positions: {}, orders: {}, closedPnl: [], calls: [],
    id: () => 'o' + (++seq),
    // Test helpers: fill a resting TP order / hit the stop at its price.
    fillOrder(orderId, at = Date.now()) {
      const o = ex.orders[orderId];
      const p = ex.positions[o.symbol];
      const qty = Math.min(o.qty, p.size);
      ex.closedPnl.push({ symbol: o.symbol, orderId, qty, exit: o.price, pnl: (o.price - p.avgPrice) * p.bias * qty, at });
      p.size = +(p.size - qty).toFixed(8);
      delete ex.orders[orderId];
      if (p.size <= 0) delete ex.positions[o.symbol];
    },
    hitStop(symbol, at = Date.now()) {
      const p = ex.positions[symbol];
      ex.closedPnl.push({ symbol, orderId: ex.id(), qty: p.size, exit: p.stopLoss, pnl: (p.stopLoss - p.avgPrice) * p.bias * p.size, at });
      delete ex.positions[symbol];
    },
  };
  const client = {
    async getWallet() {
      const im = Object.values(ex.positions).reduce((s, p) => s + p.size * p.avgPrice / 10, 0);
      return { equity: ex.equity, available: ex.equity - im };
    },
    async getPositions() { return JSON.parse(JSON.stringify(ex.positions)); },
    async getInstrument(s) { return INST[s]; },
    async getMarkPrice(s) { return ex.marks[s]; },
    async setLeverage(s, l) { ex.calls.push(['setLeverage', s, l]); },
    async openMarket({ symbol, bias, qty, stopLoss }) {
      ex.calls.push(['openMarket', symbol, bias, qty, stopLoss]);
      ex.positions[symbol] = { symbol, bias, size: qty, avgPrice: ex.marks[symbol], stopLoss, markPrice: ex.marks[symbol] };
      return ex.id();
    },
    async placeTakeProfit({ symbol, bias, qty, price }) {
      const id = ex.id();
      ex.orders[id] = { symbol, bias, qty, price };
      return id;
    },
    async setStopLoss(symbol, sl) {
      const p = ex.positions[symbol];
      if ((ex.marks[symbol] - sl) * p.bias <= 0) throw new Error('SL on wrong side of mark');
      p.stopLoss = sl;
      ex.calls.push(['setStopLoss', symbol, sl]);
    },
    async closeMarket({ symbol, qty }) {
      const p = ex.positions[symbol];
      const id = ex.id();
      const m = ex.marks[symbol];
      ex.closedPnl.push({ symbol, orderId: id, qty, exit: m, pnl: (m - p.avgPrice) * p.bias * qty, at: Date.now() });
      delete ex.positions[symbol];
      ex.calls.push(['closeMarket', symbol, qty]);
      return id;
    },
    async cancelAll(symbol) {
      for (const [id, o] of Object.entries(ex.orders)) if (o.symbol === symbol) delete ex.orders[id];
      ex.calls.push(['cancelAll', symbol]);
    },
    async getClosedPnl(symbol, since) { return ex.closedPnl.filter(r => r.symbol === symbol && r.at >= since); },
  };
  return { ex, client };
}

function freshState() {
  return {
    account: { balance: 1000, startingBalance: 1000 },
    positions: {}, trades: [], flipEntries: {}, scores: {}, closing: {}, seenOrderIds: [],
  };
}

// Strategy candidate as run.js builds it; empty candles => no liquidity nudge.
function candidate(symbol, bias, score, entry, stopPct) {
  const stop = entry * (1 - bias * stopPct);
  return {
    symbol, data: { candles: { [config.ENTRY_TF]: [] } }, fibCheck: { agrees: true, impulse: null },
    analysis: { bias, score, price: entry, closedAt: Date.now() - 1000, plan: { entry, stop } },
  };
}

const marks = { BTCUSDT: 100000, ETHUSDT: 4000, SOLUSDT: 200, XRPUSDT: 2.5, BNBUSDT: 900, DOGEUSDT: 0.25 };

test('opens up to 4 positions, 25% margin at 10x, stop attached, 3 reduce-only targets', async () => {
  const { ex, client } = fakeBybit({ marks });
  const st = freshState();
  const events = [];
  const cands = [
    candidate('XRPUSDT', 1, 80, 2.5, 0.02),
    candidate('BTCUSDT', 1, 70, 100000, 0.01),
    candidate('ETHUSDT', -1, -60, 4000, 0.015),
    candidate('SOLUSDT', 1, 50, 200, 0.02),
    candidate('BNBUSDT', 1, 40, 900, 0.02),
  ];
  await exchange.runExchange({ client, st, signals: {}, candidates: cands, events });

  assert.equal(Object.keys(st.positions).length, 4);
  assert.ok(!st.positions.BNBUSDT, 'weakest candidate gets no slot');
  assert.ok(events.some(e => e.symbol === 'BNBUSDT' && /slots in use/.test(e.reason)));

  const x = st.positions.XRPUSDT;
  assert.equal(x.qtyTotal, 1000);                       // 250 margin * 10 / 2.5
  assert.ok(Math.abs(x.margin - 250) < 1e-9);
  assert.equal(x.stop, 2.45);                           // 2% below the fill
  assert.deepEqual([x.t1, x.t2, x.t3], [2.55, 2.6, 2.65]); // 1R / 2R / 3R
  assert.deepEqual([x.qtyT1, x.qtyT2, x.qtyT3], [400, 350, 250]);
  const xrpOrders = Object.values(ex.orders).filter(o => o.symbol === 'XRPUSDT');
  assert.equal(xrpOrders.length, 3);
  assert.ok(xrpOrders.every(o => o.bias === 1));

  const e = st.positions.ETHUSDT;                       // short: stop above, targets below
  assert.equal(e.bias, -1);
  assert.ok(e.stop > e.entry && e.t1 < e.entry && e.t3 < e.t2);
  assert.ok(ex.calls.some(c => c[0] === 'setLeverage' && c[2] === 10));
});

test('sizes off the 1000 USDT allocation, not a larger demo wallet', async () => {
  const { client } = fakeBybit({ equity: 50000, marks });
  const st = freshState();
  await exchange.runExchange({ client, st, signals: {}, candidates: [candidate('BTCUSDT', 1, 70, 100000, 0.01)], events: [] });
  assert.ok(Math.abs(st.positions.BTCUSDT.margin - 250) < 1, `margin ${st.positions.BTCUSDT.margin}`);
});

test('T1 fill moves the exchange stop to breakeven; T2/T3 fills book P&L and close out', async () => {
  const { ex, client } = fakeBybit({ marks });
  const st = freshState();
  await exchange.runExchange({ client, st, signals: {}, candidates: [candidate('XRPUSDT', 1, 80, 2.5, 0.02)], events: [] });
  const pos = st.positions.XRPUSDT;

  ex.marks.XRPUSDT = 2.56;
  ex.fillOrder(pos.orders.t1);
  let events = [];
  await exchange.runExchange({ client, st, signals: {}, candidates: [], events });
  assert.equal(st.positions.XRPUSDT.breakeven, true);
  assert.equal(ex.positions.XRPUSDT.stopLoss, 2.5);
  assert.ok(Math.abs(st.account.balance - 1020) < 1e-6); // 400 * 0.05
  assert.equal(st.trades.at(-1).reason, 'T1 hit, stop moved to breakeven');

  ex.marks.XRPUSDT = 2.66;
  ex.fillOrder(pos.orders.t2);
  ex.fillOrder(pos.orders.t3);
  events = [];
  await exchange.runExchange({ client, st, signals: {}, candidates: [], events });
  assert.ok(!st.positions.XRPUSDT);
  assert.deepEqual(st.trades.map(t => t.reason), ['T1 hit, stop moved to breakeven', 'T2 hit', 'T3 hit, position closed']);
  assert.ok(Math.abs(st.account.balance - (1000 + 20 + 35 + 37.5)) < 1e-6);

  // Re-running doesn't double-book the same fills.
  await exchange.runExchange({ client, st, signals: {}, candidates: [], events: [] });
  assert.equal(st.trades.length, 3);
});

test('stop hit on the exchange: loss booked, leftover target orders cancelled', async () => {
  const { ex, client } = fakeBybit({ marks });
  const st = freshState();
  await exchange.runExchange({ client, st, signals: {}, candidates: [candidate('XRPUSDT', 1, 80, 2.5, 0.02)], events: [] });
  ex.hitStop('XRPUSDT');
  const events = [];
  await exchange.runExchange({ client, st, signals: {}, candidates: [], events });
  assert.ok(!st.positions.XRPUSDT);
  assert.equal(st.trades.at(-1).reason, 'stop hit');
  assert.ok(Math.abs(st.account.balance - 950) < 1e-6);  // 1000 * -0.05
  assert.equal(Object.values(ex.orders).filter(o => o.symbol === 'XRPUSDT').length, 0);
});

test('score flip closes the position at market', async () => {
  const { ex, client } = fakeBybit({ marks });
  const st = freshState();
  await exchange.runExchange({ client, st, signals: {}, candidates: [candidate('XRPUSDT', 1, 80, 2.5, 0.02)], events: [] });
  ex.marks.XRPUSDT = 2.52;
  const signals = { XRPUSDT: { analysis: { bias: -1, score: -40 } } };
  await exchange.runExchange({ client, st, signals, candidates: [], events: [] });
  assert.ok(!ex.positions.XRPUSDT && !st.positions.XRPUSDT);
  assert.equal(st.trades.at(-1).reason, 'signal-flip');
  assert.ok(Math.abs(st.account.balance - 1020) < 1e-6);
});

test('halt and daily loss limit block new entries only', async () => {
  const { client } = fakeBybit({ marks });
  let st = freshState();
  let events = [];
  await exchange.runExchange({ client, st, signals: {}, candidates: [candidate('XRPUSDT', 1, 80, 2.5, 0.02)], events, halt: true });
  assert.equal(Object.keys(st.positions).length, 0);
  assert.ok(events.some(e => /halted/.test(e.reason)));

  st = freshState();
  st.account.balance = 750;
  st.trades.push({ symbol: 'BTCUSDT', pnl: -250, closedAt: Date.now() });
  events = [];
  await exchange.runExchange({ client, st, signals: {}, candidates: [candidate('XRPUSDT', 1, 80, 2.5, 0.02)], events });
  assert.equal(Object.keys(st.positions).length, 0);
  assert.ok(events.some(e => /daily loss limit/.test(e.reason)));
});

test('an untracked position on the exchange takes a slot and blocks that coin', async () => {
  const { ex, client } = fakeBybit({ marks });
  ex.positions.XRPUSDT = { symbol: 'XRPUSDT', bias: 1, size: 10, avgPrice: 2.5, stopLoss: 0 };
  const st = freshState();
  const events = [];
  await exchange.runExchange({ client, st, signals: {}, candidates: [candidate('XRPUSDT', 1, 80, 2.5, 0.02)], events });
  assert.ok(!st.positions.XRPUSDT);
  assert.ok(events.some(e => /already open on the exchange/.test(e.reason)));
});

test('target split folds slices below the minimum order size', () => {
  assert.deepEqual(exchange.splitTargets(3, { qtyStep: 1, minOrderQty: 1 }), [1, 1, 1]);
  assert.deepEqual(exchange.splitTargets(2, { qtyStep: 1, minOrderQty: 1 }), [0, 0, 2]);
  assert.deepEqual(exchange.splitTargets(0.005, { qtyStep: 0.001, minOrderQty: 0.001 }), [0.002, 0.001, 0.002]);
});

test('request signing matches Bybit v5: HMAC-SHA256(ts + key + recvWindow + payload)', async () => {
  const expected = crypto.createHmac('sha256', 'sec').update('1700000000000' + 'key' + '10000' + 'category=linear').digest('hex');
  assert.equal(sign('sec', '1700000000000', 'key', 'category=linear'), expected);

  let seen;
  const fetchImpl = async (url, opts) => { seen = { url, opts }; return { status: 200, text: async () => JSON.stringify({ retCode: 0, result: { orderId: 'x1' } }) }; };
  const c = createClient({ env: 'demo', apiKey: 'key', apiSecret: 'sec', fetchImpl });
  await c.openMarket({ symbol: 'XRPUSDT', bias: 1, qty: 10, stopLoss: 2.4 });
  assert.equal(seen.url, 'https://api-demo.bybit.com/v5/order/create');
  const body = JSON.parse(seen.opts.body);
  assert.deepEqual([body.side, body.orderType, body.qty, body.stopLoss, body.category], ['Buy', 'Market', '10', '2.4', 'linear']);
  const h = seen.opts.headers;
  assert.equal(h['X-BAPI-SIGN'], sign('sec', h['X-BAPI-TIMESTAMP'], 'key', seen.opts.body));
  assert.throws(() => createClient({ apiKey: 'k', apiSecret: 's', env: 'live' }), /only supports demo/);
  assert.throws(() => createClient({ apiKey: 'k', apiSecret: 's', env: 'testnet' }), /only supports demo/);
});

test('demo client: signed calls go to api-demo, market data to public mainnet without the key', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, headers: opts.headers || {} });
    const result = url.includes('instruments-info')
      ? { list: [{ lotSizeFilter: { qtyStep: '1', minOrderQty: '1', minNotionalValue: '5' }, priceFilter: { tickSize: '0.0001' } }] }
      : url.includes('tickers') ? { list: [{ markPrice: '2.5' }] }
        : { list: [{ totalEquity: '50000', totalAvailableBalance: '49000', coin: [{ coin: 'USDT', equity: '50000' }] }] };
    return { status: 200, text: async () => JSON.stringify({ retCode: 0, result }) };
  };
  const c = createClient({ env: 'demo', apiKey: 'key', apiSecret: 'sec', fetchImpl });
  assert.deepEqual(await c.getWallet(), { equity: 50000, available: 49000 });
  assert.deepEqual(await c.getInstrument('XRPUSDT'), { qtyStep: 1, minOrderQty: 1, minNotional: 5, tickSize: 0.0001 });
  assert.equal(await c.getMarkPrice('XRPUSDT'), 2.5);

  assert.ok(seen[0].url.startsWith('https://api-demo.bybit.com/v5/account/wallet-balance?'));
  assert.equal(seen[0].headers['X-BAPI-API-KEY'], 'key');
  for (const r of seen.slice(1)) {
    assert.ok(r.url.startsWith('https://api.bybit.com/v5/market/'), r.url);
    assert.equal(r.headers['X-BAPI-API-KEY'], undefined, 'public calls must not carry the key');
  }
});

test('ntfy alerts: one message per entry / fill / exit, none for noise', async () => {
  const notify = require('../src/notify');
  const st = { account: { balance: 1037.1 }, positions: { XRPUSDT: {} } };
  const events = [
    { symbol: 'XRPUSDT', type: 'enter', bias: 1, score: 82, entry: 1.593, stop: 1.5404, t1: 1.6457, t2: 1.6983, t3: 1.751, margin: 249.97, riskAmt: 82.54 },
    { symbol: 'XRPUSDT', type: 'partial', reason: 'T1 hit, stop moved to breakeven', pnl: 37.1, price: 1.65 },
    { symbol: 'DOGEUSDT', type: 'exit', reason: 'stop hit', pnl: -71.08, price: 0.09737 },
    { symbol: 'DOGEUSDT', type: 'exit', reason: 'closed on exchange (P&L record pending)', pnl: 0 },
    { symbol: 'BTCUSDT', type: 'hold', reason: 'waiting', score: 60 },
    { symbol: 'XRPUSDT', type: 'info', reason: 'T1 filled, exchange stop moved to breakeven' },
  ];
  const msgs = notify.messagesFor(events, st);
  assert.deepEqual(msgs.map(m => m.title), ['XRP LONG opened', 'XRP T1 hit +$37.10', 'DOGE closed -$71.08']);
  assert.match(msgs[0].message, /Entry 1\.5930 · SL 1\.5404/);
  assert.match(msgs[2].message, /Balance \$1037\.10 · 1\/4 open/);

  const posted = [];
  const fetchImpl = async (url, opts) => { posted.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200 }; };
  process.env.NTFY_TOPIC = 'test-topic';
  assert.equal(await notify.send(events, st, { fetchImpl }), 3);
  assert.equal(posted[0].url, 'https://ntfy.sh/');
  assert.equal(posted[0].body.topic, 'test-topic');

  process.env.NTFY_TOPIC = 'off';
  assert.equal(await notify.send(events, st, { fetchImpl }), 0);

  // A failing push is logged, never thrown.
  process.env.NTFY_TOPIC = 'test-topic';
  const logs = [];
  const bad = async () => { throw new Error('offline'); };
  assert.equal(await notify.send(events, st, { fetchImpl: bad, log: (l) => logs.push(l) }), 0);
  assert.equal(logs.length, 3);
  delete process.env.NTFY_TOPIC;
});

test('one trade per signal: no re-entry in the same direction until the signal resets', () => {
  const { rememberSignals, signalUsed } = require('../src/strategy');
  const sig = (bias) => ({ XRPUSDT: { analysis: { bias } } });
  const mem = {};

  // Position opens long -> that long signal is used.
  rememberSignals(mem, sig(1), { XRPUSDT: { bias: 1 } });
  assert.equal(signalUsed(mem, 'XRPUSDT', 1), true);

  // Position closes, score still long -> still blocked.
  rememberSignals(mem, sig(1), {});
  assert.equal(signalUsed(mem, 'XRPUSDT', 1), true);
  // ...but the opposite direction is a different signal.
  assert.equal(signalUsed(mem, 'XRPUSDT', -1), false);

  // Score goes neutral -> re-armed; a new long later is allowed.
  rememberSignals(mem, sig(0), {});
  assert.equal(signalUsed(mem, 'XRPUSDT', 1), false);
  rememberSignals(mem, sig(1), {});
  assert.equal(signalUsed(mem, 'XRPUSDT', 1), false);

  // A reset seen while the position is still open counts too.
  rememberSignals(mem, sig(1), { XRPUSDT: { bias: 1 } });
  rememberSignals(mem, sig(0), { XRPUSDT: { bias: 1 } });
  rememberSignals(mem, sig(1), { XRPUSDT: { bias: 1 } });
  rememberSignals(mem, sig(1), {});
  assert.equal(signalUsed(mem, 'XRPUSDT', 1), false);
});
