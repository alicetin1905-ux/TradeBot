#!/usr/bin/env node
// Backtest: replays the bot's rules on months of OKX history and compares
// variants side by side.
//
//   node scripts/backtest.js                 last 120 days, all variants
//   node scripts/backtest.js --days 60
//
// Signals come from 1H candles (as live) or from 4H candles built out of
// the 1H history (UTC-aligned). Stops and targets are always replayed on
// 1H candles, stop checked first when a candle touches both (worst case).
// Entries fill at market at the signal candle's close (taker fee), or — for
// limit variants — at a limit placed a fraction of ATR better, which fills
// only if price trades there within a few hours (maker fee; otherwise the
// trade is skipped). Target fills pay maker, stops and market closes taker.
//
// Approximation: history has only candles, so the score uses the price and
// volume signals; the live-only order-flow inputs (funding, open interest,
// long/short ratio, order book, taker tape — ~20% of the score's weight)
// are missing. Lot-size rounding is ignored.
//
// Output: a table on stdout and backtest/results.json + backtest/REPORT.md.
'use strict';

const fs = require('fs');
const path = require('path');
// Reproducible: config.js defaults, not the live control/settings.json.
process.env.TRADEBOT_SETTINGS = 'off';
const config = require('../config');
// Variants set their own targets (targetsR); the live TARGETS_R must not
// leak into the strategy's base levels here.
config.TARGETS_R = null;
const atlasScore = require('../src/atlasScore');
const strategy = require('../src/strategy');
const { sizeFor } = require('../src/risk');
const liquidity = require('../src/liquidity');
const I = require('../src/indicators');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, 'backtest', 'cache');
const OUT = path.join(ROOT, 'backtest');
const HOUR = 3600000;
const LOOKBACK = 400;            // closed candles handed to analyse() per step
const FEES = { taker: 0.00055, maker: 0.0002 };

const args = process.argv.slice(2);
const DAYS = +(args[args.indexOf('--days') + 1] || 0) || 120;
// --end-days N: end the window N days ago (an earlier, out-of-sample period);
// such runs only print the table and leave REPORT.md / results.json alone.
const END_AGO = args.includes('--end-days') ? +args[args.indexOf('--end-days') + 1] || 0 : 0;

/* ---------------- data ---------------- */

async function fetchHistory(symbol, fromMs) {
  const file = path.join(CACHE, `${symbol}-1H.json`);
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* no cache yet */ }
  const have = new Set(rows.map(r => r.t));
  const oldest = () => (rows.length ? rows.reduce((m, r) => Math.min(m, r.t), Infinity) : Infinity);
  const instId = symbol.replace('USDT', '') + '-USDT-SWAP';
  // Newest first, paging back with `after`; once a page adds nothing new,
  // jump straight past what the cache already holds.
  let after = '';
  for (let page = 0; page < 400; page++) {
    const url = `https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=1H&limit=100${after ? '&after=' + after : ''}`;
    const d = await (await fetch(url)).json();
    if (d.code !== '0') throw new Error(`${symbol}: ${d.msg}`);
    if (!d.data.length) break;
    let fresh = 0;
    for (const k of d.data) {
      const t = +k[0];
      if (k[8] !== '1') continue; // still-forming candle
      if (!have.has(t)) { rows.push({ t, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6] }); have.add(t); fresh++; }
    }
    after = d.data[d.data.length - 1][0];
    if (+after <= fromMs) break;
    if (!fresh) {
      if (oldest() <= fromMs) break;
      after = String(oldest());
    }
    await new Promise(r => setTimeout(r, 120)); // stay under OKX's rate limit
  }
  rows.sort((a, b) => a.t - b.t);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rows));
  return rows;
}

// UTC-aligned 4H candles from 1H candles; incomplete buckets are dropped.
function to4h(h1) {
  const out = [];
  for (let i = 0; i + 3 < h1.length; i++) {
    const c = h1[i];
    if (c.t % (4 * HOUR) !== 0 || h1[i + 3].t !== c.t + 3 * HOUR) continue;
    const g = h1.slice(i, i + 4);
    out.push({ t: c.t, o: g[0].o, h: Math.max(...g.map(x => x.h)), l: Math.min(...g.map(x => x.l)), c: g[3].c, v: g.reduce((a, x) => a + x.v, 0) });
  }
  return out;
}

/* ---------------- signals (shared by all variants) ---------------- */

// Per closed signal candle: score, bias, entry gates, ATR and the refined
// stop/targets as ratios of the plan entry (the live bot carries its levels
// over to its fill price the same way). Keyed by the 1H time at which the
// signal becomes actionable: the open time of the last 1H candle inside the
// signal candle (for 1H signals, the candle itself).
function precompute(symbol, candles, tfHours, fromMs) {
  const flipStore = {};
  const out = new Map();
  for (let i = 221; i < candles.length - 1; i++) {
    const closed = candles.slice(Math.max(0, i - LOOKBACK + 1), i + 1);
    const withForming = closed.concat([candles[i + 1]]); // analyse() drops the last (forming) bar
    const analysis = atlasScore.analyse({
      symbol, candles: { [config.ENTRY_TF]: withForming }, ticker: null, oi: [], ratio: null, book: null, tape: null,
      entryTf: config.ENTRY_TF, mtfTfs: [], flipStore, account: 1000, riskPct: 10, leverage: 10,
      scoreThreshold: config.SCORE_THRESHOLD,
    });
    if (!analysis) continue;
    const at = candles[i].t + (tfHours - 1) * HOUR;
    if (at < fromMs) continue;
    const rec = { t: at, close: candles[i].c, score: analysis.score, bias: analysis.bias, atr: analysis.atr };
    if (analysis.bias !== 0 && analysis.plan) {
      const data = { candles: { [config.ENTRY_TF]: withForming } };
      const gate = strategy.entryFilters({ symbol, data, analysis });
      const plan = sizeFor({ symbol, equity: 1000, bias: analysis.bias, entry: analysis.plan.entry, stop: analysis.plan.stop, leverage: 10, marginPct: 10 });
      const opened = strategy.openEntry({ symbol, data, analysis, plan, fibCheck: gate.fibCheck || { impulse: null } });
      if (opened.position) {
        const p = opened.position, e = p.entry;
        rec.gate = {
          fib: gate.code !== 'fib',
          chase: Math.abs(analysis.price - analysis.plan.entry) <= config.MAX_CHASE_ATR * analysis.atr,
        };
        rec.ratio = { stop: p.stop / e, t1: p.t1 / e, t2: p.t2 / e, t3: p.t3 / e };
        rec.liq = heaviestClusters(closed, e);
      }
    }
    out.set(at, rec);
  }
  return out;
}

// Estimated liquidation clusters (the Liq page / CRUCIBLE model): the
// heaviest one within 10% above and below price, as ratios of the entry.
function heaviestClusters(closed, entry) {
  const { clusters } = liquidity.estimateClusters(closed, config.LEV_TIERS, config.LIQ_MMR);
  const price = closed[closed.length - 1].c;
  const best = (side) => clusters
    .filter(c => (side > 0 ? c.price > price : c.price < price) && Math.abs(c.price / price - 1) <= 0.10)
    .sort((a, b) => b.weight - a.weight)[0];
  const up = best(1), down = best(-1);
  return { up: up ? up.price / entry : null, down: down ? down.price / entry : null };
}

// Inputs for the 1H entry filters: the signal candle's volume vs its 20-candle
// average, the 1H Supertrend (10/3) direction, and the direction of the
// Supertrend on the last CLOSED 4H candle at that moment.
function addFilterInputs(ser) {
  const h1 = ser.h1, st1 = I.supertrend(h1, 10, 3).dir;
  const h4 = to4h(h1), st4 = I.supertrend(h4, 10, 3).dir;
  const idx = new Map(h1.map((c, i) => [c.t, i]));
  let j = -1;
  const st4At = (closeT) => { // last 4H candle closed at or before closeT
    while (j + 1 < h4.length && h4[j + 1].t + 4 * HOUR <= closeT) j++;
    return j >= 0 ? st4[j] : null;
  };
  for (const [t, rec] of [...ser.sig1.entries()].sort((a, b) => a[0] - b[0])) {
    const i = idx.get(t);
    if (i == null || i < 20) continue;
    const avg = h1.slice(i - 20, i).reduce((a, c) => a + c.v, 0) / 20;
    rec.vr = avg > 0 ? h1[i].v / avg : null;
    rec.st1 = st1[i];
    rec.st4 = st4At(t + HOUR);
  }
  // 4H signals: same inputs on the 4H candle itself (st1 = its own Supertrend).
  const idx4 = new Map(h4.map((c, i) => [c.t + 3 * HOUR, i])); // keyed like sig4 (actionable 1H time)
  for (const [t, rec] of ser.sig4.entries()) {
    const i = idx4.get(t);
    if (i == null || i < 20) continue;
    const avg = h4.slice(i - 20, i).reduce((a, c) => a + c.v, 0) / 20;
    rec.vr = avg > 0 ? h4[i].v / avg : null;
    rec.st1 = rec.st4 = st4[i];
  }
}

/* ---------------- portfolio simulation ---------------- */

const BASE_RULES = {
  tf: '1H', margin: 200, leverage: 10, maxOpen: 5, maxSameDir: 3, minScore: 50,
  useFib: true, breakevenAfter: 't1', lockT1AfterT2: false, riskUsd: null, btcFilter: false, fees: true,
  targetsR: null,          // e.g. [1.5, 3, 4.5]: targets at these multiples of the stop distance (null = live levels)
  limit: null,             // e.g. { atr: 0.25, hours: 3 }: limit entry this much better, valid this many hours
  liqTargets: null,        // ['t2'] / ['t3'] / ['t2','t3']: those targets just before the heaviest estimated liq cluster
  split: [0.40, 0.35, 0.25], // share closed at T1 / T2 / T3
  liqFilter: false,
  volMin: null,            // 1H filters: signal-candle volume at least this x its 20-candle average
  st1Agree: false,         //   1H Supertrend must point the trade's way
  st4Agree: false,         //   4H Supertrend (last closed 4H candle) must point the trade's way        // skip trades whose heaviest liq cluster against them is nearer than the one for them
};

function simulate(series, symbols, times, rules) {
  const R = { ...BASE_RULES, ...rules };
  const split = R.split || [0.40, 0.35, 0.25];
  const FEE_TAKER = R.fees ? FEES.taker : 0, FEE_MAKER = R.fees ? FEES.maker : 0;
  const sigKey = R.tf === '4H' ? 'sig4' : 'sig1';
  let balance = 1000, peak = 1000, maxDD = 0;
  const open = {};      // symbol -> position
  const pending = {};   // symbol -> resting limit entry
  const used = {};      // one trade per signal: symbol -> { bias, reset }
  const trades = [];
  let missedLimits = 0;
  const h1idx = Object.fromEntries(symbols.map(s => [s, new Map(series[s].h1.map((c, i) => [c.t, i]))]));

  const usedMargin = () => Object.values(open).reduce((s, p) => s + p.margin * (p.qtyRemaining / p.qty), 0)
    + Object.values(pending).reduce((s, o) => s + o.margin, 0);

  function closeFill(p, qty, price, reason, fee, t) {
    const pnl = (price - p.entry) * p.bias * qty - price * qty * fee;
    p.pnl += pnl; balance += pnl; p.qtyRemaining -= qty;
    p.exits.push(reason);
    if (p.qtyRemaining <= p.qty * 1e-9) {
      trades.push({ symbol: p.symbol, bias: p.bias, score: p.score, openedAt: p.openedAt, closedAt: t, pnl: p.pnl, exit: reason, path: p.exits.join(' > ') });
      delete open[p.symbol];
    }
  }

  // Replays one 1H candle against an open position's stop and targets.
  function manage(p, c, t) {
    if (p.bias === 1 ? c.l <= p.stop : c.h >= p.stop) {
      closeFill(p, p.qtyRemaining, p.stop, p.breakeven ? 'breakeven stop' : (p.lockedT1 ? 'T1-lock stop' : 'stop'), FEE_TAKER, t);
      return;
    }
    for (const k of ['t1', 't2', 't3']) {
      if (p.filled[k]) continue;
      if (!(p.bias === 1 ? c.h >= p[k] : c.l <= p[k])) break;
      const q = k === 't3' ? p.qtyRemaining : p.qty * split[k === 't1' ? 0 : 1];
      p.filled[k] = true;
      closeFill(p, q, p[k], k.toUpperCase(), FEE_MAKER, t);
      if (!open[p.symbol]) return;
      if (k === R.breakevenAfter) { p.stop = p.entry; p.breakeven = true; }
      if (k === 't2' && R.lockT1AfterT2) { p.stop = p.t1; p.lockedT1 = true; p.breakeven = false; }
    }
  }

  function levels(entry, sig) {
    if (!R.targetsR) return { stop: entry * sig.ratio.stop, t1: entry * sig.ratio.t1, t2: entry * sig.ratio.t2, t3: entry * sig.ratio.t3 };
    const dist = Math.abs(1 - sig.ratio.stop);
    const at = (m) => entry * (1 + sig.bias * dist * m);
    const lv = { stop: entry * sig.ratio.stop, t1: at(R.targetsR[0]), t2: at(R.targetsR[1]), t3: at(R.targetsR[2]) };
    // Liq targets: put T2 and/or T3 just (0.2%) before the heaviest estimated
    // liquidation cluster on the target side, when it's in a sensible range.
    const c = sig.liq && (sig.bias === 1 ? sig.liq.up : sig.liq.down);
    if (R.liqTargets && c) {
      const rC = ((c - 1) * sig.bias) / dist;                  // cluster distance in R
      const before = entry * (c - sig.bias * 0.002);
      if (R.liqTargets.includes('t2') && rC > R.targetsR[0] + 0.25 && rC < R.targetsR[2]) lv.t2 = before;
      if (R.liqTargets.includes('t3') && rC > R.targetsR[1] + 0.25 && rC <= 8) lv.t3 = before;
      if ((lv.t3 - lv.t2) * sig.bias <= 0) lv.t2 = at(R.targetsR[1]); // keep T2 short of T3
    }
    return lv;
  }

  function openPosition(s, sig, entry, t, feeRate, margin) {
    const lv = levels(entry, sig);
    const notional = margin * R.leverage, qty = notional / entry;
    balance -= notional * feeRate;
    open[s] = {
      symbol: s, bias: sig.bias, score: sig.score, entry, ...lv, qty, qtyRemaining: qty, margin,
      pnl: -notional * feeRate, filled: {}, breakeven: false, openedAt: t, exits: [],
    };
  }

  for (const t of times) {
    // 1) resting limit entries: fill if this candle trades through the limit
    for (const [s, o] of Object.entries(pending)) {
      const i = h1idx[s].get(t);
      if (i == null) continue;
      const c = series[s].h1[i];
      if (o.sig.bias === 1 ? c.l <= o.price : c.h >= o.price) {
        delete pending[s];
        openPosition(s, o.sig, o.price, t, FEE_MAKER, o.margin);
        manage(open[s], c, t); // worst case: stop/targets can already hit in the fill candle
      } else if (t >= o.expires) { delete pending[s]; missedLimits++; }
    }

    // 2) exits for positions opened before this candle
    for (const p of Object.values(open)) {
      const i = h1idx[p.symbol].get(t);
      if (i == null || t <= p.openedAt) continue;
      manage(p, series[p.symbol].h1[i], t);
      if (!open[p.symbol]) continue;
      const sig = series[p.symbol][sigKey].get(t);
      if (sig && sig.bias !== 0 && sig.bias !== p.bias) closeFill(p, p.qtyRemaining, series[p.symbol].h1[i].c, 'signal flip', FEE_TAKER, t);
    }

    // 3) one-trade-per-signal memory (only on candles that carry a signal)
    for (const s of symbols) {
      const sig = series[s][sigKey].get(t), m = used[s];
      if (sig && m && sig.bias !== m.bias) m.reset = true;
      if (m && m.reset && !open[s] && !pending[s]) delete used[s];
    }

    // 4) new entries, strongest |score| first
    const btc = series.BTCUSDT && series.BTCUSDT[sigKey].get(t);
    const cands = [];
    for (const s of symbols) {
      if (open[s] || pending[s]) continue;
      const sig = series[s][sigKey].get(t);
      if (!sig || sig.bias === 0 || !sig.ratio || Math.abs(sig.score) < R.minScore) continue;
      if (used[s] && !used[s].reset && used[s].bias === sig.bias) continue;
      if (!sig.gate.chase || (R.useFib && !sig.gate.fib)) continue;
      if (R.volMin && !(sig.vr >= R.volMin)) continue;
      if (R.st1Agree && sig.st1 !== sig.bias) continue;
      if (R.st4Agree && sig.st4 !== sig.bias) continue;
      if (R.liqFilter && sig.liq) {
        // Skip when the heaviest cluster against the trade is closer than the one in its favour.
        const up = sig.liq.up ? sig.liq.up - 1 : Infinity, down = sig.liq.down ? 1 - sig.liq.down : Infinity;
        if ((sig.bias === 1 ? down < up : up < down)) continue;
      }
      if (R.btcFilter && s !== 'BTCUSDT' && btc && btc.bias === -sig.bias) continue;
      cands.push({ s, sig });
    }
    cands.sort((a, b) => Math.abs(b.sig.score) - Math.abs(a.sig.score));
    for (const { s, sig } of cands) {
      const busy = [...Object.values(open), ...Object.values(pending).map(o => o.sig)];
      if (busy.length >= R.maxOpen) break;
      if (busy.filter(p => p.bias === sig.bias).length >= R.maxSameDir) continue;
      let margin = R.margin;
      if (R.riskUsd) margin = Math.min(R.riskUsd / Math.abs(1 - sig.ratio.stop), R.margin * R.leverage) / R.leverage;
      if (balance - usedMargin() < margin * 0.99) continue; // full-size trades only
      used[s] = { bias: sig.bias, reset: false };
      if (R.limit) {
        pending[s] = { sig, margin, price: sig.close - sig.bias * R.limit.atr * sig.atr, expires: t + R.limit.hours * HOUR };
      } else {
        openPosition(s, sig, sig.close, t, FEE_TAKER, margin);
      }
    }

    // equity: realized + open P&L at this candle's close
    let eq = balance;
    for (const p of Object.values(open)) {
      const i = h1idx[p.symbol].get(t);
      if (i != null) eq += (series[p.symbol].h1[i].c - p.entry) * p.bias * p.qtyRemaining;
    }
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, (peak - eq) / peak);
  }

  const wins = trades.filter(x => x.pnl > 0), losses = trades.filter(x => x.pnl <= 0);
  const gw = wins.reduce((a, x) => a + x.pnl, 0), gl = -losses.reduce((a, x) => a + x.pnl, 0);
  const byExit = {}, bySymbol = {};
  for (const x of trades) {
    byExit[x.exit] = byExit[x.exit] || { n: 0, pnl: 0 }; byExit[x.exit].n++; byExit[x.exit].pnl += x.pnl;
    const k = x.symbol.replace('USDT', '');
    bySymbol[k] = bySymbol[k] || { n: 0, pnl: 0, wins: 0 }; bySymbol[k].n++; bySymbol[k].pnl += x.pnl; if (x.pnl > 0) bySymbol[k].wins++;
  }
  return {
    trades: trades.length, winRate: trades.length ? wins.length / trades.length : 0,
    net: balance - 1000, returnPct: (balance / 1000 - 1) * 100, maxDDPct: maxDD * 100,
    profitFactor: gl ? gw / gl : null, avgWin: wins.length ? gw / wins.length : 0, avgLoss: losses.length ? -gl / losses.length : 0,
    missedLimits, stillOpen: Object.keys(open).length, byExit, bySymbol, tradeList: trades,
  };
}

/* ---------------- variants ---------------- */

const LIMIT = { atr: 0.25, hours: 3 };
const BIG = [1.5, 3, 4.5], BIGGER = [2, 4, 6];
const VARIANTS = [
  { key: 'live', name: '1H · market · 1/2/3R (old live)', rules: {} },
  { key: 'live_nofees', name: '1H · market · 1/2/3R · no fees', rules: { fees: false } },
  { key: '1h_limit', name: '1H · limit entry · 1/2/3R', rules: { limit: LIMIT } },
  { key: '1h_big', name: '1H · market · 1.5/3/4.5R', rules: { targetsR: BIG } },
  { key: '1h_limit_big', name: '1H · limit · 1.5/3/4.5R', rules: { limit: LIMIT, targetsR: BIG } },
  { key: '4h', name: '4H · market · 1/2/3R', rules: { tf: '4H' } },
  { key: '4h_limit', name: '4H · limit entry · 1/2/3R', rules: { tf: '4H', limit: LIMIT } },
  { key: '4h_big', name: '4H · market · 1.5/3/4.5R', rules: { tf: '4H', targetsR: BIG } },
  { key: '4h_limit_big', name: '4H · limit · 1.5/3/4.5R', rules: { tf: '4H', limit: LIMIT, targetsR: BIG } },
  { key: '4h_limit_bigger', name: '4H · limit · 2/4/6R', rules: { tf: '4H', limit: LIMIT, targetsR: BIGGER } },
  { key: '4h_limit_big_be2', name: '4H · limit · 1.5/3/4.5R · BE after T2', rules: { tf: '4H', limit: LIMIT, targetsR: BIG, breakevenAfter: 't2' } },
  { key: '4h_big_risk30', name: '4H · market · 1.5/3/4.5R · $30 risk', rules: { tf: '4H', targetsR: BIG, riskUsd: 30 } },
  { key: '4h_big_risk50', name: '4H · market · 1.5/3/4.5R · $50 risk', rules: { tf: '4H', targetsR: BIG, riskUsd: 50 } },
  { key: '1h_new', name: '1H · 1.5/3/4.5R · $50 risk', rules: { targetsR: BIG, riskUsd: 50 } },
  { key: '1h_vol12', name: '  + volume ≥ 1.2x avg', rules: { targetsR: BIG, riskUsd: 50, volMin: 1.2 } },
  { key: '1h_vol15', name: '  + volume ≥ 1.5x avg', rules: { targetsR: BIG, riskUsd: 50, volMin: 1.5 } },
  { key: '1h_st1', name: '  + 1H Supertrend agrees', rules: { targetsR: BIG, riskUsd: 50, st1Agree: true } },
  { key: '1h_st4', name: '  + 4H Supertrend agrees', rules: { targetsR: BIG, riskUsd: 50, st4Agree: true } },
  { key: '1h_st4_vol', name: '  + 4H Supertrend + volume ≥ 1.2x', rules: { targetsR: BIG, riskUsd: 50, st4Agree: true, volMin: 1.2 } },
  { key: '1h_all', name: '  + 1H & 4H Supertrend + volume ≥ 1.2x', rules: { targetsR: BIG, riskUsd: 50, st1Agree: true, st4Agree: true, volMin: 1.2 } },
  { key: 'x_score40', name: 'idea: min score 40', rules: { tf: '4H', targetsR: BIG, riskUsd: 50, minScore: 40 } },
  { key: 'new_tp', name: 'TP 1.5/2.5/3.5R, 50/25/25%', rules: { tf: '4H', targetsR: [1.5, 2.5, 3.5], split: [0.5, 0.25, 0.25], riskUsd: 50, btcFilter: true, maxOpen: 7, maxSameDir: 4 } },
  { key: 'tp_303040', name: 'TP 1.5/3/4.5R, 30/30/40% (live now)', rules: { tf: '4H', targetsR: BIG, split: [0.3, 0.3, 0.4], riskUsd: 50, btcFilter: true, maxOpen: 7, maxSameDir: 4 }, focus: true },
  { key: 'x_score45', name: 'idea: min score 45', rules: { tf: '4H', targetsR: BIG, riskUsd: 50, minScore: 45 } },
  { key: 'x_score35', name: 'idea: min score 35', rules: { tf: '4H', targetsR: BIG, riskUsd: 50, minScore: 35 } },
  { key: 'x_score60', name: 'idea: min score 60', rules: { tf: '4H', targetsR: BIG, riskUsd: 50, minScore: 60 } },
  { key: 'x_score70', name: 'idea: min score 70', rules: { tf: '4H', targetsR: BIG, riskUsd: 50, minScore: 70 } },
  { key: 'x_btc', name: '4H · $50 risk · BTC filter · 7 slots (40/35/25%)', rules: { tf: '4H', targetsR: BIG, riskUsd: 50, btcFilter: true, maxOpen: 7, maxSameDir: 4 } },
  { key: 'x_lock', name: 'idea: stop to T1 after T2', rules: { tf: '4H', targetsR: BIG, riskUsd: 50, lockT1AfterT2: true } },
  { key: 'x_be2', name: 'idea: breakeven after T2', rules: { tf: '4H', targetsR: BIG, riskUsd: 50, breakevenAfter: 't2' } },
  { key: 'x_dir2', name: 'idea: max 2 per direction', rules: { tf: '4H', targetsR: BIG, riskUsd: 50, maxSameDir: 2 } },
  { key: 'x_open3', name: 'idea: max 3 positions', rules: { tf: '4H', targetsR: BIG, riskUsd: 50, maxOpen: 3 } },
  { key: 'x_nofib', name: 'idea: Fibonacci check off', rules: { tf: '4H', targetsR: BIG, riskUsd: 50, useFib: false } },
  { key: '4h_vol12', name: '4H live + volume ≥ 1.2x', rules: { tf: '4H', targetsR: BIG, riskUsd: 50, volMin: 1.2 } },
  { key: '4h_vol15', name: '4H live + volume ≥ 1.5x', rules: { tf: '4H', targetsR: BIG, riskUsd: 50, volMin: 1.5 } },
  { key: '4h_st', name: '4H live + Supertrend agrees', rules: { tf: '4H', targetsR: BIG, riskUsd: 50, st4Agree: true } },
  { key: 'liq_t2', name: '  + Liq: T2 at cluster', rules: { tf: '4H', targetsR: BIG, riskUsd: 50, liqTargets: ['t2'] } },
  { key: 'liq_t3', name: '  + Liq: T3 at cluster', rules: { tf: '4H', targetsR: BIG, riskUsd: 50, liqTargets: ['t3'] } },
  { key: 'liq_t23', name: '  + Liq: T2 + T3 at clusters', rules: { tf: '4H', targetsR: BIG, riskUsd: 50, liqTargets: ['t2', 't3'] } },
  { key: 'liq_filter', name: '  + Liq: skip if magnet against', rules: { tf: '4H', targetsR: BIG, riskUsd: 50, liqFilter: true } },
  { key: '4h_234_risk50', name: '4H · market · 2/3/4R · $50 risk', rules: { tf: '4H', targetsR: [2, 3, 4], riskUsd: 50 } },
  { key: '4h_2345_risk50', name: '4H · market · 2/3/4.5R · $50 risk', rules: { tf: '4H', targetsR: [2, 3, 4.5], riskUsd: 50 } },
  { key: '4h_big_risk20', name: '4H · market · 1.5/3/4.5R · $20 risk', rules: { tf: '4H', targetsR: BIG, riskUsd: 20 } },
  { key: '4h_big_risk40', name: '4H · market · 1.5/3/4.5R · $40 risk', rules: { tf: '4H', targetsR: BIG, riskUsd: 40 } },
  { key: '4h_risk30', name: '4H · market · 1/2/3R · $30 risk', rules: { tf: '4H', riskUsd: 30 } },
  { key: '4h_bigger_risk30', name: '4H · market · 2/4/6R · $30 risk', rules: { tf: '4H', targetsR: [2, 4, 6], riskUsd: 30 } },
  { key: '4h_limit_big_risk30', name: '4H · limit · 1.5/3/4.5R · $30 risk', rules: { tf: '4H', limit: LIMIT, targetsR: BIG, riskUsd: 30 } },
  { key: '4h_limit_big_nofees', name: '4H · limit · 1.5/3/4.5R · no fees', rules: { tf: '4H', limit: LIMIT, targetsR: BIG, fees: false } },
];

// --scan ADA,LINK,...: each coin traded on its own (live rules, one position)
// over the whole period, split into three equal parts — to see which coins
// the strategy works on before adding them. BTC is always loaded for the BTC filter.
const SCAN = args.includes('--scan') ? String(args[args.indexOf('--scan') + 1] || '').split(',').filter(Boolean).map(x => x.toUpperCase().replace(/USDT$/, '') + 'USDT') : null;

// --coins A,B,C: run just the live variant on this coin list (BTC is loaded for the BTC filter).
const COINS = args.includes('--coins') ? String(args[args.indexOf('--coins') + 1] || '').split(',').filter(Boolean).map(x => x.toUpperCase().replace(/USDT$/, '') + 'USDT') : null;

// --tp-grid: every combination of T1/T2/T3 (in R) and close shares on the live
// rules, ranked; also written to backtest/TP_GRID.md.
const TP_GRID = args.includes('--tp-grid');

async function main() {
  const symbols = SCAN ? [...new Set(['BTCUSDT', ...config.SYMBOLS, ...SCAN])] : COINS ? [...new Set(['BTCUSDT', ...COINS])] : config.SYMBOLS;
  const now = Date.now() - END_AGO * 24 * HOUR;
  const start = now - DAYS * 24 * HOUR;
  const from = start - (LOOKBACK * 4 + 48) * HOUR; // warm-up for the 4H series too
  const series = {};
  for (const s of symbols) {
    process.stderr.write(`fetching ${s}… `);
    const h1 = (await fetchHistory(s, from)).filter(c => c.t >= from);
    process.stderr.write(`${h1.length} 1H candles\n`);
    series[s] = { h1 };
  }
  for (const s of symbols) {
    process.stderr.write(`scoring ${s}…\n`);
    series[s].sig1 = SCAN || COINS || TP_GRID ? new Map() : precompute(s, series[s].h1, 1, start); // the scan only uses 4H
    series[s].sig4 = precompute(s, to4h(series[s].h1), 4, start);
    addFilterInputs(series[s]);
  }
  const times = [...new Set(symbols.flatMap(s => series[s].h1.map(c => c.t)))].filter(t => t >= start && t <= now).sort((a, b) => a - b);

  if (SCAN) return scan(series, symbols, times, start, now);
  if (TP_GRID) return tpGrid(series, symbols, times, start, now);
  if (COINS) {
    const live = VARIANTS.find(v => v.focus), third = (now - start) / 3;
    const maxOpen = args.includes('--max-open') ? +args[args.indexOf('--max-open') + 1] : undefined;
    const r = simulate(series, COINS, times, maxOpen ? { ...live.rules, maxOpen, maxSameDir: Math.ceil(maxOpen * 0.6) } : live.rules);
    const part = [0, 1, 2].map(k => r.tradeList.filter(t => t.closedAt >= start + k * third && t.closedAt < start + (k + 1) * third).reduce((a, t) => a + t.pnl, 0));
    let streak = 0, worstStreak = 0; const months = {};
    for (const t of [...r.tradeList].sort((x, y) => x.closedAt - y.closedAt)) {
      streak = t.pnl <= 0 ? streak + 1 : 0; worstStreak = Math.max(worstStreak, streak);
      const m = new Date(t.closedAt).toISOString().slice(0, 7); months[m] = (months[m] || 0) + t.pnl;
    }
    const mv = Object.entries(months).sort((x, y) => x[1] - y[1]);
    console.log(`  months ${mv.length}, losing ${mv.filter(x => x[1] < 0).length}; worst ${mv[0][0]} ${mv[0][1].toFixed(0)}, best ${mv[mv.length - 1][0]} ${mv[mv.length - 1][1].toFixed(0)}; longest losing streak ${worstStreak}`);
    console.log(`${COINS.map(c => c.replace('USDT', '')).join(',')}: trades ${r.trades} win ${(r.winRate * 100).toFixed(0)}% net ${r.net.toFixed(0)} (${r.returnPct.toFixed(0)}%) maxDD ${r.maxDDPct.toFixed(1)}% PF ${r.profitFactor.toFixed(2)} thirds ${part.map(x => x.toFixed(0)).join(' / ')}`);
    return;
  }
  const results = VARIANTS.map(v => ({ ...v, ...simulate(series, symbols, times, v.rules) }));
  const period = `${new Date(times[0]).toISOString().slice(0, 10)} → ${new Date(times[times.length - 1]).toISOString().slice(0, 10)}`;

  const pad = (x, n) => String(x).padStart(n);
  console.log(`\nBacktest ${period} (${DAYS} days, ${symbols.length} coins, start 1000 USDT, $${BASE_RULES.margin} margin x${BASE_RULES.leverage})\n`);
  console.log('variant'.padEnd(40) + pad('trades', 7) + pad('win%', 6) + pad('net $', 8) + pad('ret%', 7) + pad('maxDD%', 8) + pad('PF', 6) + pad('avgW', 7) + pad('avgL', 7) + pad('missed', 7));
  for (const r of results) {
    console.log(r.name.padEnd(40) + pad(r.trades, 7) + pad((r.winRate * 100).toFixed(0), 6) + pad(r.net.toFixed(0), 8) + pad(r.returnPct.toFixed(1), 7) +
      pad(r.maxDDPct.toFixed(1), 8) + pad(r.profitFactor == null ? '—' : r.profitFactor.toFixed(2), 6) + pad(r.avgWin.toFixed(1), 7) + pad(r.avgLoss.toFixed(1), 7) + pad(r.missedLimits || '', 7));
  }

  // Detail tables: the variant marked focus (the candidate to try on demo),
  // else the best net result after fees.
  const best = results.find(r => r.focus) || results.filter(r => r.rules.fees !== false).sort((a, b) => b.net - a.net)[0];
  if (END_AGO) return;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ period, days: DAYS, generatedAt: new Date().toISOString(), rules: BASE_RULES, results }, (k, v) => (k === 'tradeList' ? undefined : v), 2) + '\n');
  const md = [
    `# Backtest ${period}`, '',
    `${DAYS} days · ${symbols.length} coins · start 1000 USDT · $${BASE_RULES.margin} margin ×${BASE_RULES.leverage} · max ${BASE_RULES.maxOpen} positions, ${BASE_RULES.maxSameDir} per direction · entry score ≥ ${BASE_RULES.minScore} · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, '',
    'Approximation: price/volume signals only (no funding, OI, long/short, book, tape); exits replayed on 1H candles, stop first when a candle touches stop and target; Bybit fees (0.055% taker, 0.02% maker). Limit entries: 0.25×ATR better than the signal close, valid 3 hours, skipped if not filled.', '',
    '| Variant | Trades | Win % | Net $ | Return % | Max DD % | Profit factor | Avg win | Avg loss | Limits missed |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...results.map(r => `| ${r.name} | ${r.trades} | ${(r.winRate * 100).toFixed(0)} | ${r.net.toFixed(0)} | ${r.returnPct.toFixed(1)} | ${r.maxDDPct.toFixed(1)} | ${r.profitFactor == null ? '—' : r.profitFactor.toFixed(2)} | ${r.avgWin.toFixed(1)} | ${r.avgLoss.toFixed(1)} | ${r.missedLimits || ''} |`),
    '', `## ${best.focus ? 'Candidate' : 'Best variant after fees'}: ${best.name} — per coin`, '', '| Coin | Trades | Win % | Net $ |', '|---|---:|---:|---:|',
    ...Object.entries(best.bySymbol).sort((a, b) => b[1].pnl - a[1].pnl).map(([k, v]) => `| ${k} | ${v.n} | ${Math.round(v.wins / v.n * 100)} | ${v.pnl.toFixed(0)} |`),
    '', `## ${best.focus ? 'Candidate' : 'Best variant after fees'}: ${best.name} — by final exit`, '', '| Exit | Trades | Net $ |', '|---|---:|---:|',
    ...Object.entries(best.byExit).map(([k, v]) => `| ${k} | ${v.n} | ${v.pnl.toFixed(0)} |`), '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), md);
  process.stderr.write(`\nwrote backtest/results.json and backtest/REPORT.md\n`);
}

function tpGrid(series, symbols, times, start, end) {
  const live = VARIANTS.find(v => v.focus);
  const third = (end - start) / 3;
  const T1 = [1, 1.5, 2], T2 = [2, 2.5, 3, 4], T3 = [3, 3.5, 4.5, 6];
  const SPLITS = [[0.5, 0.25, 0.25], [0.4, 0.35, 0.25], [0.34, 0.33, 0.33], [0.25, 0.25, 0.5]];
  const rows = [];
  for (const a of T1) for (const b of T2) for (const c of T3) {
    if (!(a < b && b < c)) continue;
    for (const sp of SPLITS) {
      const r = simulate(series, symbols, times, { ...live.rules, targetsR: [a, b, c], split: sp });
      const part = [0, 1, 2].map(k => r.tradeList.filter(t => t.closedAt >= start + k * third && t.closedAt < start + (k + 1) * third).reduce((x, t) => x + t.pnl, 0));
      rows.push({ t: `${a} / ${b} / ${c}R`, sp: sp.map(x => Math.round(x * 100)).join('/') + '%', net: r.net, dd: r.maxDDPct, pf: r.profitFactor, win: r.winRate * 100, trades: r.trades, part, worst: Math.min(...part) });
    }
  }
  const pad = (x, n) => String(x).padStart(n);
  const line = (r) => r.t.padEnd(16) + r.sp.padEnd(12) + pad(r.trades, 7) + pad(r.win.toFixed(0), 5) + pad(r.net.toFixed(0), 8) + pad(r.dd.toFixed(1), 7) + pad(r.pf.toFixed(2), 6) + r.part.map(x => pad(x.toFixed(0), 7)).join('');
  const head = 'targets'.padEnd(16) + 'shares'.padEnd(12) + pad('trades', 7) + pad('win%', 5) + pad('net $', 8) + pad('maxDD', 7) + pad('PF', 6) + pad('1/3', 7) + pad('2/3', 7) + pad('3/3', 7);
  const byNet = [...rows].sort((x, y) => y.net - x.net);
  const byWorst = [...rows].sort((x, y) => y.worst - x.worst);
  const out = [`${rows.length} combinations, live rules (${live.name.replace(' (live now)', '')}), ${new Date(start).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)}, start 1000 USDT`, '',
    'Top 15 by year result:', head, ...byNet.slice(0, 15).map(line), '',
    'Top 10 by weakest third (most consistent):', head, ...byWorst.slice(0, 10).map(line), '',
    'Bottom 5:', head, ...byNet.slice(-5).map(line)];
  // average by each single choice, to see which levels are good regardless of the rest
  const avgBy = (key, vals) => vals.map(v => { const xs = rows.filter(r => key(r) === v); return `${v}: ${(xs.reduce((a, r) => a + r.net, 0) / xs.length).toFixed(0)}`; }).join('  ');
  out.push('', 'Average year result by choice:',
    'T1 ' + avgBy(r => +r.t.split(' / ')[0], T1),
    'T2 ' + avgBy(r => +r.t.split(' / ')[1], T2),
    'T3 ' + avgBy(r => parseFloat(r.t.split(' / ')[2]), T3),
    'shares ' + avgBy(r => r.sp, SPLITS.map(sp => sp.map(x => Math.round(x * 100)).join('/') + '%')));
  console.log(out.join('\n'));
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'TP_GRID.md'), '# Take-profit grid\n\n```\n' + out.join('\n') + '\n```\n');
}

function scan(series, symbols, times, start, end) {
  const live = VARIANTS.find(v => v.focus);
  const third = (end - start) / 3;
  const rows = symbols.map((s) => {
    const r = simulate(series, [s], times, { ...live.rules, maxOpen: 1 });
    const part = [0, 1, 2].map(k => r.tradeList.filter(t => t.closedAt >= start + k * third && t.closedAt < start + (k + 1) * third).reduce((a, t) => a + t.pnl, 0));
    return { s, new: !config.SYMBOLS.includes(s), trades: r.trades, win: r.winRate * 100, net: r.net, pf: r.profitFactor, dd: r.maxDDPct, part };
  }).sort((a, b) => b.net - a.net);
  const pad = (x, n) => String(x).padStart(n);
  console.log(`\nPer-coin scan, ${live.name.replace(' (live now)', '')}, one coin at a time, ${new Date(start).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)}\n`);
  console.log('coin'.padEnd(10) + pad('trades', 7) + pad('win%', 6) + pad('net $', 8) + pad('PF', 6) + pad('maxDD%', 8) + pad('1st 3rd', 9) + pad('2nd 3rd', 9) + pad('3rd 3rd', 9));
  for (const r of rows) {
    console.log((r.s.replace('USDT', '') + (r.new ? ' *' : '')).padEnd(10) + pad(r.trades, 7) + pad(r.win.toFixed(0), 6) + pad(r.net.toFixed(0), 8) +
      pad(r.pf == null ? '—' : r.pf.toFixed(2), 6) + pad(r.dd.toFixed(1), 8) + r.part.map(x => pad(x.toFixed(0), 9)).join(''));
  }
  console.log('\n* = not traded now');
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { simulate, precompute, to4h, BASE_RULES };
