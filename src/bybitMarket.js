// Bybit public market data (mainnet api.bybit.com, linear USDT perps) — the
// same exported shape as src/okx.js, so the score is computed from the prices
// the bot actually trades at. Unsigned reads only: no API key is sent.
//
// loadSymbolData() falls back to OKX when Bybit fails: the candles as one set
// (never mixed between exchanges), the flow feeds one by one. The source used
// is returned as `source` ('bybit', 'okx', or 'bybit+okx' when only some flow
// feeds fell back) so the run log can show it.
'use strict';

const okx = require('./okx');

const BASE = 'https://api.bybit.com';
// Closed candles handed to analyse() — matches the backtest's LOOKBACK, plus
// the still-forming candle that analyse() drops.
const CANDLES = 401;

let fetchImpl = (...a) => fetch(...a);
function setFetch(f) { fetchImpl = f; } // tests

async function api(path, params) {
  const url = `${BASE}${path}?${new URLSearchParams({ category: 'linear', ...params })}`;
  const r = await fetchImpl(url);
  const text = await r.text();
  let d;
  try { d = JSON.parse(text); } catch (e) { throw new Error(`${path} -> HTTP ${r.status}: ${text.slice(0, 120)}`); }
  if (d.retCode !== 0) throw new Error(`${path} -> Bybit ${d.retCode}: ${d.retMsg}`);
  return d.result;
}

async function getKlines(symbol, interval, limit) {
  const res = await api('/v5/market/kline', { symbol, interval, limit: String(Math.min(limit, 1000)) });
  // newest first: [start, open, high, low, close, volume (base coin), turnover]
  const rows = res.list || [];
  if (!rows.length) throw new Error(`/v5/market/kline -> no ${interval} candles for ${symbol}`);
  return rows.slice().reverse().map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
}

async function getTicker(symbol) {
  const r = ((await api('/v5/market/tickers', { symbol })).list || [])[0];
  return r ? { fundingRate: r.fundingRate } : null;
}

async function getOpenInterest(symbol) {
  const res = await api('/v5/market/open-interest', { symbol, intervalTime: '1h', limit: '24' });
  return (res.list || []).slice().reverse().map(r => ({ openInterest: r.openInterest, timestamp: r.timestamp }));
}

async function getAccountRatio(symbol) {
  const r = ((await api('/v5/market/account-ratio', { symbol, period: '1h', limit: '1' })).list || [])[0];
  return r ? { buyRatio: r.buyRatio, sellRatio: r.sellRatio } : null;
}

async function getOrderbook(symbol) {
  const r = await api('/v5/market/orderbook', { symbol, limit: '100' });
  return r && r.b ? { b: r.b, a: r.a } : null;
}

async function getRecentTrades(symbol) {
  const res = await api('/v5/market/recent-trade', { symbol, limit: '500' });
  return (res.list || []).map(t => ({ S: t.side, v: t.size }));
}

async function loadSymbolData(symbol, mtfTfs, entryTf) {
  const tfSet = Array.from(new Set([...mtfTfs, entryTf, 'D']));
  let candles, source = 'bybit', note = null;
  try {
    candles = Object.fromEntries(await Promise.all(tfSet.map(async tf => [tf, await getKlines(symbol, tf, CANDLES)])));
  } catch (err) {
    candles = Object.fromEntries(await Promise.all(tfSet.map(async tf => [tf, await okx.getKlines(symbol, tf, CANDLES)])));
    source = 'okx';
    note = err.message;
  }
  let fellBack = false;
  const either = (a, b, empty) => a(symbol).catch(() => { fellBack = true; return b(symbol); }).catch(() => empty);
  const [ticker, oi, ratio, book, tape] = await Promise.all([
    either(getTicker, okx.getTicker, null),
    either(getOpenInterest, okx.getOpenInterest, []),
    either(getAccountRatio, okx.getAccountRatio, null),
    either(getOrderbook, okx.getOrderbook, null),
    either(getRecentTrades, okx.getRecentTrades, null),
  ]);
  if (fellBack && source === 'bybit') source = 'bybit+okx';
  return { symbol, candles, ticker, oi, ratio, book, tape, source, note };
}

module.exports = { api, getKlines, getTicker, getOpenInterest, getAccountRatio, getOrderbook, getRecentTrades, loadSymbolData, setFetch };
