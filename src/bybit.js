// Bybit v5 REST client — DEMO TRADING only. Signed private calls (wallet,
// positions, orders) plus the public instrument/ticker reads the executor
// needs. Only the practice environment below exists on purpose: pointing
// this bot at real money is a separate, deliberate change, not a setting.
//
//   demo     api-demo.bybit.com    — Demo Trading on the main exchange: real
//            mainnet prices, demo funds. Its keys are created on a normal
//            bybit.com account after switching to Demo Trading. Market data
//            (instruments, tickers) is read from the public mainnet API.
//
// Bybit blocks many cloud regions (GitHub Actions included) with a
// CloudFront geo-block, so this has to run from a machine Bybit accepts.
'use strict';

const crypto = require('crypto');

const ENVIRONMENTS = {
  demo: { base: 'https://api-demo.bybit.com', publicBase: 'https://api.bybit.com' },
};
const RECV_WINDOW = '10000';

// Codes Bybit returns for "nothing to change" — harmless, treated as success.
const NOT_MODIFIED = new Set([110043 /* leverage not modified */, 34040 /* tp/sl not modified */]);

class BybitError extends Error {
  constructor(path, retCode, retMsg) {
    super(`${path} -> Bybit ${retCode}: ${retMsg}`);
    this.retCode = retCode;
  }
}

function sign(secret, timestamp, apiKey, payload) {
  return crypto.createHmac('sha256', secret).update(timestamp + apiKey + RECV_WINDOW + payload).digest('hex');
}

function createClient({ apiKey, apiSecret, env = 'demo', fetchImpl = fetch }) {
  const endpoints = ENVIRONMENTS[env];
  if (!endpoints) throw new Error(`Unknown Bybit environment "${env}" — this build only supports demo`);
  if (!apiKey || !apiSecret) throw new Error('BYBIT_API_KEY / BYBIT_API_SECRET are not set (see .env.example)');
  const base = endpoints.base;

  async function parse(path, res) {
    const text = await res.text();
    let d;
    try { d = JSON.parse(text); } catch (e) { throw new Error(`${path} -> HTTP ${res.status}: ${text.slice(0, 200)}`); }
    if (d.retCode !== 0 && !NOT_MODIFIED.has(d.retCode)) throw new BybitError(path, d.retCode, d.retMsg);
    return d.result;
  }

  // Unsigned market-data read — never sends the API key anywhere.
  async function publicGet(path, params) {
    const url = endpoints.publicBase + path + '?' + new URLSearchParams(params).toString();
    return parse(path, await fetchImpl(url, { method: 'GET' }));
  }

  async function request(method, path, params = {}) {
    const ts = Date.now().toString();
    let url = base + path;
    let body;
    let payload;
    if (method === 'GET') {
      payload = new URLSearchParams(params).toString();
      if (payload) url += '?' + payload;
    } else {
      body = JSON.stringify(params);
      payload = body;
    }
    const res = await fetchImpl(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-BAPI-API-KEY': apiKey,
        'X-BAPI-TIMESTAMP': ts,
        'X-BAPI-RECV-WINDOW': RECV_WINDOW,
        'X-BAPI-SIGN': sign(apiSecret, ts, apiKey, payload),
      },
      body,
    });
    return parse(path, res);
  }

  const num = (x) => (x === '' || x == null ? 0 : +x);

  return {
    name: 'bybit-' + env,

    // USDT equity / available balance of the unified trading account.
    async getWallet() {
      const r = await request('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
      const acct = r.list && r.list[0];
      if (!acct) throw new Error('no UNIFIED wallet on this account');
      const usdt = (acct.coin || []).find(c => c.coin === 'USDT') || {};
      return {
        equity: num(usdt.equity || acct.totalEquity),
        available: num(acct.totalAvailableBalance),
      };
    },

    // Open linear USDT positions, keyed by symbol (one-way mode).
    async getPositions() {
      const r = await request('GET', '/v5/position/list', { category: 'linear', settleCoin: 'USDT' });
      const out = {};
      for (const p of r.list || []) {
        const size = num(p.size);
        if (!size) continue;
        out[p.symbol] = {
          symbol: p.symbol, bias: p.side === 'Buy' ? 1 : -1, size,
          avgPrice: num(p.avgPrice), stopLoss: num(p.stopLoss), markPrice: num(p.markPrice),
          unrealisedPnl: num(p.unrealisedPnl), positionIM: num(p.positionIM),
        };
      }
      return out;
    },

    async getInstrument(symbol) {
      const r = await publicGet('/v5/market/instruments-info', { category: 'linear', symbol });
      const i = r.list && r.list[0];
      if (!i) throw new Error(`${symbol} is not listed on Bybit ${env}`);
      return {
        qtyStep: num(i.lotSizeFilter.qtyStep),
        minOrderQty: num(i.lotSizeFilter.minOrderQty),
        minNotional: num(i.lotSizeFilter.minNotionalValue),
        tickSize: num(i.priceFilter.tickSize),
      };
    },

    async getMarkPrice(symbol) {
      const r = await publicGet('/v5/market/tickers', { category: 'linear', symbol });
      const t = r.list && r.list[0];
      if (!t) throw new Error(`no ticker for ${symbol}`);
      return num(t.markPrice);
    },

    async setLeverage(symbol, leverage) {
      await request('POST', '/v5/position/set-leverage', {
        category: 'linear', symbol, buyLeverage: String(leverage), sellLeverage: String(leverage),
      });
    },

    // Market entry with the stop attached to the position in the same call,
    // so the position is never open on the exchange without a stop.
    async openMarket({ symbol, bias, qty, stopLoss }) {
      const r = await request('POST', '/v5/order/create', {
        category: 'linear', symbol, side: bias === 1 ? 'Buy' : 'Sell', orderType: 'Market',
        qty: String(qty), positionIdx: 0, tpslMode: 'Full', stopLoss: String(stopLoss), slTriggerBy: 'MarkPrice',
      });
      return r.orderId;
    },

    // Reduce-only resting limit order — one per take-profit target.
    async placeTakeProfit({ symbol, bias, qty, price }) {
      const r = await request('POST', '/v5/order/create', {
        category: 'linear', symbol, side: bias === 1 ? 'Sell' : 'Buy', orderType: 'Limit',
        qty: String(qty), price: String(price), reduceOnly: true, timeInForce: 'GTC', positionIdx: 0,
      });
      return r.orderId;
    },

    async setStopLoss(symbol, stopLoss) {
      await request('POST', '/v5/position/trading-stop', {
        category: 'linear', symbol, positionIdx: 0, tpslMode: 'Full', stopLoss: String(stopLoss), slTriggerBy: 'MarkPrice',
      });
    },

    async closeMarket({ symbol, bias, qty }) {
      const r = await request('POST', '/v5/order/create', {
        category: 'linear', symbol, side: bias === 1 ? 'Sell' : 'Buy', orderType: 'Market',
        qty: String(qty), reduceOnly: true, positionIdx: 0,
      });
      return r.orderId;
    },

    async cancelAll(symbol) {
      await request('POST', '/v5/order/cancel-all', { category: 'linear', symbol });
    },

    // Realized P&L records (net of fees) for closes since startTime (ms).
    async getClosedPnl(symbol, startTime) {
      const r = await request('GET', '/v5/position/closed-pnl', { category: 'linear', symbol, startTime: String(startTime), limit: '100' });
      return (r.list || []).map(x => ({
        orderId: x.orderId, qty: num(x.closedSize), exit: num(x.avgExitPrice),
        pnl: num(x.closedPnl), at: num(x.updatedTime),
      }));
    },
  };
}

module.exports = { createClient, sign, ENVIRONMENTS, BybitError };
