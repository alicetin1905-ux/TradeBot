#!/usr/bin/env node
// Backtest: replays the bot's rules hour by hour on months of OKX 1H candles
// and compares variants of the rules side by side.
//
//   node scripts/backtest.js                 last 120 days, all variants
//   node scripts/backtest.js --days 60
//
// Approximation: history has only candles, so the score is built from the
// price/volume signals (trend, momentum, structure, volume/OBV/money flow).
// The live-only order-flow signals (funding, open interest, long/short
// ratio, order book, taker tape — ~20% of the score's weight) are missing.
// Entries fill at the close of the signal candle (the live bot enters a few
// minutes later at market), exits are replayed on later candles with the
// stop checked first when a candle touches both (worst case), and Bybit
// fees are charged (0.055% taker on entry/stops/market closes, 0.02% maker
// on target fills). Qty rounding to lot sizes is ignored.
//
// Output: a table on stdout and backtest/results.json + backtest/REPORT.md.
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const atlasScore = require('../src/atlasScore');
const strategy = require('../src/strategy');
const { sizeFor } = require('../src/risk');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, 'backtest', 'cache');
const OUT = path.join(ROOT, 'backtest');
const HOUR = 3600000;
const LOOKBACK = 400;            // closed candles handed to analyse() each hour
const FEES = { taker: 0.00055, maker: 0.0002 };

const args = process.argv.slice(2);
const DAYS = +(args[args.indexOf('--days') + 1] || 0) || 120;

/* ---------------- data ---------------- */

async function fetchHistory(symbol, fromMs) {
  const file = path.join(CACHE, `${symbol}-1H.json`);
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* no cache yet */ }
  const have = new Set(rows.map(r => r.t));
  const instId = symbol.replace('USDT', '') + '-USDT-SWAP';
  // newest first, paging backwards with `after`
  let after = '';
  for (let page = 0; page < 200; page++) {
    const url = `https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=1H&limit=100${after ? '&after=' + after : ''}`;
    const d = await (await fetch(url)).json();
    if (d.code !== '0') throw new Error(`${symbol}: ${d.msg}`);
    if (!d.data.length) break;
    let fresh = 0;
    for (const k of d.data) {
      const t = +k[0];
      if (k[8] !== '1') continue; // unconfirmed (still forming) candle
      if (!have.has(t)) { rows.push({ t, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6] }); have.add(t); fresh++; }
    }
    after = d.data[d.data.length - 1][0];
    if (+after <= fromMs) break;
    if (!fresh && rows.length && Math.min(...rows.map(r => r.t)) <= fromMs) break;
    await new Promise(r => setTimeout(r, 120)); // stay under OKX's rate limit
  }
  rows.sort((a, b) => a.t - b.t);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rows));
  return rows;
}

/* ---------------- per-hour signals (shared by all variants) ---------------- */

// Everything that doesn't depend on the account: score, bias, entry gates and
// the refined levels (as ratios of the plan entry, the way the live bot
// carries them over to its fill price).
function precompute(symbol, candles, startIdx) {
  const flipStore = {};
  const out = new Array(candles.length).fill(null);
  for (let i = Math.max(startIdx, 221); i < candles.length - 1; i++) {
    const closed = candles.slice(Math.max(0, i - LOOKBACK + 1), i + 1);
    const withForming = closed.concat([candles[i + 1]]); // analyse() drops the last (forming) bar
    const analysis = atlasScore.analyse({
      symbol, candles: { [config.ENTRY_TF]: withForming }, ticker: null, oi: [], ratio: null, book: null, tape: null,
      entryTf: config.ENTRY_TF, mtfTfs: [], flipStore, account: 1000, riskPct: 10, leverage: 10,
      scoreThreshold: config.SCORE_THRESHOLD,
    });
    if (!analysis) continue;
    const rec = { t: candles[i].t, close: candles[i].c, score: analysis.score, bias: analysis.bias };
    if (analysis.bias !== 0 && analysis.plan) {
      const data = { candles: { [config.ENTRY_TF]: withForming } };
      const gate = strategy.entryFilters({ symbol, data, analysis });
      // Two independent flags so variants can switch the Fibonacci check off.
      const fibOk = gate.code !== 'fib';
      const chaseOk = Math.abs(analysis.price - analysis.plan.entry) <= config.MAX_CHASE_ATR * analysis.atr;
      const plan = sizeFor({ symbol, equity: 1000, bias: analysis.bias, entry: analysis.plan.entry, stop: analysis.plan.stop, leverage: 10, marginPct: 10 });
      const opened = strategy.openEntry({ symbol, data, analysis, plan, fibCheck: gate.fibCheck || { impulse: null } });
      if (opened.position) {
        const p = opened.position, e = p.entry;
        rec.gate = { fib: fibOk, chase: chaseOk };
        rec.ratio = { stop: p.stop / e, t1: p.t1 / e, t2: p.t2 / e, t3: p.t3 / e };
      }
    }
    out[i] = rec;
  }
  return out;
}

/* ---------------- portfolio simulation ---------------- */

const BASE_RULES = {
  margin: 200, leverage: 10, maxOpen: 5, maxSameDir: 3, minScore: 50,
  useFib: true, breakevenAfter: 't1', lockT1AfterT2: false, riskUsd: null, btcFilter: false, fees: true,
};

function simulate(series, symbols, times, rules) {
  const R = { ...BASE_RULES, ...rules };
  const split = config.TARGET_SPLIT;
  const FEE_TAKER = R.fees ? FEES.taker : 0, FEE_MAKER = R.fees ? FEES.maker : 0;
  let balance = 1000, peak = 1000, maxDD = 0;
  const open = {};
  const used = {};           // one trade per signal: symbol -> { bias, reset }
  const trades = [];
  const idx = Object.fromEntries(symbols.map(s => [s, new Map(series[s].candles.map((c, i) => [c.t, i]))]));

  const usedMargin = () => Object.values(open).reduce((s, p) => s + p.margin * (p.qtyRemaining / p.qty), 0);

  function closeFill(p, qty, price, reason, fee, t) {
    const pnl = (price - p.entry) * p.bias * qty - price * qty * fee;
    p.pnl += pnl; balance += pnl; p.qtyRemaining -= qty;
    p.exits.push(reason);
    if (p.qtyRemaining <= p.qty * 1e-9) {
      trades.push({ symbol: p.symbol, bias: p.bias, score: p.score, openedAt: p.openedAt, closedAt: t, pnl: p.pnl, exit: reason, path: p.exits.join(' > ') });
      delete open[p.symbol];
    }
  }

  for (const t of times) {
    // 1) exits on the candle that just closed at time t
    for (const p of Object.values(open)) {
      const i = idx[p.symbol].get(t);
      if (i == null || t <= p.openedAt) continue;
      const c = series[p.symbol].candles[i];
      const hitStop = p.bias === 1 ? c.l <= p.stop : c.h >= p.stop;
      if (hitStop) { closeFill(p, p.qtyRemaining, p.stop, p.breakeven ? 'breakeven stop' : (p.lockedT1 ? 'T1-lock stop' : 'stop'), FEE_TAKER, t); continue; }
      for (const k of ['t1', 't2', 't3']) {
        if (p.filled[k]) continue;
        if (!(p.bias === 1 ? c.h >= p[k] : c.l <= p[k])) break;
        const q = k === 't3' ? p.qtyRemaining : p.qty * split[{ t1: 0, t2: 1 }[k]];
        p.filled[k] = true;
        closeFill(p, q, p[k], k.toUpperCase(), FEE_MAKER, t);
        if (!open[p.symbol]) break;
        if (k === R.breakevenAfter) { p.stop = p.entry; p.breakeven = true; }
        if (k === 't2' && R.lockT1AfterT2) { p.stop = p.t1; p.lockedT1 = true; p.breakeven = false; }
      }
      if (!open[p.symbol]) continue;
      const sig = series[p.symbol].sig[i];
      if (sig && sig.bias !== 0 && sig.bias !== p.bias) closeFill(p, p.qtyRemaining, c.c, 'signal flip', FEE_TAKER, t);
    }

    // 2) one-trade-per-signal memory
    for (const s of symbols) {
      const i = idx[s].get(t), sig = i != null && series[s].sig[i];
      const m = used[s];
      if (sig && m && sig.bias !== m.bias) m.reset = true;
      if (m && m.reset && !open[s]) delete used[s];
    }

    // 3) entries, strongest |score| first
    const btcI = idx.BTCUSDT && idx.BTCUSDT.get(t);
    const btcBias = btcI != null && series.BTCUSDT.sig[btcI] ? series.BTCUSDT.sig[btcI].bias : 0;
    const cands = [];
    for (const s of symbols) {
      if (open[s]) continue;
      const i = idx[s].get(t), sig = i != null && series[s].sig[i];
      if (!sig || sig.bias === 0 || !sig.ratio || Math.abs(sig.score) < R.minScore) continue;
      if (used[s] && !used[s].reset && used[s].bias === sig.bias) continue;
      if (!sig.gate.chase || (R.useFib && !sig.gate.fib)) continue;
      if (R.btcFilter && s !== 'BTCUSDT' && btcBias === -sig.bias) continue;
      cands.push({ s, sig });
    }
    cands.sort((a, b) => Math.abs(b.sig.score) - Math.abs(a.sig.score));
    for (const { s, sig } of cands) {
      if (Object.keys(open).length >= R.maxOpen) break;
      if (Object.values(open).filter(p => p.bias === sig.bias).length >= R.maxSameDir) continue;
      const entry = sig.close;
      const stop = entry * sig.ratio.stop;
      let notional = R.margin * R.leverage;
      if (R.riskUsd) notional = Math.min(R.riskUsd / Math.abs(1 - sig.ratio.stop), R.margin * R.leverage);
      const margin = notional / R.leverage;
      if (balance - usedMargin() < margin * 0.99) continue; // full-size trades only
      const qty = notional / entry;
      balance -= notional * FEE_TAKER;
      open[s] = {
        symbol: s, bias: sig.bias, score: sig.score, entry, stop, t1: entry * sig.ratio.t1, t2: entry * sig.ratio.t2, t3: entry * sig.ratio.t3,
        qty, qtyRemaining: qty, margin, pnl: -notional * FEE_TAKER, filled: {}, breakeven: false, openedAt: t, exits: [],
      };
      used[s] = { bias: sig.bias, reset: false };
    }

    // equity curve on realized + open P&L at close
    let eq = balance;
    for (const p of Object.values(open)) {
      const i = idx[p.symbol].get(t);
      if (i != null) eq += (series[p.symbol].candles[i].c - p.entry) * p.bias * p.qtyRemaining;
    }
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, (peak - eq) / peak);
  }

  const wins = trades.filter(x => x.pnl > 0), losses = trades.filter(x => x.pnl <= 0);
  const gw = wins.reduce((a, x) => a + x.pnl, 0), gl = -losses.reduce((a, x) => a + x.pnl, 0);
  const byExit = {};
  for (const x of trades) { byExit[x.exit] = byExit[x.exit] || { n: 0, pnl: 0 }; byExit[x.exit].n++; byExit[x.exit].pnl += x.pnl; }
  const bySymbol = {};
  for (const x of trades) { const k = x.symbol.replace('USDT', ''); bySymbol[k] = bySymbol[k] || { n: 0, pnl: 0, wins: 0 }; bySymbol[k].n++; bySymbol[k].pnl += x.pnl; if (x.pnl > 0) bySymbol[k].wins++; }
  return {
    trades: trades.length, winRate: trades.length ? wins.length / trades.length : 0,
    net: balance - 1000, returnPct: (balance / 1000 - 1) * 100, maxDDPct: maxDD * 100,
    profitFactor: gl ? gw / gl : null, avgWin: wins.length ? gw / wins.length : 0, avgLoss: losses.length ? -gl / losses.length : 0,
    stillOpen: Object.keys(open).length, byExit, bySymbol,
  };
}

/* ---------------- variants ---------------- */

const VARIANTS = [
  { key: 'live', name: 'Live rules now', rules: {} },
  { key: 'nofees', name: 'Live rules, if trading were free', rules: { fees: false } },
  { key: 'be_t2', name: 'Breakeven after T2 (not T1)', rules: { breakevenAfter: 't2' } },
  { key: 'lock', name: 'BE after T1, stop to T1 after T2', rules: { lockT1AfterT2: true } },
  { key: 'nofib', name: 'No Fibonacci check', rules: { useFib: false } },
  { key: 'score25', name: 'Entry score 25 (old)', rules: { minScore: 25 } },
  { key: 'score65', name: 'Entry score 65', rules: { minScore: 65 } },
  { key: 'risk25', name: 'Size by risk: $25 per full stop', rules: { riskUsd: 25 } },
  { key: 'btc', name: 'BTC direction filter for alts', rules: { btcFilter: true } },
  { key: 'm100x8', name: '$100 margin, 8 slots, no direction cap', rules: { margin: 100, maxOpen: 8, maxSameDir: 99 } },
];

async function main() {
  const symbols = config.SYMBOLS;
  const now = Date.now();
  const from = now - (DAYS * 24 + LOOKBACK + 24) * HOUR;
  const series = {};
  for (const s of symbols) {
    process.stderr.write(`fetching ${s}… `);
    const candles = (await fetchHistory(s, from)).filter(c => c.t >= from);
    process.stderr.write(`${candles.length} candles\n`);
    series[s] = { candles };
  }
  const start = now - DAYS * 24 * HOUR;
  for (const s of symbols) {
    process.stderr.write(`scoring ${s}…\n`);
    const c = series[s].candles;
    const startIdx = Math.max(0, c.findIndex(x => x.t >= start) - 1);
    series[s].sig = precompute(s, c, startIdx);
  }
  const times = [...new Set(symbols.flatMap(s => series[s].candles.map(c => c.t)))].filter(t => t >= start).sort((a, b) => a - b);

  const results = VARIANTS.map(v => ({ ...v, ...simulate(series, symbols, times, v.rules) }));
  const period = `${new Date(times[0]).toISOString().slice(0, 10)} → ${new Date(times[times.length - 1]).toISOString().slice(0, 10)}`;

  const pad = (x, n) => String(x).padStart(n);
  console.log(`\nBacktest ${period} (${DAYS} days, ${symbols.length} coins, start 1000 USDT)\n`);
  console.log('variant'.padEnd(40) + pad('trades', 7) + pad('win%', 6) + pad('net $', 9) + pad('ret%', 7) + pad('maxDD%', 8) + pad('PF', 6) + pad('avgW', 7) + pad('avgL', 8));
  for (const r of results) {
    console.log(r.name.padEnd(40) + pad(r.trades, 7) + pad((r.winRate * 100).toFixed(0), 6) + pad(r.net.toFixed(0), 9) + pad(r.returnPct.toFixed(1), 7) +
      pad(r.maxDDPct.toFixed(1), 8) + pad(r.profitFactor == null ? '—' : r.profitFactor.toFixed(2), 6) + pad(r.avgWin.toFixed(1), 7) + pad(r.avgLoss.toFixed(1), 8));
  }

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ period, days: DAYS, generatedAt: new Date().toISOString(), results }, null, 2) + '\n');
  const md = [
    `# Backtest ${period}`, '',
    `${DAYS} days · ${symbols.length} coins · start 1000 USDT · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, '',
    'Approximation: price/volume signals only (no funding, OI, long/short, book, tape), fills at candle close, stop checked first when a candle touches stop and target, Bybit fees included.', '',
    '| Variant | Trades | Win % | Net $ | Return % | Max DD % | Profit factor | Avg win | Avg loss |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...results.map(r => `| ${r.name} | ${r.trades} | ${(r.winRate * 100).toFixed(0)} | ${r.net.toFixed(0)} | ${r.returnPct.toFixed(1)} | ${r.maxDDPct.toFixed(1)} | ${r.profitFactor == null ? '—' : r.profitFactor.toFixed(2)} | ${r.avgWin.toFixed(1)} | ${r.avgLoss.toFixed(1)} |`),
    '', '## Live rules — per coin', '', '| Coin | Trades | Win % | Net $ |', '|---|---:|---:|---:|',
    ...Object.entries(results[0].bySymbol).sort((a, b) => b[1].pnl - a[1].pnl).map(([k, v]) => `| ${k} | ${v.n} | ${Math.round(v.wins / v.n * 100)} | ${v.pnl.toFixed(0)} |`),
    '', '## Live rules — by final exit', '', '| Exit | Trades | Net $ |', '|---|---:|---:|',
    ...Object.entries(results[0].byExit).map(([k, v]) => `| ${k} | ${v.n} | ${v.pnl.toFixed(0)} |`), '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), md);
  process.stderr.write(`\nwrote backtest/results.json and backtest/REPORT.md\n`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { simulate, precompute, BASE_RULES };
