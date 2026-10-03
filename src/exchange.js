// Exchange executor — turns the strategy's decisions into real orders on a
// Bybit Demo Trading account (see bybit.js).
//
// Per run:
//   1. Reconcile every tracked position with the exchange: record realized
//      fills (closed-pnl, net of fees), detect T1/T2 fills from the shrinking
//      position size, move the stop to breakeven after T1, close on a signal
//      flip, and forget positions the exchange has fully closed.
//   2. Open new positions into free slots (strongest |score| first):
//      margin = MARGIN_USDT (or MARGIN_PCT of the balance), x LEVERAGE, market entry
//      with the stop attached, then reduce-only limit orders for T1/T2/T3.
//      With LIMIT_ENTRY_ATR set, the entry is a resting limit order that much
//      better than the price instead (pullback entry); it holds a slot until
//      it fills (targets are placed then) or expires after LIMIT_ENTRY_HOURS.
//
// The stop and targets live ON the exchange, so they still work if this
// machine goes down between runs. The strategy's levels come from OKX
// mainnet candles; they're carried over to the exchange as % distances from
// its own fill price (OKX and Bybit prices differ slightly).
'use strict';

const config = require('../config');
const strategy = require('./strategy');
const { sizeFor } = require('./risk');

const P = config.PORTFOLIO;
const DAY_MS = 86400000;

function floorStep(x, step) { return Math.floor(x / step + 1e-9) * step; }
function roundStep(x, step) {
  const dp = Math.max(0, (String(step).split('.')[1] || '').length);
  return +(Math.round(x / step) * step).toFixed(dp);
}
function fixStep(x, step) {
  const dp = Math.max(0, (String(step).split('.')[1] || '').length);
  return +x.toFixed(dp);
}

// Allocation = the capital this bot may use on the account: the configured
// starting balance plus everything it has realized since. Sizing uses the
// smaller of this and the exchange's own equity, so a big demo wallet
// still trades like the configured 1000 USDT account.
function sizingBase(st, wallet) { return Math.max(0, Math.min(st.account.balance, wallet.equity)); }

// Margin for one new trade. The cap is MARGIN_USDT when set, else MARGIN_PCT
// of the (allocation-capped) balance. With RISK_USDT and a stop distance
// (fraction of entry), the position is sized so the stop loses RISK_USDT,
// never more than the cap.
// The loss at the stop for a new trade: RISK_PCT % of the (allocation-capped)
// balance when set, else the fixed RISK_USDT; null = no risk sizing.
function riskPerTrade(base) {
  if (P.RISK_PCT != null) return base * P.RISK_PCT / 100;
  return P.RISK_USDT;
}

function marginPerTrade(base, stopDist = null) {
  const cap = P.MARGIN_USDT != null ? P.MARGIN_USDT : base * P.MARGIN_PCT / 100;
  const risk = riskPerTrade(base);
  if (risk == null || !(stopDist > 0)) return cap;
  return Math.min(risk / stopDist, cap * P.LEVERAGE) / P.LEVERAGE;
}

function usedMargin(positions) {
  return Object.values(positions).reduce((s, p) => s + p.margin * (p.qtyRemaining / p.qtyTotal), 0);
}

// When this position's stop goes to entry: fixed at open (BREAKEVEN_AFTER);
// positions opened before the setting existed used 't1'.
function beAfter(pos) { return pos.beAfter || 't1'; }

function reasonFor(pos, orderId) {
  const o = pos.orders || {};
  const be = beAfter(pos);
  if (orderId && orderId === o.t1) return be === 't1' ? 'T1 hit, stop moved to breakeven' : 'T1 hit';
  if (orderId && orderId === o.t2) return config.LOCK_T1_AFTER_T2 ? 'T2 hit, stop moved to T1' : be === 't2' ? 'T2 hit, stop moved to breakeven' : 'T2 hit';
  if (orderId && orderId === o.t3) return 'T3 hit, position closed';
  if (orderId && orderId === o.close) return pos.closedBy === 'command' ? 'closed by close-all' : 'signal-flip';
  return pos.lockedT1 ? 'stop hit at T1 (locked after T2)' : pos.breakeven ? 'breakeven stop hit' : 'stop hit';
}

// Pulls closed-pnl records for one position since its last sync and appends
// any new ones to the trade log; returns the realized sum added.
// `until` (ms) and `skipIds` keep a closed position from claiming records
// that belong to a newer trade on the same coin.
async function recordFills(client, st, pos, events, { until = Infinity, skipIds = [] } = {}) {
  const seen = new Set([...st.seenOrderIds, ...skipIds]);
  const records = await client.getClosedPnl(pos.symbol, pos.openedAt - 60000);
  let added = 0;
  for (const r of records.sort((a, b) => a.at - b.at)) {
    if (seen.has(r.orderId) || r.at < pos.openedAt - 60000 || r.at > until) continue;
    seen.add(r.orderId);
    st.seenOrderIds.push(r.orderId);
    const reason = reasonFor(pos, r.orderId);
    st.trades.push({
      symbol: pos.symbol, bias: pos.bias, entry: pos.entry, exit: r.exit, qty: r.qty, pnl: r.pnl,
      reason, openedAt: pos.openedAt, closedAt: r.at, score: pos.score,
    });
    events.push({ symbol: pos.symbol, type: /T[12] hit/.test(reason) ? 'partial' : 'exit', reason, pnl: r.pnl, price: r.exit });
    st.account.balance += r.pnl;
    added += r.pnl;
  }
  if (st.seenOrderIds.length > 1000) st.seenOrderIds = st.seenOrderIds.slice(-1000);
  return added;
}

async function reconcile({ client, st, exPos, signals, events, now }) {
  // Positions closed earlier whose final closed-pnl record may have landed
  // late. Only records from around the close count, and never the orders of
  // a newer open trade on the same coin — otherwise that trade's target
  // fills get booked under the old trade (and mislabelled 'stop hit').
  const CLOSE_GRACE_MS = 5 * 60000;
  for (const [sym, pos] of Object.entries(st.closing)) {
    const newer = st.positions[sym];
    await recordFills(client, st, pos, events, {
      until: (pos.closedDetectedAt || now) + CLOSE_GRACE_MS,
      skipIds: newer && newer.orders ? Object.values(newer.orders) : [],
    });
    if (now - pos.closedDetectedAt > DAY_MS) delete st.closing[sym];
  }

  for (const sym of Object.keys(st.positions)) {
    const pos = st.positions[sym];
    try {
      await recordFills(client, st, pos, events);
      const live = exPos[sym];

      if (!live || live.bias !== pos.bias) {
        await client.cancelAll(sym); // leftover reduce-only target orders
        pos.closedDetectedAt = now;
        st.closing[sym] = pos;
        delete st.positions[sym];
        if (!events.some(e => e.symbol === sym && e.type === 'exit')) {
          events.push({ symbol: sym, type: 'exit', reason: 'closed on exchange (P&L record pending)', pnl: 0 });
        }
        continue;
      }

      pos.qtyRemaining = live.size;
      pos.markPrice = live.markPrice;         // Bybit's own live view, for the hourly status
      pos.unrealisedPnl = live.unrealisedPnl;
      const eps = pos.qtyTotal * 1e-6;
      if (!pos.filled.t1 && live.size <= pos.qtyTotal - pos.qtyT1 + eps) pos.filled.t1 = true;
      if (!pos.filled.t2 && pos.qtyT2 > 0 && live.size <= pos.qtyT3 + eps) pos.filled.t2 = true;

      const be = beAfter(pos);
      if (be !== 'off' && pos.filled[be] && !pos.breakeven) {
        try {
          // entry plus a small buffer into profit so fees are covered (BREAKEVEN_BUFFER_PCT)
          const raw = pos.entry * (1 + pos.bias * (config.BREAKEVEN_BUFFER_PCT || 0) / 100);
          const bePrice = pos.tickSize ? roundStep(raw, pos.tickSize) : raw;
          await client.setStopLoss(sym, bePrice);
          pos.stop = bePrice;
          pos.breakeven = true;
          events.push({ symbol: sym, type: 'info', reason: `${be.toUpperCase()} filled, exchange stop moved to breakeven` });
        } catch (err) {
          // Price already back through entry: a breakeven stop would have
          // triggered, so close what's left now.
          const id = await client.closeMarket({ symbol: sym, bias: pos.bias, qty: live.size });
          pos.orders = { ...pos.orders, close: id };
          pos.breakeven = true;
          events.push({ symbol: sym, type: 'info', reason: `couldn't move stop to breakeven (${err.message}) — closed at market` });
          await recordFills(client, st, pos, events);
          pos.closedDetectedAt = now;
          st.closing[sym] = pos;
          delete st.positions[sym];
          delete exPos[sym];
          continue;
        }
      }

      // LOCK_T1_AFTER_T2: once T2 fills, the exchange stop goes up to T1 so
      // the last part of the trade can't give back more than T1's profit.
      // Applies to every open position, including ones opened before it was on.
      if (config.LOCK_T1_AFTER_T2 && pos.filled.t2 && !pos.lockedT1 && st.positions[sym]) {
        const lockPrice = pos.tickSize ? roundStep(pos.t1, pos.tickSize) : pos.t1;
        try {
          await client.setStopLoss(sym, lockPrice);
          pos.stop = lockPrice;
          pos.lockedT1 = true;
          events.push({ symbol: sym, type: 'info', reason: `T2 filled, exchange stop moved to T1 (${lockPrice})` });
        } catch (err) {
          const mark = live.markPrice;
          if (mark && (mark - lockPrice) * pos.bias <= 0) {
            // Price already back through T1: the locked stop would have hit — close the rest now.
            const id = await client.closeMarket({ symbol: sym, bias: pos.bias, qty: live.size });
            pos.orders = { ...pos.orders, close: id };
            pos.lockedT1 = true;
            events.push({ symbol: sym, type: 'info', reason: `couldn't move stop to T1 (${err.message}) — price is past T1, closed at market` });
            await recordFills(client, st, pos, events);
            pos.closedDetectedAt = now;
            st.closing[sym] = pos;
            delete st.positions[sym];
            delete exPos[sym];
            continue;
          }
          events.push({ symbol: sym, type: 'error', reason: `couldn't move stop to T1 (${err.message}) — will retry next run` });
        }
      }

      const sig = signals[sym];
      if (config.FLIP_EXIT !== false && st.positions[sym] && sig && sig.analysis.bias !== 0 && sig.analysis.bias !== pos.bias) {
        await client.cancelAll(sym);
        const id = await client.closeMarket({ symbol: sym, bias: pos.bias, qty: live.size });
        pos.orders = { ...pos.orders, close: id };
        events.push({ symbol: sym, type: 'info', reason: 'score flipped against open position — closed at market' });
        await recordFills(client, st, pos, events);
        pos.closedDetectedAt = now;
        st.closing[sym] = pos;
        delete st.positions[sym];
        delete exPos[sym];
      }
    } catch (err) {
      events.push({ symbol: sym, type: 'error', reason: err.message });
    }
  }
}

// Splits qty into the T1/T2/T3 shares on the exchange's lot step; a slice
// below the minimum order size is folded into the next target.
function splitTargets(qty, inst) {
  const [a, b] = config.TARGET_SPLIT;
  let q1 = floorStep(qty * a, inst.qtyStep);
  let q2 = floorStep(qty * b, inst.qtyStep);
  let q3 = qty - q1 - q2;
  if (q1 < inst.minOrderQty) { q2 += q1; q1 = 0; }
  if (q2 < inst.minOrderQty) { q3 += q2; q2 = 0; }
  return [q1, q2, q3].map(q => fixStep(q, inst.qtyStep));
}

function dailyLossHit(st, now) {
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const today = st.trades.filter(t => t.closedAt >= dayStart).reduce((s, t) => s + t.pnl, 0);
  const startOfDay = st.account.balance - today;
  return today < 0 && -today >= startOfDay * config.EXECUTION.DAILY_LOSS_LIMIT_PCT / 100;
}

// After an entry fills (market, or a pullback limit): place the T1/T2/T3
// reduce-only orders at the strategy's % distances from the real fill price
// and start tracking the position. ratios = { t1, t2, t3 } as fractions of entry.
async function trackPosition({ client, st, sym, bias, score, live, ratios, inst, stopLoss, orders, now, events, note }) {
  const entry = live.avgPrice;
  const tp = [ratios.t1, ratios.t2, ratios.t3].map(r => roundStep(entry * r, inst.tickSize));
  const [q1, q2, q3] = splitTargets(live.size, inst);
  const slices = [['t1', q1, tp[0]], ['t2', q2, tp[1]], ['t3', q3, tp[2]]];
  for (const [k, q, price] of slices) {
    if (q <= 0) continue;
    try {
      orders[k] = await client.placeTakeProfit({ symbol: sym, bias, qty: q, price });
    } catch (err) {
      events.push({ symbol: sym, type: 'error', reason: `${k.toUpperCase()} order failed (stop is still in place): ${err.message}` });
    }
  }
  const posMargin = (live.size * entry) / P.LEVERAGE;
  st.positions[sym] = {
    symbol: sym, bias, entry, stop: stopLoss, initialStop: stopLoss,
    t1: tp[0], t2: tp[1], t3: tp[2],
    qtyTotal: live.size, qtyRemaining: live.size, qtyT1: q1, qtyT2: q2, qtyT3: q3,
    margin: posMargin, notional: live.size * entry, riskAmt: live.size * Math.abs(entry - stopLoss),
    filled: { t1: q1 === 0, t2: q2 === 0, t3: false }, breakeven: false, beAfter: config.BREAKEVEN_AFTER || 't1',
    openedAt: now, score, orders, tickSize: inst.tickSize,
    markPrice: live.markPrice || entry, unrealisedPnl: live.unrealisedPnl || 0,
  };
  events.push({
    symbol: sym, type: 'enter', bias, score, entry, stop: stopLoss,
    t1: tp[0], t2: tp[1], t3: tp[2], qty: live.size, margin: posMargin, riskAmt: st.positions[sym].riskAmt, note,
  });
  return posMargin;
}

// Resting pullback limit entries: once filled, set up the targets and track
// the position; past their expiry, cancel (a partly filled order keeps what
// filled); cancelled/rejected on the exchange, forget them.
async function processPending({ client, st, exPos, events, now }) {
  for (const [sym, o] of Object.entries(st.pending || {})) {
    try {
      const live = exPos[sym];
      const ord = await client.getOrder(sym, o.orderId);
      const status = ord ? ord.status : null;
      const resting = status === 'New' || status === 'PartiallyFilled' || status === 'Untriggered';
      if (resting && now < o.expiresAt) continue;
      if (resting) {
        try { await client.cancelOrder(sym, o.orderId); } catch (err) { /* filled or gone meanwhile */ }
      }
      if (live && live.bias === o.bias && !st.positions[sym]) {
        delete st.pending[sym];
        await trackPosition({
          client, st, sym, bias: o.bias, score: o.score, live, ratios: o.ratios, inst: o.inst,
          stopLoss: live.stopLoss || o.stopLoss, orders: { entry: o.orderId }, now, events,
          note: `limit entry filled (${o.price})${resting ? ' — partly, rest cancelled' : ''}`,
        });
        exPos[sym] = live;
        continue;
      }
      delete st.pending[sym];
      if (status === 'Filled') {
        // Filled and already closed again between two syncs: book it.
        const pos = { symbol: sym, bias: o.bias, entry: o.price, orders: { entry: o.orderId }, openedAt: o.placedAt, score: o.score, filled: {}, closedDetectedAt: now };
        st.closing[sym] = pos;
        events.push({ symbol: sym, type: 'info', reason: 'limit entry filled and closed again before the next sync' });
      } else {
        events.push({ symbol: sym, type: 'expired', bias: o.bias, price: o.price,
          reason: resting ? `limit entry at ${o.price} not filled within ${config.LIMIT_ENTRY_HOURS}h — cancelled` : `limit entry order ${status || 'not found'} on Bybit — dropped` });
      }
    } catch (err) {
      events.push({ symbol: sym, type: 'error', reason: `pending entry: ${err.message}` });
    }
  }
}

function pendingMargin(st) { return Object.values(st.pending || {}).reduce((s, o) => s + o.margin, 0); }

async function openEntries({ client, st, exPos, wallet, candidates, events, halt, now }) {
  if (!candidates.length) return;
  const block =
    halt ? 'trading halted (TRADEBOT_HALT) — no new entries'
      : dailyLossHit(st, now) ? `daily loss limit (${config.EXECUTION.DAILY_LOSS_LIMIT_PCT}%) reached — no new entries until 00:00 UTC`
        : null;
  if (block) {
    for (const c of candidates) events.push({ symbol: c.symbol, type: 'hold', reason: block, score: c.analysis.score });
    return;
  }

  let available = wallet.available;
  // Trades opened since the current signal candle began (still open or already
  // closed) count toward MAX_NEW_PER_CANDLE — correlated alts tend to fire
  // together, so this spreads them out.
  const tfMs = config.ENTRY_TF === 'D' ? DAY_MS : +config.ENTRY_TF * 60000;
  const candleStart = Math.floor(now / tfMs) * tfMs;
  let newThisCandle = Object.values(st.positions).filter(p => p.openedAt >= candleStart).length
    + new Set(st.trades.filter(t => t.openedAt >= candleStart && !st.positions[t.symbol]).map(t => t.symbol + ':' + t.openedAt)).size;
  for (const c of candidates) {
    const sym = c.symbol;
    const hold = (reason) => events.push({ symbol: sym, type: 'hold', reason, score: c.analysis.score });
    try {
      if (exPos[sym]) { hold('a position is already open on the exchange for this coin'); continue; }
      if (st.pending[sym]) { hold('a limit entry order is already waiting for this coin'); continue; }
      if (P.MAX_NEW_PER_CANDLE != null && newThisCandle >= P.MAX_NEW_PER_CANDLE) {
        hold(`already ${newThisCandle} new trade${newThisCandle === 1 ? '' : 's'} on this candle (max ${P.MAX_NEW_PER_CANDLE})`);
        continue;
      }
      // waiting limit entries hold their slot like an open position
      const waiting = Object.values(st.pending).filter(o => !exPos[o.symbol]);
      if (Object.keys(exPos).length + waiting.length >= P.MAX_OPEN_POSITIONS) { hold(`all ${P.MAX_OPEN_POSITIONS} position slots in use`); continue; }
      const sameDir = Object.values(exPos).filter(p => p.bias === c.analysis.bias).length + waiting.filter(o => o.bias === c.analysis.bias).length;
      if (P.MAX_SAME_DIRECTION != null && sameDir >= P.MAX_SAME_DIRECTION) {
        hold(`already ${sameDir} ${c.analysis.bias === 1 ? 'longs' : 'shorts'} open (max ${P.MAX_SAME_DIRECTION} in one direction)`);
        continue;
      }

      const base = sizingBase(st, wallet);
      // Strategy levels (with GoldenRatio/CRUCIBLE refinement) as % of entry.
      const basePlan = sizeFor({
        symbol: sym, equity: base, bias: c.analysis.bias, entry: c.analysis.plan.entry, stop: c.analysis.plan.stop,
        leverage: P.LEVERAGE, marginPct: P.MARGIN_PCT,
      });
      const opened = strategy.openEntry({ symbol: sym, data: c.data, analysis: c.analysis, plan: basePlan, fibCheck: c.fibCheck });
      if (!opened.position) { hold(opened.reason); continue; }
      const lv = opened.position;
      const ratio = (x) => x / lv.entry;

      // Only full-size trades: if what's still free can't fund this trade's margin
      // (e.g. older, bigger positions still hold it), wait for a close instead
      // of opening an odd, undersized position.
      const margin = marginPerTrade(base, Math.abs(1 - ratio(lv.stop)));
      const free = Math.min(base - usedMargin(st.positions) - pendingMargin(st), available * 0.95);
      if (free < margin * 0.99) { hold(`not enough free margin for a full $${margin.toFixed(0)} trade ($${Math.max(0, free).toFixed(0)} free)`); continue; }

      const inst = await client.getInstrument(sym);
      const mark = await client.getMarkPrice(sym);
      const qty = fixStep(floorStep((margin * P.LEVERAGE) / mark, inst.qtyStep), inst.qtyStep);
      if (qty < inst.minOrderQty || qty * mark < (inst.minNotional || 0)) { hold(`size ${qty} is below Bybit's minimum order`); continue; }

      const stopLoss = roundStep(mark * ratio(lv.stop), inst.tickSize);
      if ((stopLoss - mark) * c.analysis.bias >= 0) { hold('stop would be on the wrong side of the Bybit price'); continue; }

      await client.setLeverage(sym, P.LEVERAGE);
      const ratios = { t1: ratio(lv.t1), t2: ratio(lv.t2), t3: ratio(lv.t3) };
      const bias = c.analysis.bias;

      // Pullback entry: a resting limit order LIMIT_ENTRY_ATR x ATR better than now.
      const atrFrac = c.analysis.atr > 0 && c.analysis.price > 0 ? c.analysis.atr / c.analysis.price : 0;
      if (config.LIMIT_ENTRY_ATR > 0 && atrFrac > 0) {
        const price = roundStep(mark * (1 - bias * config.LIMIT_ENTRY_ATR * atrFrac), inst.tickSize);
        const lq = fixStep(floorStep((margin * P.LEVERAGE) / price, inst.qtyStep), inst.qtyStep);
        const sl = roundStep(price * ratio(lv.stop), inst.tickSize);
        if (lq < inst.minOrderQty) { hold(`size ${lq} is below Bybit's minimum order`); continue; }
        const orderId = await client.openLimit({ symbol: sym, bias, qty: lq, price, stopLoss: sl });
        const hours = config.LIMIT_ENTRY_HOURS || 4;
        st.pending[sym] = {
          symbol: sym, bias, score: c.analysis.score, orderId, price, qty: lq, stopLoss: sl, ratios,
          inst, margin: (lq * price) / P.LEVERAGE, placedAt: now, expiresAt: now + hours * 3600000,
        };
        available -= st.pending[sym].margin;
        newThisCandle++;
        events.push({ symbol: sym, type: 'order', bias, score: c.analysis.score, price, mark, stop: sl, qty: lq, hours });
        continue;
      }

      const entryId = await client.openMarket({ symbol: sym, bias, qty, stopLoss });
      const after = await client.getPositions();
      const live = after[sym];
      if (!live) { events.push({ symbol: sym, type: 'error', reason: `entry order ${entryId} sent but no position showed up` }); continue; }
      const posMargin = await trackPosition({ client, st, sym, bias, score: c.analysis.score, live, ratios, inst, stopLoss, orders: { entry: entryId }, now, events });
      exPos[sym] = live;
      available -= posMargin;
      newThisCandle++;
    } catch (err) {
      events.push({ symbol: sym, type: 'error', reason: err.message });
    }
  }
}

// Funding fees: every funding payment on the bot's coins since the account
// (re)started is added to the balance (paid = negative) and tallied in
// account.funding { total, bySymbol } and on the open position. Tracking
// only; a failed lookup is retried next sync.
async function recordFunding(client, st, events, now) {
  if (!client.getFundingFees) return;
  const acc = st.account;
  if (!acc.fundingSince) acc.fundingSince = now;
  acc.funding = acc.funding || { total: 0, bySymbol: {} };
  let rows;
  try { rows = await client.getFundingFees(acc.fundingSince - 60000); acc.fundingError = null; } catch (err) {
    acc.fundingError = err.message;
    events.push({ symbol: '-', type: 'info', reason: `funding fees not read (${err.message}) — retrying next sync` });
    return;
  }
  const seen = new Set(st.seenOrderIds);
  const coins = config.ALL_SYMBOLS || config.SYMBOLS;
  for (const r of rows.sort((a, b) => a.at - b.at)) {
    const key = 'funding:' + r.id;
    if (!r.id || seen.has(key) || r.at < acc.fundingSince || !coins.includes(r.symbol) || !r.amount) continue;
    seen.add(key);
    st.seenOrderIds.push(key);
    acc.balance += r.amount;
    acc.funding.total += r.amount;
    acc.funding.bySymbol[r.symbol] = (acc.funding.bySymbol[r.symbol] || 0) + r.amount;
    const pos = st.positions[r.symbol];
    if (pos) pos.funding = (pos.funding || 0) + r.amount;
  }
}

async function runExchange({ client, st, signals, candidates, events, halt = false, now = Date.now() }) {
  const wallet = await client.getWallet();
  const exPos = await client.getPositions();
  await reconcile({ client, st, exPos, signals, events, now });
  await recordFunding(client, st, events, now);
  if (!st.pending) st.pending = {};
  await processPending({ client, st, exPos, events, now });
  await openEntries({ client, st, exPos, wallet, candidates, events, halt, now });
  st.account.exchangeEquity = wallet.equity;
}

// Emergency flatten: cancel every order and market-close every position on
// the bot's coins, tracked or not.
async function closeAll({ client, st, events, now = Date.now() }) {
  const exPos = await client.getPositions();
  for (const sym of config.ALL_SYMBOLS || config.SYMBOLS) {
    try {
      const live = exPos[sym];
      try {
        await client.cancelAll(sym);
      } catch (err) {
        // A coin with nothing open (e.g. one the exchange doesn't list) must
        // not block a close-all / reset: note it and move on.
        if (!live) { events.push({ symbol: sym, type: 'info', reason: `no orders cancelled: ${err.message}` }); continue; }
        throw err;
      }
      if (st.pending) delete st.pending[sym]; // its limit order went with cancelAll
      if (!live) continue;
      const id = await client.closeMarket({ symbol: sym, bias: live.bias, qty: live.size });
      events.push({ symbol: sym, type: 'info', reason: `closed ${live.size} at market` });
      const pos = st.positions[sym];
      if (pos) {
        pos.orders = { ...pos.orders, close: id };
        pos.closedBy = 'command';
        pos.closedDetectedAt = now;
        st.closing[sym] = pos;
        delete st.positions[sym];
      }
    } catch (err) {
      events.push({ symbol: sym, type: 'error', reason: err.message });
    }
  }
}

module.exports = { runExchange, closeAll, splitTargets, sizingBase, usedMargin, marginPerTrade, riskPerTrade };
