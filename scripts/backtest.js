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
  const instId = require('../src/okx').instId(symbol); // 1000PEPEUSDT -> PEPE-USDT-SWAP (per-1000 price; % levels are unaffected)
  // Newest first, paging back with `after`; once a page adds nothing new,
  // jump straight past what the cache already holds.
  let after = '';
  for (let page = 0; page < 1500; page++) { // up to ~17 years of 1H candles
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

// UTC daily candles from 1H candles; incomplete days are dropped.
// daily close and EMA20/50/200 of the daily closes, keyed by the day's open time
function dailyEma(d1) {
  const out = new Map(), e = {};
  for (const c of d1) {
    for (const n of [20, 50, 200]) e[n] = e[n] == null ? c.c : e[n] + (c.c - e[n]) * 2 / (n + 1);
    out.set(c.t, { c: c.c, 20: e[20], 50: e[50], 200: e[200] });
  }
  return out;
}

function to1d(h1) {
  const out = [];
  for (let i = 0; i + 23 < h1.length; i++) {
    const c = h1[i];
    if (c.t % (24 * HOUR) !== 0 || h1[i + 23].t !== c.t + 23 * HOUR) continue;
    const g = h1.slice(i, i + 24);
    out.push({ t: c.t, o: g[0].o, h: Math.max(...g.map(x => x.h)), l: Math.min(...g.map(x => x.l)), c: g[23].c, v: g.reduce((a, x) => a + x.v, 0) });
    i += 23;
  }
  return out;
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
// opts (score lab): { h1, mode, mtfTrim } — with h1, the daily candles
// (daily pivot) and, for mtfTrim, the 1H/4H/1D alignment are rebuilt as they
// stood at each signal close; mode: 'classic' | 'graded' (src/atlasScore.js).
function precompute(symbol, candles, tfHours, fromMs, opts = {}) {
  // opts.entryTf: score another signal timeframe (e.g. 'D'); the strategy
  // helpers read config.ENTRY_TF, so it is switched for this call only.
  const savedTf = config.ENTRY_TF;
  if (opts.entryTf) config.ENTRY_TF = opts.entryTf;
  try { return precomputeTf(symbol, candles, tfHours, fromMs, opts); } finally { config.ENTRY_TF = savedTf; }
}
function precomputeTf(symbol, candles, tfHours, fromMs, opts) {
  const flipStore = {};
  const out = new Map();
  const h1 = opts.h1, d1 = h1 ? to1d(h1) : null;
  const h1i = h1 ? new Map(h1.map((c, j) => [c.t, j])) : null;
  let dj = -1;
  for (let i = 221; i < candles.length - 1; i++) {
    const closed = candles.slice(Math.max(0, i - LOOKBACK + 1), i + 1);
    const withForming = closed.concat([candles[i + 1]]); // analyse() drops the last (forming) bar
    const cs = { [config.ENTRY_TF]: withForming };
    if (h1) {
      const closeT = candles[i].t + tfHours * HOUR;
      while (dj + 1 < d1.length && d1[dj + 1].t + 24 * HOUR <= closeT) dj++;
      if (dj >= 1) { const dc = d1.slice(Math.max(0, dj - LOOKBACK + 1), dj + 1); cs.D = dc.concat([dc[dc.length - 1]]); }
      const hj = h1i.get(closeT - HOUR);
      if (opts.mtfTrim && hj != null) { const hc = h1.slice(Math.max(0, hj - LOOKBACK + 1), hj + 1); cs['60'] = hc.concat([hc[hc.length - 1]]); }
    }
    let analysis;
    try {
      analysis = atlasScore.analyse({
        symbol, candles: cs, ticker: null, oi: [], ratio: null, book: null, tape: null,
        entryTf: config.ENTRY_TF, mtfTfs: opts.mtfTrim ? ['60', '240', 'D'] : [], flipStore, account: 1000, riskPct: 10, leverage: 10,
        scoreThreshold: config.SCORE_THRESHOLD, scoreMode: opts.mode || 'classic', mtfTrim: !!opts.mtfTrim,
      });
    } catch (err) { continue; } // e.g. flat, no-trade candles in a coin's first days (indicators return null)
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
        rec.chaseDist = analysis.atr > 0 ? Math.abs(analysis.price - analysis.plan.entry) / analysis.atr : 0; // in ATRs, for --chase-lab
        rec.ratio = { stop: p.stop / e, t1: p.t1 / e, t2: p.t2 / e, t3: p.t3 / e };
        // stop = max(STOP_ATR x ATR, Chandelier stop): parts kept so --stop-lab can vary STOP_ATR
        const ce = analysis.ce && analysis.ce.dir === analysis.bias && (analysis.ce.stop - e) * analysis.bias < 0 ? Math.abs(e - analysis.ce.stop) / e : 0;
        rec.stopParts = { atr: analysis.atr / e, ce };
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
  const h4 = to4h(h1), st4 = I.supertrend(h4, 10, 3).dir, adx4 = I.adx(h4, 14).adx;
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
    rec.adx = adx4[i];
  }
}

/* ---------------- portfolio simulation ---------------- */

const BASE_RULES = {
  start: 1000,             // starting balance (USDT)
  tf: '1H', margin: 200, leverage: 10, maxOpen: 5, maxSameDir: 3, minScore: 50,
  useFib: true, breakevenAfter: 't1', lockT1AfterT2: false, riskUsd: null, btcFilter: false, fees: true,
  targetsR: null,          // e.g. [1.5, 3, 4.5]: targets at these multiples of the stop distance (null = live levels)
  limit: null,             // e.g. { atr: 0.25, hours: 3 }: limit entry this much better, valid this many hours
  liqTargets: null,        // ['t2'] / ['t3'] / ['t2','t3']: those targets just before the heaviest estimated liq cluster
  split: [0.40, 0.35, 0.25], // share closed at T1 / T2 / T3
  riskPct: null,           // risk this % of the current balance per trade (instead of riskUsd)
  ddThrottle: null,        // { at: 0.2, factor: 0.5 }: while equity is >= at below its peak, risk x factor
  streakPause: null,       // { n: 4, hours: 24 }: after n losing trades in a row, no new entries for hours
  trail: null,             // { after: 't1'|'t2', atr: k }: runner trails k x ATR instead of a fixed T3
  timeStopH: null,         // close at market if T1 hasn't filled after this many hours
  minAdx: null,            // skip entries while the coin's 4H ADX is below this
  btcMinAdx: null,         // skip entries while BTC's 4H ADX is below this
  liqFilter: false,
  volMin: null,            // 1H filters: signal-candle volume at least this x its 20-candle average
  st1Agree: false,         //   1H Supertrend must point the trade's way
  st4Agree: false,         //   4H Supertrend (last closed 4H candle) must point the trade's way        // skip trades whose heaviest liq cluster against them is nearer than the one for them
};

function simulate(series, symbols, times, rules) {
  const R = { ...BASE_RULES, ...rules };
  const split = R.split || [0.40, 0.35, 0.25];
  const FEE_TAKER = R.fees ? FEES.taker : 0, FEE_MAKER = R.fees ? FEES.maker : 0;
  const sigKey = R.tf === '4H' ? 'sig4' : R.tf === '1D' ? 'sigD' : 'sig1';
  let balance = R.start, peak = R.start, maxDD = 0, curDD = 0, peakT = times[0], dd = null;
  let lossStreak = 0, pauseUntil = 0;
  const open = {};      // symbol -> position
  const pending = {};   // symbol -> resting limit entry
  const used = {};      // one trade per signal: symbol -> { bias, reset }
  // btcCool: after BTC's score reaches +hi (or -hi), wait until it's back under +lo (above -lo) before new trades
  const cool = { long: false, short: false };
  const trades = [];
  let missedLimits = 0;
  const h1idx = Object.fromEntries(symbols.map(s => [s, new Map(series[s].h1.map((c, i) => [c.t, i]))]));

  const usedMargin = () => Object.values(open).reduce((s, p) => s + p.margin * (p.qtyRemaining / p.qty), 0)
    + Object.values(pending).reduce((s, o) => s + o.margin, 0);

  const lastStop = {};
  function closeFill(p, qty, price, reason, fee, t) {
    const pnl = (price - p.entry) * p.bias * qty - price * qty * fee;
    p.pnl += pnl; balance += pnl; p.qtyRemaining -= qty;
    p.exits.push(reason);
    if (p.qtyRemaining <= p.qty * 1e-9) {
      lossStreak = p.pnl < 0 ? lossStreak + 1 : 0;
      if (R.streakPause && lossStreak >= R.streakPause.n) { pauseUntil = t + R.streakPause.hours * HOUR; lossStreak = 0; }
      trades.push({ symbol: p.symbol, bias: p.bias, score: p.score, openedAt: p.openedAt, closedAt: t, pnl: p.pnl, exit: reason, path: p.exits.join(' > '),
        stopPct: Math.abs(1 - p.initStop / p.entry), margin: p.margin, notional: p.qty * p.entry, sig: p.sig, sigT: p.sigT, entry: p.entry });
      if (reason === 'stop' || (R.coolAnyLoss && p.pnl < 0)) lastStop[p.symbol + (R.coolBothDirs ? '' : p.bias)] = t; // for the per-coin cooldown
      delete open[p.symbol];
    }
  }

  // Replays one 1H candle against an open position's stop and targets.
  function manage(p, c, t) {
    if (p.bias === 1 ? c.l <= p.stop : c.h >= p.stop) {
      closeFill(p, p.qtyRemaining, p.stop, p.trailing ? 'trail stop' : p.breakeven ? 'breakeven stop' : (p.lockedT1 ? 'T1-lock stop' : 'stop'), FEE_TAKER, t);
      return;
    }
    for (const k of ['t1', 't2', 't3']) {
      if (p.filled[k]) continue;
      if (k === 't3' && R.trail) break; // the runner leaves on the trailing stop instead
      if (!(p.bias === 1 ? c.h >= p[k] : c.l <= p[k])) break;
      const q = k === 't3' ? p.qtyRemaining : p.qty * split[k === 't1' ? 0 : 1];
      p.filled[k] = true;
      closeFill(p, q, p[k], k.toUpperCase(), FEE_MAKER, t);
      if (!open[p.symbol]) return;
      if (k === R.breakevenAfter) { p.stop = p.entry * (1 + p.bias * (R.beBufferPct || 0) / 100); p.breakeven = true; } // BREAKEVEN_BUFFER_PCT
      if (k === 't2' && R.lockT1AfterT2) { p.stop = p.t1; p.lockedT1 = true; p.breakeven = false; }
    }
    // Trailing stop for the rest once `after` has filled: best close since
    // then minus trail.atr x ATR (never loosens). Uses closes, and a new level
    // only counts from the next candle — conservative.
    if (R.trail && open[p.symbol] && p.filled[R.trail.after]) {
      p.ext = p.ext == null ? c.c : (p.bias === 1 ? Math.max(p.ext, c.c) : Math.min(p.ext, c.c));
      const ts = p.ext - p.bias * R.trail.atr * p.atr;
      if ((ts - p.stop) * p.bias > 0) { p.stop = ts; p.trailing = true; p.breakeven = false; p.lockedT1 = false; }
    }
  }

  // stop distance as a fraction of entry; R.stopAtr re-sizes it like a different STOP_ATR
  function stopDist(sig) {
    if (R.stopAtr != null && sig.stopParts) return Math.max(R.stopAtr * sig.stopParts.atr, sig.stopParts.ce);
    return Math.abs(1 - sig.ratio.stop);
  }

  function levels(entry, sig) {
    if (R.stopAtr != null && sig.stopParts && R.targetsR) {
      const d = stopDist(sig), at = (m) => entry * (1 + sig.bias * d * m);
      return { stop: entry * (1 - sig.bias * d), t1: at(R.targetsR[0]), t2: at(R.targetsR[1]), t3: at(R.targetsR[2]) };
    }
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

  function openPosition(s, sig, entry, t, feeRate, margin, sigT = t) {
    const lv = levels(entry, sig);
    const notional = margin * R.leverage, qty = notional / entry;
    balance -= notional * feeRate;
    open[s] = {
      symbol: s, bias: sig.bias, score: sig.score, entry, ...lv, qty, qtyRemaining: qty, margin,
      pnl: -notional * feeRate, filled: {}, breakeven: false, openedAt: t, exits: [], atr: sig.atr, initStop: lv.stop, sig, sigT,
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
        openPosition(s, o.sig, o.price, t, FEE_MAKER, o.margin, o.sigT);
        manage(open[s], c, t); // worst case: stop/targets can already hit in the fill candle
      } else if (t >= o.expires) { delete pending[s]; missedLimits++; }
    }

    // 2) exits for positions opened before this candle
    for (const p of Object.values(open)) {
      const i = h1idx[p.symbol].get(t);
      if (i == null || t <= p.openedAt) continue;
      manage(p, series[p.symbol].h1[i], t);
      if (!open[p.symbol]) continue;
      if (R.timeStopH && !p.filled.t1 && t - p.openedAt >= R.timeStopH * HOUR &&
          (!R.timeStopLossOnly || (series[p.symbol].h1[i].c - p.entry) * p.bias < 0)) {
        closeFill(p, p.qtyRemaining, series[p.symbol].h1[i].c, 'time stop', FEE_TAKER, t);
        continue;
      }
      const sig = series[p.symbol][sigKey].get(t);
      if (sig && sig.bias !== 0 && sig.bias !== p.bias && !R.noFlip && !(R.flipBeforeT1 && p.filled.t1)) closeFill(p, p.qtyRemaining, series[p.symbol].h1[i].c, 'signal flip', FEE_TAKER, t);
      else if (R.neutralExit && sig && sig.bias === 0 && (R.neutralExit === 'all' || !p.filled.t1))
        closeFill(p, p.qtyRemaining, series[p.symbol].h1[i].c, 'score neutral', FEE_TAKER, t); // score back inside +/-25
    }

    // 3) one-trade-per-signal memory (only on candles that carry a signal)
    for (const s of symbols) {
      const sig = series[s][sigKey].get(t), m = used[s];
      if (sig && m && sig.bias !== m.bias) m.reset = true;
      if (m && m.reset && !open[s] && !pending[s]) delete used[s];
    }

    // 4) new entries, strongest |score| first
    const btc = series.BTCUSDT && series.BTCUSDT[sigKey].get(t);
    if (R.btcCool && btc) {
      const { hi, lo } = R.btcCool;
      if (btc.score >= hi) cool.long = true; else if (btc.score < lo) cool.long = false;
      if (btc.score <= -hi) cool.short = true; else if (btc.score > -lo) cool.short = false;
    }
    const cands = [];
    for (const s of symbols) {
      if (open[s] || pending[s]) continue;
      const sig = series[s][sigKey].get(t);
      if (!sig || sig.bias === 0 || !sig.ratio) continue;
      const minScore = (R.minScoreBySymbol && R.minScoreBySymbol[s] != null) ? R.minScoreBySymbol[s]
        : sig.bias === 1 && R.minScoreLong != null ? R.minScoreLong : sig.bias === -1 && R.minScoreShort != null ? R.minScoreShort : R.minScore;
      if (R.breadth) {
        // market breadth: share of the coins whose score is past +/-25 in the trade direction (and the other way)
        let n = 0, with_ = 0, against = 0;
        for (const c of R.breadthCoins || symbols) { const x = series[c] && series[c][sigKey].get(t); if (!x) continue; n++; if (x.bias === sig.bias) with_++; else if (x.bias === -sig.bias) against++; }
        if (R.breadth === 'majority' ? !(with_ > against) : !(n && with_ / n >= R.breadth)) continue;
      }
      if (R.dAgree) {
        // daily trend filter: the last closed 1D signal must point the trade's way
        const dayStart = Math.floor((t + HOUR) / (24 * HOUR)) * 24 * HOUR - 24 * HOUR;
        const d = series[s].sigD && series[s].sigD.get(dayStart + 23 * HOUR);
        if (R.dAgree === 'soft' ? d && d.bias === -sig.bias : (!d || d.bias !== sig.bias)) continue;
      }
      if (R.coolH) {
        // per-coin cooldown: no new trade on this coin (this direction) for N hours after a stop-loss
        const ls = lastStop[s + (R.coolBothDirs ? '' : sig.bias)];
        if (ls != null && t - ls < R.coolH * HOUR) continue;
      }
      if (R.dEma) {
        // daily trend: the last closed daily close must sit on the trade's side of its EMA
        const dayStart = Math.floor((t + HOUR) / (24 * HOUR)) * 24 * HOUR - 24 * HOUR;
        const d = series[s].dEma && series[s].dEma.get(dayStart);
        if (!d || (d.c - d[R.dEma]) * sig.bias <= 0) continue;
      }
      if (R.entryFn) {
        // score momentum: the score in the trade's direction now and 1 / 2 signal candles ago
        const step = R.tf === '4H' ? 4 * HOUR : HOUR, b = sig.bias;
        const p1 = series[s][sigKey].get(t - step), p2 = series[s][sigKey].get(t - 2 * step);
        if (!p1 || !p2 || !R.entryFn(sig.score * b, p1.score * b, p2.score * b)) continue;
      } else if (Math.abs(sig.score) < minScore) continue;
      if (used[s] && !used[s].reset && used[s].bias === sig.bias) continue;
      // chase: R.chaseAtr overrides MAX_CHASE_ATR (null = off)
      const chaseOk = R.chaseAtr === undefined ? sig.gate.chase : R.chaseAtr === null || sig.chaseDist <= R.chaseAtr;
      if (!chaseOk || (R.useFib && !sig.gate.fib)) continue;
      if (R.minAdx && !(sig.adx >= R.minAdx)) continue;
      if (R.btcMinAdx && !(btc && btc.adx >= R.btcMinAdx)) continue;
      if (R.volMin && !(sig.vr >= R.volMin)) continue;
      if (R.maxAdx && !(sig.adx < R.maxAdx)) continue; // skip an overstretched trend
      if (R.tier && Math.abs(sig.score) < R.tier.below && !(sig.vr >= R.tier.volMin)) continue; // weaker scores need volume
      if (R.skipDays && R.skipDays.includes(new Date(t + HOUR).getUTCDay())) continue;
      if (R.st1Agree && sig.st1 !== sig.bias) continue;
      if (R.st4Agree && sig.st4 !== sig.bias) continue;
      if (R.liqFilter && sig.liq) {
        // Skip when the heaviest cluster against the trade is closer than the one in its favour.
        const up = sig.liq.up ? sig.liq.up - 1 : Infinity, down = sig.liq.down ? 1 - sig.liq.down : Infinity;
        if ((sig.bias === 1 ? down < up : up < down)) continue;
      }
      if (R.btcFilter && s !== 'BTCUSDT' && btc && btc.bias === -sig.bias) continue;
      if (R.noWeekend || R.skipCloseHours) {
        // the signal candle's close (UTC): t is its last 1H candle
        const close = new Date(t + HOUR), day = close.getUTCDay();
        if (R.noWeekend && (day === 0 || day === 6)) continue;
        if (R.skipCloseHours && R.skipCloseHours.includes(close.getUTCHours())) continue;
      }
      if (R.volBand) {
        // this candle's ATR% vs the coin's own average ATR% over the last n signal candles
        const { lo, hi, n } = R.volBand, step = R.tf === '4H' ? 4 * HOUR : HOUR;
        let sum = 0, k = 0;
        for (let j = 1; j <= n; j++) { const r = series[s][sigKey].get(t - j * step); if (r && r.atr && r.close) { sum += r.atr / r.close; k++; } }
        if (k >= n / 2 && sig.atr && sig.close) {
          const rel = (sig.atr / sig.close) / (sum / k);
          if ((hi != null && rel > hi) || (lo != null && rel < lo)) continue;
        }
      }
      if (R.btcLine && s !== 'BTCUSDT' && btc) {
        // stricter BTC filter: shorts need BTC's score below shortMax, longs need it above longMin
        const { shortMax, longMin } = R.btcLine;
        if (sig.bias === -1 && shortMax != null && !(btc.score < shortMax)) continue;
        if (sig.bias === 1 && longMin != null && !(btc.score > longMin)) continue;
      }
      if (R.btcCool) {
        const blockL = R.btcCool.all ? cool.long || cool.short : cool.long, blockS = R.btcCool.all ? cool.long || cool.short : cool.short;
        if ((sig.bias === 1 && blockL) || (sig.bias === -1 && blockS)) continue;
      }
      cands.push({ s, sig });
    }
    cands.sort((a, b) => Math.abs(b.sig.score) - Math.abs(a.sig.score));
    let newNow = 0; // entries on this signal candle (maxNewPerCandle)
    for (const { s, sig } of cands) {
      const busy = [...Object.values(open), ...Object.values(pending).map(o => o.sig)];
      if (busy.length >= R.maxOpen) break;
      if (busy.filter(p => p.bias === sig.bias).length >= R.maxSameDir) continue;
      if (R.groups) {
        // correlation cap: at most groupMax open / pending trades per group of coins that move together
        const g = R.groups.find(x => x.includes(s));
        if (g && [...Object.keys(open), ...Object.keys(pending)].filter(c => g.includes(c)).length >= R.groupMax) continue;
      }
      if (t < pauseUntil) break;
      if (R.maxNewPerCandle && newNow >= R.maxNewPerCandle) break;
      let margin = R.margin;
      let risk = R.riskPct ? balance * R.riskPct / 100 : R.riskUsd;
      if (R.ddThrottle && curDD >= R.ddThrottle.at) risk *= R.ddThrottle.factor;
      if (R.riskByScore) risk *= R.riskByScore.find(([min]) => Math.abs(sig.score) >= min)[1]; // [[minScore, factor], ...] high to low
      if (R.riskUsd || R.riskPct) {
        if (!(risk > 0)) continue;
        // margin cap: fixed R.margin, or R.marginPct % of the current balance (grows with it); marginPct 0 = no cap
        const cap = R.marginPct === 0 ? Infinity : R.marginPct ? balance * R.marginPct / 100 : R.margin;
        margin = Math.min(risk / stopDist(sig), cap * R.leverage) / R.leverage;
      }
      if (balance - usedMargin() < margin * 0.99) continue; // full-size trades only
      used[s] = { bias: sig.bias, reset: false };
      if (R.limit) {
        pending[s] = { sig, sigT: t, margin, price: sig.close - sig.bias * R.limit.atr * sig.atr, expires: t + R.limit.hours * HOUR };
      } else {
        openPosition(s, sig, sig.close, t, FEE_TAKER, margin);
      }
      newNow++;
    }

    // equity: realized + open P&L at this candle's close
    let eq = balance;
    for (const p of Object.values(open)) {
      const i = h1idx[p.symbol].get(t);
      if (i != null) eq += (series[p.symbol].h1[i].c - p.entry) * p.bias * p.qtyRemaining;
    }
    if (eq > peak) { peak = eq; peakT = t; }
    curDD = (peak - eq) / peak;
    if (curDD > maxDD) { maxDD = curDD; dd = { peakT, troughT: t, peak, trough: eq }; }
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
    net: balance - R.start, returnPct: (balance / R.start - 1) * 100, maxDDPct: maxDD * 100,
    profitFactor: gl ? gw / gl : null, avgWin: wins.length ? gw / wins.length : 0, avgLoss: losses.length ? -gl / losses.length : 0,
    missedLimits, stillOpen: Object.keys(open).length, byExit, bySymbol, tradeList: trades, dd,
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
  { key: 'tp_203050', name: 'TP 1.5/2.5/3.5R, 25/25/50% (live now)', rules: { tf: '4H', targetsR: [1.5, 2.5, 3.5], split: [0.25, 0.25, 0.5], riskUsd: 50, btcFilter: true, maxOpen: 5, maxSameDir: 4, maxNewPerCandle: 3, lockT1AfterT2: true }, focus: true },
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
// --analyze: the live setup at the real account size (2000 USDT, $100 risk,
// $400 max margin, config.SYMBOLS) in detail; also written to backtest/ANALYSIS.md.
const ANALYZE = args.includes('--analyze');
// --score-scan: for every live coin, try a grid of entry-score thresholds
// (each coin traded on its own, live rules otherwise) and report the best
// one per coin; also written to backtest/SCORE_SCAN.md.
const SCORE_SCAN = args.includes('--score-scan');
// --score-wf: walk-forward check of per-coin entry scores. Picks each coin's
// score on the first 2/3 of the period only, tests it on the last 1/3, and
// compares portfolios (flat 50 vs the live per-coin map vs the walk-forward
// map). Written to backtest/SCORE_WF.md.
const SCORE_WF = args.includes('--score-wf');
// --exit-lab: trailing stop, time stop and ADX regime filter on the live
// portfolio, per period and walk-forward. Written to backtest/EXIT_LAB.md.
const EXIT_LAB = args.includes('--exit-lab');
// --risk-grid: risk per trade x position limits at the real account size
// (config.PORTFOLIO), live rules otherwise. Written to backtest/RISK_GRID.md.
const RISK_GRID = args.includes('--risk-grid');
// --lev-grid: leverage 5x..10x on the planned setup ($100 risk, 7 slots,
// max 4 per direction), with the margin cap fixed or the position cap fixed.
const LEV_GRID = args.includes('--lev-grid');
// --dd-lab: ways to limit the worst drop on the live setup at real size.
const DD_LAB = args.includes('--dd-lab');
// --risk-starts: fixed-$ vs %-of-balance risk from 12 different start dates
// (4-month windows, 20 days apart) plus a margin-cap check. backtest/RISK_STARTS.md.
const RISK_STARTS = args.includes('--risk-starts');
// --coin-wf: per-coin results per calendar year, and a walk-forward test of
// picking coins by their past record. Fixed $ risk so years compare fairly.
// Written to backtest/COIN_WF.md.
const COIN_WF = args.includes('--coin-wf');
// --candidates A,B,...: with --coin-wf, also test these coins (not traded now)
// per year, and whether adding them to the live list helps (walk-forward).
// Written to backtest/COIN_CANDIDATES.md.
// --tf-compare: 1H vs 4H signals on the live setup and coins, compounding
// (live % risk) and per year ($100 fixed, fresh start each year).
// Written to backtest/TF_COMPARE.md.
const TF_COMPARE = args.includes('--tf-compare');
// --score-lab --mode classic|graded [--mtf] [--tag name]: one way of
// computing the score (daily pivot included, as live), entry thresholds 30-70
// on the live setup: per year ($100 fixed, fresh start each year) and
// compounding. Picks the threshold on 2020-2023 and shows it on 2024-2026.
// Writes backtest/score-lab-<tag>.json (merged by --score-lab-report).
const SCORE_LAB = args.includes('--score-lab');
// --score-mom: entries on score momentum (the score rising candle to candle)
// vs the fixed min-score rule. Written to backtest/SCORE_MOM.md.
const SCORE_MOM = args.includes('--score-mom');
// --lab2: exits after T1 and risk controls for bad years, 2020-2026, same
// table as --score-mom. Written to backtest/EXIT_RISK_LAB.md.
const LAB2 = args.includes('--lab2');
// --lab3: combinations of the --lab2 winners. backtest/EXIT_RISK_COMBOS.md.
const LAB3 = args.includes('--lab3');
// --tf-day: 1D signals vs 4H, and 4H entries only with the daily trend.
// backtest/TF_DAY.md.
const TF_DAY = args.includes('--tf-day');
// --per-candle: max new entries per 4H candle. backtest/PER_CANDLE.md.
const PER_CANDLE = args.includes('--per-candle');
// --coinset A,B,C: the live setup on this coin list vs the live coin list.
// backtest/COINSET.md.
// --tune: targets, splits, stops after T1/T2, min score, risk, margin,
// leverage, slots on the live coins. backtest/TUNE.md.
const TUNE = args.includes('--tune');
// --combo: the chosen tuning changes together. backtest/COMBO.md.
const COMBO = args.includes('--combo');
// --split: share closed at T1/T2/T3 on the live setup. backtest/SPLIT.md.
const SPLIT = args.includes('--split');
// --slots: open-position and per-direction limits on the live setup. backtest/SLOTS.md.
const SLOTS = args.includes('--slots');
// --btc-cool: pause new trades after BTC's score runs to +/-hi until it cools back under lo. backtest/BTC_COOL.md.
const BTC_COOL = args.includes('--btc-cool');
// --btc-line: stricter BTC filter (shorts only below a BTC score, longs only above). backtest/BTC_LINE.md.
const BTC_LINE = args.includes('--btc-line');
// --time-stop: close a trade that hasn't reached T1 after N hours. backtest/TIME_STOP.md.
const TIME_STOP = args.includes('--time-stop');
// --score-jump: enter when the score jumps N+ points in one 4H candle. backtest/SCORE_JUMP.md.
const SCORE_JUMP = args.includes('--score-jump');
// --score-jump-rob: robustness check around the +40 jump. backtest/SCORE_JUMP_ROBUST.md.
const SCORE_JUMP_ROB = args.includes('--score-jump-rob');
// --pf-lab: pullback limit entries, volatility band, weekend / time-of-day filters. backtest/PF_LAB.md.
const PF_LAB = args.includes('--pf-lab');
// --score-rise: score >= 65 and still rising (long) / falling (short). backtest/SCORE_RISE.md.
const SCORE_RISE = args.includes('--score-rise');
// --limit-rob: robustness of the 0.25 ATR pullback limit entry. backtest/LIMIT_ROBUST.md.
const LIMIT_ROB = args.includes('--limit-rob');
// --live-now: the current live setup against the earlier ones. backtest/LIVE_NOW.md.
const LIVE_NOW = args.includes('--live-now');
// --stop-lab: stop width, exit on a neutral score, pause after losing streaks. backtest/STOP_LAB.md.
const STOP_LAB = args.includes('--stop-lab');
// --streak-rob: robustness of the '5 losses -> 48h pause' rule. backtest/STREAK_ROBUST.md.
const STREAK_ROB = args.includes('--streak-rob');
// --score-now: entry score 50-70 on the current live setup. backtest/SCORE_NOW.md.
const SCORE_NOW = args.includes('--score-now');
// --new-coins --candidates A,B,...: candidate coins on the live setup, alone and added to the coin list. backtest/NEW_COINS_LIVE.md.
const NEW_COINS = args.includes('--new-coins');
// --add-check --candidates A,B: adding those coins to the live list, together and per coin-list half. backtest/ADD_CHECK.md.
const ADD_CHECK = args.includes('--add-check');
// --chase-lab: max distance from the signal price (x ATR) on the live setup. backtest/CHASE_LAB.md.
const CHASE_LAB = args.includes('--chase-lab');
// --drop-check: the live setup without a coin (and the half of the list it sits in); written to backtest/DROP_CHECK.md.
const DROP_CHECK = args.includes('--drop-check');
// --flip-lab: signal-flip exit only before T1 (after T1 breakeven / T1-lock handle the runner); written to backtest/FLIP_LAB.md.
const FLIP_LAB = args.includes('--flip-lab');
// --day-lab: daily-trend filters on the live setup (1D ATLAS signal, daily close vs EMA20/50/200); written to backtest/DAY_LAB.md.
const DAY_LAB = args.includes('--day-lab');
// --cool-lab: per-coin cooldown after a stop-loss on the live setup; written to backtest/COOL_LAB.md.
const COOL_LAB = args.includes('--cool-lab');
// --pf2-lab --part breadth|size|corr|ls: market breadth, score-based sizing, correlation cap,
// separate long/short score; written to backtest/PF2_<PART>.md.
const PF2_LAB = args.includes('--pf2-lab');
// --margin-lab: margin cap as a % of the balance instead of a fixed $400; written to backtest/MARGIN_LAB.md.
const MARGIN_LAB = args.includes('--margin-lab');
// --leak: the live trades split by what was true at entry (BTC score, ATR %, ADX, volume, ...),
// PF per bucket for 2020-23 and 2024-26 separately; written to backtest/LEAK.md.
const LEAK = args.includes('--leak');
// --pf3-lab: filters suggested by the leak report (volume, ADX cap, higher score, weekday / hour); written to backtest/PF3_LAB.md.
const PF3_LAB = args.includes('--pf3-lab');
// --adx-lab: ADX cap 35/40/45/50 on the live setup, with both coin halves; written to backtest/ADX_LAB.md.
const ADX_LAB = args.includes('--adx-lab');
const PF2_PART = args.includes('--part') ? args[args.indexOf('--part') + 1] : 'breadth';
const COINSET = args.includes('--coinset') ? String(args[args.indexOf('--coinset') + 1] || '').split(',').filter(Boolean).map(x => x.toUpperCase().replace(/USDT$/, '') + 'USDT') : null;
const LAB_MODE = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'classic';
const LAB_MTF = args.includes('--mtf');
const LAB_TAG = args.includes('--tag') ? args[args.indexOf('--tag') + 1] : LAB_MODE + (LAB_MTF ? '-mtf' : '');
const CANDIDATES = args.includes('--candidates') ? String(args[args.indexOf('--candidates') + 1] || '').split(',').filter(Boolean).map(x => x.toUpperCase().replace(/USDT$/, '') + 'USDT') : [];

async function main() {
  if (args.includes('--score-lab-report')) {
    const files = fs.readdirSync(OUT).filter(f => /^score-lab-.*\.json$/.test(f)).sort();
    const out = scoreLabText(files.map(f => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'))));
    console.log(out);
    fs.writeFileSync(path.join(OUT, 'SCORE_LAB.md'), '# Score computation lab\n\nPer year: fresh 2000 USDT each year, $100 fixed risk — net $ (worst drop). Compound: 2000 USDT, live % risk, whole period. Live rules otherwise (4H, targets 1.5/3/4.5R, 7 slots, BTC filter, fees). Price/volume signals only (no funding, OI, book, tape).\n\n```\n' + out + '\n```\n');
    return;
  }
  const symbols = SCAN ? [...new Set(['BTCUSDT', ...config.SYMBOLS, ...SCAN])] : COINS ? [...new Set(['BTCUSDT', ...COINS])] : [...new Set([...config.SYMBOLS, ...CANDIDATES, ...(COINSET || []), 'BTCUSDT'])];
  const now = Date.now() - END_AGO * 24 * HOUR;
  const start = now - DAYS * 24 * HOUR;
  const from = start - (LOOKBACK * (TF_DAY ? 24 : 4) + 48) * HOUR; // warm-up for the 4H (or 1D) series too
  const series = {};
  for (const s of [...symbols]) {
    process.stderr.write(`fetching ${s}… `);
    let h1;
    try { h1 = (await fetchHistory(s, from)).filter(c => c.t >= from); } catch (err) {
      if (!CANDIDATES.includes(s) && !(COINSET || []).includes(s)) throw err;
      process.stderr.write(`skipped (${err.message})\n`); symbols.splice(symbols.indexOf(s), 1); continue;
    }
    process.stderr.write(`${h1.length} 1H candles\n`);
    series[s] = { h1 };
  }
  for (const s of symbols) {
    process.stderr.write(`scoring ${s}…\n`);
    series[s].sig1 = SCORE_LAB ? new Map() : TF_COMPARE ? precompute(s, series[s].h1, 1, start) : SCAN || COINS || TP_GRID || ANALYZE || SCORE_SCAN || SCORE_WF || EXIT_LAB || RISK_GRID || LEV_GRID || DD_LAB || RISK_STARTS || COIN_WF || SCORE_MOM || LAB2 || LAB3 || TF_DAY || PER_CANDLE || COINSET || TUNE || COMBO || SPLIT || SLOTS || BTC_COOL || BTC_LINE || TIME_STOP || SCORE_JUMP || SCORE_JUMP_ROB || PF_LAB || SCORE_RISE || LIMIT_ROB || LIVE_NOW || STOP_LAB || STREAK_ROB || SCORE_NOW || NEW_COINS || ADD_CHECK || CHASE_LAB || DROP_CHECK || FLIP_LAB || DAY_LAB || COOL_LAB || PF2_LAB || MARGIN_LAB || LEAK || PF3_LAB || ADX_LAB ? new Map() : precompute(s, series[s].h1, 1, start); // the scan only uses 4H
    series[s].sig4 = SCORE_LAB ? precompute(s, to4h(series[s].h1), 4, start, { h1: series[s].h1, mode: LAB_MODE, mtfTrim: LAB_MTF }) : precompute(s, to4h(series[s].h1), 4, start);
    if (DAY_LAB) series[s].dEma = dailyEma(to1d(series[s].h1));
    if (TF_DAY || DAY_LAB) series[s].sigD = precompute(s, to1d(series[s].h1), 24, start, { entryTf: 'D' });
    addFilterInputs(series[s]);
  }
  const times = [...new Set(symbols.flatMap(s => series[s].h1.map(c => c.t)))].filter(t => t >= start && t <= now).sort((a, b) => a - b);

  if (SCAN) return scan(series, symbols, times, start, now);
  if (TP_GRID) return tpGrid(series, symbols, times, start, now);
  if (ANALYZE) return analyze(series, symbols, times, start, now);
  if (SCORE_SCAN) return scoreScan(series, symbols, times, start, now);
  if (SCORE_WF) return scoreWalkForward(series, symbols, times, start, now);
  if (EXIT_LAB) return exitLab(series, symbols, times, start, now);
  if (RISK_GRID) return riskGrid(series, symbols, times, start, now);
  if (LEV_GRID) return levGrid(series, symbols, times, start, now);
  if (DD_LAB) return ddLab(series, symbols, times, start, now);
  if (RISK_STARTS) return riskStarts(series, symbols, times, start, now);
  if (CHASE_LAB) {
    const NOW = { minScore: 65, limit: { atr: 0.3, hours: 4 }, beBufferPct: 0.2 };
    const n = Math.ceil(config.SYMBOLS.length / 2), A = config.SYMBOLS.slice(0, n), B = config.SYMBOLS.slice(n);
    return variantTable('Chase limit: max distance from the signal price (live setup)', [
      ['A  live: max 1 ATR', { ...NOW }],
      ['check: 1 ATR via chaseAtr', { ...NOW, chaseAtr: 1 }],
      ['max 0.75 ATR', { ...NOW, chaseAtr: 0.75 }],
      ['max 1.5 ATR', { ...NOW, chaseAtr: 1.5 }],
      ['max 2 ATR', { ...NOW, chaseAtr: 2 }],
      ['max 3 ATR', { ...NOW, chaseAtr: 3 }],
      ['no chase limit', { ...NOW, chaseAtr: null }],
      ['-- first half of the coins --', null],
      ['1 ATR, first half', { ...NOW, coins: A }], ['1.5 ATR, first half', { ...NOW, chaseAtr: 1.5, coins: A }], ['2 ATR, first half', { ...NOW, chaseAtr: 2, coins: A }],
      ['-- second half of the coins --', null],
      ['1 ATR, second half', { ...NOW, coins: B }], ['1.5 ATR, second half', { ...NOW, chaseAtr: 1.5, coins: B }], ['2 ATR, second half', { ...NOW, chaseAtr: 2, coins: B }],
    ], series, times, start, now, 'CHASE_LAB.md', 'Chase = |price - signal price| / ATR at the entry check, where the signal price is where the score first crossed +/-25. Live setup otherwise (score 65, limit 0.3 ATR 4h, BE +0.2%, 22 coins).');
  }
  if (ADX_LAB) {
    const NOW = { minScore: 65, limit: { atr: 0.3, hours: 4 }, beBufferPct: 0.2 };
    const all = config.SYMBOLS, n = Math.ceil(all.length / 2), A = all.slice(0, n), B = all.slice(n);
    const caps = [35, 40, 45, 50];
    return variantTable('ADX cap: skip entries when the 4H ADX is at or above N (live setup)', [
      ['A  live: no ADX cap', { ...NOW }],
      ...caps.map(c => ['ADX < ' + c, { ...NOW, maxAdx: c }]),
      ['-- first half of the coins --', null], ['live, first half', { ...NOW, coins: A }], ...caps.map(c => ['ADX < ' + c + ', first half', { ...NOW, maxAdx: c, coins: A }]),
      ['-- second half of the coins --', null], ['live, second half', { ...NOW, coins: B }], ...caps.map(c => ['ADX < ' + c + ', second half', { ...NOW, maxAdx: c, coins: B }]),
    ], series, times, start, now, 'ADX_LAB.md', 'Live setup (score 65, limit 0.3 ATR 4h, BE +0.2%, ' + all.length + ' coins). ADX = 4H ADX(14) on the signal candle. The cap is robust only if the neighbouring values also beat live.');
  }
  if (PF3_LAB) {
    const NOW = { minScore: 65, limit: { atr: 0.3, hours: 4 }, beBufferPct: 0.2 };
    const all = config.SYMBOLS, n = Math.ceil(all.length / 2), A = all.slice(0, n), B = all.slice(n);
    const halves = (...vs) => [['-- first half of the coins --', null], ['live, first half', { ...NOW, coins: A }], ...vs.map(([l, x]) => [l + ', first half', { ...NOW, ...x, coins: A }]),
      ['-- second half of the coins --', null], ['live, second half', { ...NOW, coins: B }], ...vs.map(([l, x]) => [l + ', second half', { ...NOW, ...x, coins: B }])];
    const VOL = { volMin: 0.7 }, ADX = { maxAdx: 40 }, TIER = { tier: { below: 75, volMin: 1 } };
    return variantTable('Filters from the leak report (live setup)', [
      ['A  live', { ...NOW }],
      ['volume >= 0.7x average', { ...NOW, ...VOL }],
      ['ADX < 40', { ...NOW, ...ADX }],
      ['volume >= 0.7x + ADX < 40', { ...NOW, ...VOL, ...ADX }],
      ['min score 70', { ...NOW, minScore: 70 }],
      ['min score 75', { ...NOW, minScore: 75 }],
      ['score 65-74 only with volume >= 1x', { ...NOW, ...TIER }],
      ['skip Sun + Mon signals', { ...NOW, skipDays: [0, 1] }],
      ['skip the 08 UTC close', { ...NOW, skipCloseHours: [8] }],
      ...halves(['volume >= 0.7x', VOL], ['ADX < 40', ADX], ['volume + ADX', { ...VOL, ...ADX }], ['65-74 needs volume', TIER]),
    ], series, times, start, now, 'PF3_LAB.md', 'Live setup (score 65, limit 0.3 ATR 4h, BE +0.2%, ' + all.length + ' coins). Volume = the signal candle\'s volume vs its 20-candle average; ADX = 4H ADX(14) at the signal. Weekday / hour rows are the most likely to be noise (picked from the same data).');
  }
  if (LEAK) return leakReport(series, times, start, now);
  if (MARGIN_LAB) {
    const NOW = { minScore: 65, limit: { atr: 0.3, hours: 4 }, beBufferPct: 0.2 };
    const all = config.SYMBOLS, n = Math.ceil(all.length / 2), A = all.slice(0, n), B = all.slice(n);
    const SIZE = [[85, 1.2], [75, 1], [0, 0.8]];
    return variantTable('Margin cap growing with the balance (live setup)', [
      ['A  live: max $400 margin', { ...NOW }],
      ['max 10% of balance', { ...NOW, marginPct: 10 }],
      ['max 15% of balance', { ...NOW, marginPct: 15 }],
      ['max 20% of balance (= $400 at start)', { ...NOW, marginPct: 20 }],
      ['max 25% of balance', { ...NOW, marginPct: 25 }],
      ['no margin cap (risk only)', { ...NOW, marginPct: 0 }],
      ['20% of balance + risk by score 0.8/1/1.2', { ...NOW, marginPct: 20, riskByScore: SIZE }],
      ['-- first half of the coins --', null],
      ['live, first half', { ...NOW, coins: A }], ['20% of balance, first half', { ...NOW, marginPct: 20, coins: A }], ['20% + score size, first half', { ...NOW, marginPct: 20, riskByScore: SIZE, coins: A }],
      ['-- second half of the coins --', null],
      ['live, second half', { ...NOW, coins: B }], ['20% of balance, second half', { ...NOW, marginPct: 20, coins: B }], ['20% + score size, second half', { ...NOW, marginPct: 20, riskByScore: SIZE, coins: B }],
    ], series, times, start, now, 'MARGIN_LAB.md', 'Live setup (score 65, limit 0.3 ATR 4h, BE +0.2%, 2.5% risk, 10x, ' + all.length + ' coins). The cap limits the margin per trade; risk sizing (2.5% of balance at the stop) still decides the size below it. No slippage modelled: very large orders on small coins would fill worse in reality.');
  }
  if (PF2_LAB) {
    const NOW = { minScore: 65, limit: { atr: 0.3, hours: 4 }, beBufferPct: 0.2 };
    const all = config.SYMBOLS, n = Math.ceil(all.length / 2), A = all.slice(0, n), B = all.slice(n);
    // robustness: the live setup and each variant on both halves of the coin list
    const halves = (...vs) => [['-- first half of the coins --', null], ['live, first half', { ...NOW, coins: A }], ...vs.map(([l, x]) => [l + ', first half', { ...NOW, ...x, coins: A }]),
      ['-- second half of the coins --', null], ['live, second half', { ...NOW, coins: B }], ...vs.map(([l, x]) => [l + ', second half', { ...NOW, ...x, coins: B }])];
    const live = ['A  live', { ...NOW }];
    const MEMES = ['DOGEUSDT', '1000PEPEUSDT', '1000BONKUSDT'], GAMING = ['GALAUSDT', 'SANDUSDT', 'AXSUSDT'], L1 = ['SOLUSDT', 'SUIUSDT', 'NEARUSDT', 'ATOMUSDT', 'EGLDUSDT'];
    const P = config.PORTFOLIO;
    const parts = {
      breadth: ['Market breadth filter (live setup)', 'PF2_BREADTH.md', 'Breadth = share of all ' + all.length + ' live coins whose 4H score is past +/-25 in the trade direction on the same candle (halves still use all coins for breadth). "majority" = more coins with the trade than against it.', [
        live,
        ['breadth: majority with the trade', { ...NOW, breadth: 'majority', breadthCoins: all }],
        ['breadth >= 20% with the trade', { ...NOW, breadth: 0.2, breadthCoins: all }],
        ['breadth >= 30% with the trade', { ...NOW, breadth: 0.3, breadthCoins: all }],
        ['breadth >= 40% with the trade', { ...NOW, breadth: 0.4, breadthCoins: all }],
        ['breadth >= 50% with the trade', { ...NOW, breadth: 0.5, breadthCoins: all }],
        ...halves(['majority', { breadth: 'majority', breadthCoins: all }], ['>= 30%', { breadth: 0.3, breadthCoins: all }])]],
      size: ['Risk by score strength (live setup)', 'PF2_SIZE.md', 'Risk per trade scaled by |score| at entry: the factor multiplies the 2.5% (compound) or $100 (per year). PF in $ terms. Score bands of the live trades are listed below the table.', [
        live,
        ['0.8x <75, 1x 75-84, 1.2x 85+', { ...NOW, riskByScore: [[85, 1.2], [75, 1], [0, 0.8]] }],
        ['0.6x <75, 1x 75-84, 1.4x 85+', { ...NOW, riskByScore: [[85, 1.4], [75, 1], [0, 0.6]] }],
        ['1x <85, 1.3x 85+', { ...NOW, riskByScore: [[85, 1.3], [0, 1]] }],
        ['reverse: 1.2x <75, 1x 75-84, 0.8x 85+', { ...NOW, riskByScore: [[85, 0.8], [75, 1], [0, 1.2]] }],
        ...halves(['0.8/1/1.2', { riskByScore: [[85, 1.2], [75, 1], [0, 0.8]] }])]],
      corr: ['Correlation cap per coin group (live setup)', 'PF2_CORR.md', 'Groups: memes = DOGE, 1000PEPE, 1000BONK; gaming = GALA, SAND, AXS; L1 = SOL, SUI, NEAR, ATOM, EGLD. Cap = max open + pending trades per group (either direction).', [
        live,
        ['memes + gaming: max 2 each', { ...NOW, groups: [MEMES, GAMING], groupMax: 2 }],
        ['memes + gaming: max 1 each', { ...NOW, groups: [MEMES, GAMING], groupMax: 1 }],
        ['memes + gaming + L1: max 2 each', { ...NOW, groups: [MEMES, GAMING, L1], groupMax: 2 }],
        ...halves(['memes+gaming max 2', { groups: [MEMES, GAMING], groupMax: 2 }])]],
      ls: ['Separate entry score for longs and shorts (live setup)', 'PF2_LS.md', 'Min |score| to enter, per direction (live: 65 both).', [
        live,
        ['long 65 / short 70', { ...NOW, minScoreShort: 70 }],
        ['long 70 / short 65', { ...NOW, minScoreLong: 70 }],
        ['long 60 / short 65', { ...NOW, minScoreLong: 60 }],
        ['long 65 / short 60', { ...NOW, minScoreShort: 60 }],
        ...halves(['long 65 / short 70', { minScoreShort: 70 }], ['long 70 / short 65', { minScoreLong: 70 }])]],
    };
    const [title, file, note, V] = parts[PF2_PART];
    let extraNote = note;
    if (PF2_PART === 'size') {
      const base = { ...VARIANTS.find(v => v.focus).rules, ...NOW, start: P.STARTING_BALANCE, margin: P.MARGIN_USDT, leverage: P.LEVERAGE, maxOpen: P.MAX_OPEN_POSITIONS, maxSameDir: P.MAX_SAME_DIRECTION, riskUsd: 100, riskPct: null };
      const r = simulate(series, all, times, base), bands = [[65, 70], [70, 75], [75, 80], [80, 85], [85, 90], [90, 101]];
      extraNote += '\n\nLive trades by |score| at entry ($100 fixed risk, whole period):\nscore    trades  win%    PF    net $';
      for (const [lo, hi] of bands) {
        const T = r.tradeList.filter(x => Math.abs(x.score) >= lo && Math.abs(x.score) < hi);
        const w = T.filter(x => x.pnl > 0).reduce((a, x) => a + x.pnl, 0), l = -T.filter(x => x.pnl <= 0).reduce((a, x) => a + x.pnl, 0);
        extraNote += '\n' + (lo + '-' + (hi > 100 ? 100 : hi - 1)).padEnd(8) + String(T.length).padStart(7) + (T.length ? (T.filter(x => x.pnl > 0).length / T.length * 100).toFixed(0) + '%' : '-').padStart(6) + (l ? (w / l).toFixed(2) : '-').padStart(7) + (w - l).toFixed(0).padStart(9);
      }
    }
    return variantTable(title, V, series, times, start, now, file, extraNote);
  }
  if (COOL_LAB) {
    const NOW = { minScore: 65, limit: { atr: 0.3, hours: 4 }, beBufferPct: 0.2 };
    const n = Math.ceil(config.SYMBOLS.length / 2), A = config.SYMBOLS.slice(0, n), B = config.SYMBOLS.slice(n);
    return variantTable('Per-coin cooldown after a stop-loss (live setup)', [
      ['A  live: no cooldown', { ...NOW }],
      ['12h, same direction', { ...NOW, coolH: 12 }],
      ['24h, same direction', { ...NOW, coolH: 24 }],
      ['48h, same direction', { ...NOW, coolH: 48 }],
      ['24h, both directions', { ...NOW, coolH: 24, coolBothDirs: true }],
      ['24h after any loss, same direction', { ...NOW, coolH: 24, coolAnyLoss: true }],
      ['-- first half of the coins --', null],
      ['live, first half', { ...NOW, coins: A }], ['12h, first half', { ...NOW, coolH: 12, coins: A }], ['24h, first half', { ...NOW, coolH: 24, coins: A }], ['48h, first half', { ...NOW, coolH: 48, coins: A }],
      ['-- second half of the coins --', null],
      ['live, second half', { ...NOW, coins: B }], ['12h, second half', { ...NOW, coolH: 12, coins: B }], ['24h, second half', { ...NOW, coolH: 24, coins: B }], ['48h, second half', { ...NOW, coolH: 48, coins: B }],
    ], series, times, start, now, 'COOL_LAB.md', 'Live setup (score 65, limit 0.3 ATR 4h, BE +0.2%, ' + config.SYMBOLS.length + ' coins). Cooldown starts when a trade closes on its full stop-loss (not breakeven / T1-lock); "any loss" also counts flip exits in loss.');
  }
  if (DAY_LAB) {
    const NOW = { minScore: 65, limit: { atr: 0.3, hours: 4 }, beBufferPct: 0.2 };
    const n = Math.ceil(config.SYMBOLS.length / 2), A = config.SYMBOLS.slice(0, n), B = config.SYMBOLS.slice(n);
    return variantTable('Daily trend filter (live setup)', [
      ['A  live: no daily filter', { ...NOW }],
      ['1D ATLAS signal must agree', { ...NOW, dAgree: true }],
      ['1D ATLAS signal not against (soft)', { ...NOW, dAgree: 'soft' }],
      ['daily close vs EMA20', { ...NOW, dEma: 20 }],
      ['daily close vs EMA50', { ...NOW, dEma: 50 }],
      ['daily close vs EMA200', { ...NOW, dEma: 200 }],
      ['-- first half of the coins --', null],
      ['live, first half', { ...NOW, coins: A }], ['1D not against, first half', { ...NOW, dAgree: 'soft', coins: A }], ['EMA50, first half', { ...NOW, dEma: 50, coins: A }],
      ['-- second half of the coins --', null],
      ['live, second half', { ...NOW, coins: B }], ['1D not against, second half', { ...NOW, dAgree: 'soft', coins: B }], ['EMA50, second half', { ...NOW, dEma: 50, coins: B }],
    ], series, times, start, now, 'DAY_LAB.md', 'Live setup (score 65, limit 0.3 ATR 4h, BE +0.2%, ' + config.SYMBOLS.length + ' coins). Filters use the last closed daily candle (UTC day): "agree" = the 1D ATLAS score is past +/-25 in the trade direction; "not against" = it is not past +/-25 the other way; EMA = the daily close is above (long) / below (short) its EMA.');
  }
  if (FLIP_LAB) {
    const NOW = { minScore: 65, limit: { atr: 0.3, hours: 4 }, beBufferPct: 0.2 };
    const n = Math.ceil(config.SYMBOLS.length / 2), A = config.SYMBOLS.slice(0, n), B = config.SYMBOLS.slice(n);
    return variantTable('Signal-flip exit only before T1 (live setup)', [
      ['A  live: flip exit always', { ...NOW }],
      ['flip exit only before T1', { ...NOW, flipBeforeT1: true }],
      ['no flip exit (reference)', { ...NOW, noFlip: true }],
      ['-- first half of the coins --', null],
      ['live, first half', { ...NOW, coins: A }], ['before T1, first half', { ...NOW, flipBeforeT1: true, coins: A }],
      ['-- second half of the coins --', null],
      ['live, second half', { ...NOW, coins: B }], ['before T1, second half', { ...NOW, flipBeforeT1: true, coins: B }],
    ], series, times, start, now, 'FLIP_LAB.md', 'Live setup (score 65, limit 0.3 ATR 4h, BE +0.2%, ' + config.SYMBOLS.length + ' coins). "Only before T1": once T1 is hit, an opposite signal no longer closes the trade; the breakeven stop and the T1 lock after T2 manage the rest.');
  }
  if (DROP_CHECK) {
    const NOW = { minScore: 65, limit: { atr: 0.3, hours: 4 }, beBufferPct: 0.2 };
    const base = config.SYMBOLS, n = Math.ceil(base.length / 2), A = base.slice(0, n), B = base.slice(n);
    const without = (list, xs) => list.filter(c => !xs.includes(c));
    const V = [['A  live ' + base.length + ' coins', { ...NOW }]];
    for (const c of CANDIDATES) V.push(['- ' + c.replace('USDT', ''), { ...NOW, coins: without(base, [c]) }]);
    if (CANDIDATES.length > 1) V.push(['- ' + CANDIDATES.map(c => c.replace('USDT', '')).join(' - '), { ...NOW, coins: without(base, CANDIDATES) }]);
    for (const [name, half] of [['first', A], ['second', B]]) {
      const hit = CANDIDATES.filter(c => half.includes(c));
      if (!hit.length) continue;
      V.push(['-- ' + name + ' half of the live list --', null], [name + ' half', { ...NOW, coins: half }], [name + ' half - ' + hit.map(c => c.replace('USDT', '')).join(' - '), { ...NOW, coins: without(half, hit) }]);
    }
    return variantTable('Removing ' + CANDIDATES.map(c => c.replace('USDT', '')).join(' / ') + ' from the live coins (live setup)', V, series, times, start, now, 'DROP_CHECK.md',
      'Live setup: score 65, limit 0.3 ATR 4h, BE +0.2%, 2.5% risk, max 5 open / 4 per direction / 3 per candle. The half check repeats the removal on the half of the list that holds the coin.');
  }
  if (ADD_CHECK) {
    const NOW = { minScore: 65, limit: { atr: 0.3, hours: 4 }, beBufferPct: 0.2 };
    const add = CANDIDATES.filter(c => series[c]), base = config.SYMBOLS, n = Math.ceil(base.length / 2);
    const A = base.slice(0, n), B = base.slice(n);
    const V = [['A  live ' + base.length + ' coins', { ...NOW }]];
    for (const c of add) V.push(['+ ' + c.replace('USDT', ''), { ...NOW, coins: [...base, c] }]);
    if (add.length > 1) V.push(['+ ' + add.map(c => c.replace('USDT', '')).join(' + '), { ...NOW, coins: [...base, ...add] }]);
    V.push(['-- first half of the live list --', null], ['first half', { ...NOW, coins: A }], ['first half + new', { ...NOW, coins: [...A, ...add] }]);
    V.push(['-- second half of the live list --', null], ['second half', { ...NOW, coins: B }], ['second half + new', { ...NOW, coins: [...B, ...add] }]);
    return variantTable('Adding ' + add.map(c => c.replace('USDT', '')).join(' + ') + ' to the live coins (live setup)', V, series, times, start, now, 'ADD_CHECK.md',
      'Live setup: score 65, limit 0.3 ATR 4h, BE +0.2%, 2.5% risk, max 5 open / 4 per direction / 3 per candle. The halves check whether the new coins help on a different base list.');
  }
  if (NEW_COINS) return newCoinsLive(series, symbols.filter(s => CANDIDATES.includes(s) && !config.SYMBOLS.includes(s)), times, start, now);
  if (SCORE_NOW) {
    const L = (minScore, coins) => ({ minScore, limit: { atr: 0.3, hours: 4 }, beBufferPct: 0.2, ...(coins ? { coins } : {}) });
    const A = config.SYMBOLS.slice(0, 11), B = config.SYMBOLS.slice(11);
    return variantTable('Entry score on the current live setup (limit 0.3 ATR 4h, breakeven +0.2%)', [
      ['score 50', L(50)],
      ['score 55', L(55)],
      ['score 60', L(60)],
      ['A  score 65 (live)', L(65)],
      ['score 70', L(70)],
      ['-- first half of the coins --', null],
      ['55, first half', L(55, A)], ['60, first half', L(60, A)], ['65, first half', L(65, A)],
      ['-- second half of the coins --', null],
      ['55, second half', L(55, B)], ['60, second half', L(60, B)], ['65, second half', L(65, B)],
    ], series, times, start, now, 'SCORE_NOW.md', 'Everything else as live: 2.5% risk, max 5 open / 4 per direction / 3 per candle, 1.5/2.5/3.5R closing 25/25/50%, BTC filter, fees.');
  }
  if (STREAK_ROB) {
    const NOW = { minScore: 65, limit: { atr: 0.3, hours: 4 }, beBufferPct: 0.2 };
    const SP = (n, hours) => ({ ...NOW, streakPause: { n, hours } });
    const A = config.SYMBOLS.slice(0, 11), B = config.SYMBOLS.slice(11);
    return variantTable('Robustness of "5 losses in a row -> 48h pause" (live setup)', [
      ['A  live now, no pause', NOW],
      ['5 losses -> 48h pause', SP(5, 48)],
      ['-- neighbours --', null],
      ['5 losses -> 24h', SP(5, 24)],
      ['5 losses -> 36h', SP(5, 36)],
      ['5 losses -> 72h', SP(5, 72)],
      ['4 losses -> 48h', SP(4, 48)],
      ['6 losses -> 48h', SP(6, 48)],
      ['6 losses -> 72h', SP(6, 72)],
      ['-- each half of the coin list --', null],
      ['live, first half', { ...NOW, coins: A }],
      ['5 -> 48h, first half', { ...SP(5, 48), coins: A }],
      ['live, second half', { ...NOW, coins: B }],
      ['5 -> 48h, second half', { ...SP(5, 48), coins: B }],
    ], series, times, start, now, 'STREAK_ROBUST.md', 'Pause: after n losing trades in a row, no new entries for the given hours (open trades keep running).');
  }
  if (STOP_LAB) {
    const NOW = { minScore: 65, limit: { atr: 0.3, hours: 4 }, beBufferPct: 0.2 };
    const A = config.SYMBOLS.slice(0, 11), B = config.SYMBOLS.slice(11);
    return variantTable('Stop width, neutral-score exit, losing-streak pause (live setup)', [
      ['A  live now (stop 1.5 ATR)', NOW],
      ['-- 1. stop width (x ATR, or the Chandelier stop if wider) --', null],
      ['stop 1.5 ATR (same rule, re-sized: check)', { ...NOW, stopAtr: 1.5 }],
      ['stop 1.25 ATR', { ...NOW, stopAtr: 1.25 }],
      ['stop 2 ATR', { ...NOW, stopAtr: 2 }],
      ['stop 2.5 ATR', { ...NOW, stopAtr: 2.5 }],
      ['-- 2. close when the score falls back inside +/-25 --', null],
      ['neutral score closes the trade', { ...NOW, neutralExit: 'all' }],
      ['neutral score closes it only before T1', { ...NOW, neutralExit: 'beforeT1' }],
      ['-- 3. pause after losing streaks --', null],
      ['3 losses in a row -> 24h pause', { ...NOW, streakPause: { n: 3, hours: 24 } }],
      ['4 losses in a row -> 24h pause', { ...NOW, streakPause: { n: 4, hours: 24 } }],
      ['5 losses in a row -> 48h pause', { ...NOW, streakPause: { n: 5, hours: 48 } }],
      ['-- each half of the coin list (live / stop 2 ATR) --', null],
      ['live, first half', { ...NOW, coins: A }],
      ['stop 2 ATR, first half', { ...NOW, stopAtr: 2, coins: A }],
      ['live, second half', { ...NOW, coins: B }],
      ['stop 2 ATR, second half', { ...NOW, stopAtr: 2, coins: B }],
    ], series, times, start, now, 'STOP_LAB.md', 'Same dollar risk per trade in every row: a wider stop means a smaller position. Targets stay at 1.5/2.5/3.5 x the (new) stop distance.');
  }
  if (LIVE_NOW) {
    const NOW = { minScore: 65, limit: { atr: 0.3, hours: 4 }, beBufferPct: 0.2 };
    return variantTable('Current live setup (score 65, pullback limit 0.3 ATR / 4h, breakeven +0.2%)', [
      ['LIVE NOW: 65 + limit 0.3 ATR 4h + BE +0.2%', NOW],
      ['-- earlier setups --', null],
      ['score 50, market entry (setup of 30 Sep)', { beBufferPct: 0 }],
      ['score 65, market entry', { minScore: 65 }],
      ['score 65 + limit 0.3 ATR 4h (BE at entry)', { minScore: 65, limit: { atr: 0.3, hours: 4 } }],
      ['-- live now with more slots --', null],
      ['live now, 6 open / 4 per direction', { ...NOW, maxOpen: 6, maxSameDir: 4 }],
      ['live now, 6 open / 5 per direction', { ...NOW, maxOpen: 6, maxSameDir: 5 }],
      ['live now, 7 open / 5 per direction', { ...NOW, maxOpen: 7, maxSameDir: 5 }],
      ['live now, 8 open / 6 per direction', { ...NOW, maxOpen: 8, maxSameDir: 6 }],
      ['-- live now, each half of the coin list --', null],
      ['live now, first half', { ...NOW, coins: config.SYMBOLS.slice(0, 11) }],
      ['live now, second half', { ...NOW, coins: config.SYMBOLS.slice(11) }],
    ], series, times, start, now, 'LIVE_NOW.md', 'All rows: 21 coins (unless noted), 2.5% risk, max 5 open / 4 per direction / 3 per candle, targets 1.5/2.5/3.5R closing 25/25/50%, stop to breakeven after T1 and to T1 after T2, BTC filter, fees.');
  }
  if (LIMIT_ROB) {
    const M = { minScore: 65 }, L = (atr, hours) => ({ ...M, limit: { atr, hours } });
    const A = config.SYMBOLS.slice(0, 11), B = config.SYMBOLS.slice(11);
    return variantTable('Robustness of the pullback limit entry (entry score 65)', [
      ['A  live: market entry', M],
      ['limit 0.2 ATR, valid 4h', L(0.2, 4)],
      ['limit 0.25 ATR, valid 4h', L(0.25, 4)],
      ['limit 0.3 ATR, valid 4h', L(0.3, 4)],
      ['limit 0.25 ATR, valid 2h', L(0.25, 2)],
      ['limit 0.25 ATR, valid 8h', L(0.25, 8)],
      ['-- each half of the coin list --', null],
      ['market entry, first half', { ...M, coins: A }],
      ['limit 0.25 ATR 4h, first half', { ...L(0.25, 4), coins: A }],
      ['market entry, second half', { ...M, coins: B }],
      ['limit 0.25 ATR 4h, second half', { ...L(0.25, 4), coins: B }],
    ], series, times, start, now, 'LIMIT_ROBUST.md', 'Limit entries: an order 0.2-0.3 x ATR better than the signal close, filled with maker fee if price trades through it before it expires.');
  }
  if (SCORE_RISE) {
    // n / p1 / p2 = score now, 1 and 2 candles ago, in the trade's direction (a short's falling score counts as rising)
    return variantTable('Score >= 65 and still moving the trade\'s way', [
      ['A  live: score >= 65', { entryFn: (n) => n >= 65 }],
      ['>= 65 and higher than 1 candle ago', { entryFn: (n, p1) => n >= 65 && n > p1 }],
      ['>= 65 and not lower than 1 candle ago', { entryFn: (n, p1) => n >= 65 && n >= p1 }],
      ['>= 65 and up 5+ vs 1 candle ago', { entryFn: (n, p1) => n >= 65 && n - p1 >= 5 }],
      ['>= 65 and up 10+ vs 1 candle ago', { entryFn: (n, p1) => n >= 65 && n - p1 >= 10 }],
      ['>= 65 and rising 2 candles in a row', { entryFn: (n, p1, p2) => n >= 65 && n > p1 && p1 > p2 }],
      ['>= 65 and higher than 2 candles ago', { entryFn: (n, p1, p2) => n >= 65 && n > p2 }],
      ['-- opposite (control) --', null],
      ['>= 65 but lower than 1 candle ago', { entryFn: (n, p1) => n >= 65 && n < p1 }],
    ], series, times, start, now, 'SCORE_RISE.md', 'Scores in the trade direction: for a short, a score going from -60 to -75 counts as rising. The control row takes only the trades the rule would skip.');
  }
  if (PF_LAB) {
    const M = { minScore: 65 };
    return variantTable('PF lab: pullback entry, volatility filter, time filter (entry score 65)', [
      ['A  live: market entry, no filters', M],
      ['-- 1. pullback limit entry --', null],
      ['limit 0.25 ATR better, valid 4h', { ...M, limit: { atr: 0.25, hours: 4 } }],
      ['limit 0.5 ATR better, valid 4h', { ...M, limit: { atr: 0.5, hours: 4 } }],
      ['limit 0.5 ATR better, valid 12h', { ...M, limit: { atr: 0.5, hours: 12 } }],
      ['limit 1 ATR better, valid 12h', { ...M, limit: { atr: 1, hours: 12 } }],
      ['-- 2. volatility (ATR% vs coin\'s 50-candle average) --', null],
      ['skip when ATR > 1.5x normal', { ...M, volBand: { hi: 1.5, n: 50 } }],
      ['skip when ATR > 2x normal', { ...M, volBand: { hi: 2, n: 50 } }],
      ['skip when ATR < 0.7x normal', { ...M, volBand: { lo: 0.7, n: 50 } }],
      ['only 0.7x - 1.5x normal', { ...M, volBand: { lo: 0.7, hi: 1.5, n: 50 } }],
      ['-- 3. time --', null],
      ['no weekend entries (Sat/Sun UTC)', { ...M, noWeekend: true }],
      ['skip 00 + 04 UTC closes (night)', { ...M, skipCloseHours: [0, 4] }],
      ['skip 20 + 00 UTC closes (US evening)', { ...M, skipCloseHours: [20, 0] }],
    ], series, times, start, now, 'PF_LAB.md', 'Limit entries fill at the limit price with maker fee; unfilled ones expire. Volatility = the coin\'s 4H ATR% against its own average of the previous 50 signal candles. Time filters use the signal candle\'s close in UTC (your time = UTC+2).');
  }
  if (SCORE_JUMP_ROB) {
    return variantTable('Robustness of the +40 score jump', [
      ['A  live: score >= 65', { entryFn: (n) => n >= 65 }],
      ['jump +40', { entryFn: (n, p1) => n - p1 >= 40 }],
      ['jump +40, coins: first half', { entryFn: (n, p1) => n - p1 >= 40, coins: config.SYMBOLS.slice(0, 11) }],
      ['live 65, coins: first half', { entryFn: (n) => n >= 65, coins: config.SYMBOLS.slice(0, 11) }],
      ['jump +40, coins: second half', { entryFn: (n, p1) => n - p1 >= 40, coins: config.SYMBOLS.slice(11) }],
      ['live 65, coins: second half', { entryFn: (n) => n >= 65, coins: config.SYMBOLS.slice(11) }],
    ], series, times, start, now, 'SCORE_JUMP_ROBUST.md', 'Neighbouring jump sizes, extra conditions, other slot / filter settings, and each half of the coin list on its own.');
  }
  if (SCORE_JUMP) {
    // entryFn(now, 1 candle ago, 2 candles ago): scores in the trade's direction
    return variantTable('Score jump: enter when the score rises N+ in one 4H candle', [
      ['A  live: score >= 65', { entryFn: (n) => n >= 65 }],
      ['jump +30 in 1 candle (score >= 25)', { entryFn: (n, p1) => n - p1 >= 30 }],
      ['jump +20 in 1 candle', { entryFn: (n, p1) => n - p1 >= 20 }],
      ['jump +40 in 1 candle', { entryFn: (n, p1) => n - p1 >= 40 }],
      ['jump +30 and score >= 50', { entryFn: (n, p1) => n - p1 >= 30 && n >= 50 }],
      ['jump +30 and score >= 65', { entryFn: (n, p1) => n - p1 >= 30 && n >= 65 }],
      ['score >= 65 OR jump +30', { entryFn: (n, p1) => n >= 65 || n - p1 >= 30 }],
      ['score >= 65 OR (jump +30 and score >= 50)', { entryFn: (n, p1) => n >= 65 || (n - p1 >= 30 && n >= 50) }],
    ], series, times, start, now, 'SCORE_JUMP.md', 'Scores are taken in the trade direction (a short\'s score counted positive). "jump" = this 4H candle\'s score minus the previous one.');
  }
  if (TIME_STOP) {
    const M = { minScore: 65 };
    return variantTable('Time stop: close when T1 not reached after N hours (entry score 65)', [
      ['A  live: no time stop', M],
      ['close after 12h without T1', { ...M, timeStopH: 12 }],
      ['close after 24h without T1', { ...M, timeStopH: 24 }],
      ['close after 36h without T1', { ...M, timeStopH: 36 }],
      ['close after 48h without T1', { ...M, timeStopH: 48 }],
      ['close after 72h without T1', { ...M, timeStopH: 72 }],
      ['-- only when the trade is in loss --', null],
      ['24h without T1 and in loss', { ...M, timeStopH: 24, timeStopLossOnly: true }],
      ['48h without T1 and in loss', { ...M, timeStopH: 48, timeStopLossOnly: true }],
    ], series, times, start, now, 'TIME_STOP.md', 'Time stop: a trade still short of T1 after N hours is closed at market (taker fee). Checked hourly, like the live bot.');
  }
  if (BTC_LINE) {
    const M = { minScore: 65 };
    return variantTable('Stricter BTC filter (entry score 65)', [
      ['A  live: blocks only when BTC points against (|BTC| >= 25)', M],
      ['shorts only when BTC < 0 (longs as live)', { ...M, btcLine: { shortMax: 0 } }],
      ['shorts only when BTC <= -25 (longs as live)', { ...M, btcLine: { shortMax: -25 } }],
      ['shorts BTC < 0, longs BTC > 0', { ...M, btcLine: { shortMax: 0, longMin: 0 } }],
      ['BTC must agree: shorts <= -25, longs >= +25', { ...M, btcLine: { shortMax: -25, longMin: 25 } }],
      ['shorts BTC < +10, longs BTC > -10', { ...M, btcLine: { shortMax: 10, longMin: -10 } }],
      ['-- reference --', null],
      ['BTC filter off', { ...M, btcFilter: false }],
    ], series, times, start, now, 'BTC_LINE.md', 'Live filter: no trade against BTC when BTC\'s 4H score is beyond +/-25 (neutral BTC allows both). Variants add a line BTC must be on.');
  }
  if (BTC_COOL) {
    const M = { minScore: 65 };
    return variantTable('BTC cool-down after a strong BTC score (entry score 65)', [
      ['A  live: score 65, BTC filter', M],
      ['BTC >= +65: no longs until BTC < +25 (mirror shorts)', { ...M, btcCool: { hi: 65, lo: 25 } }],
      ['same, but no trades at all until it cools', { ...M, btcCool: { hi: 65, lo: 25, all: true } }],
      ['BTC >= +75 -> wait under +25', { ...M, btcCool: { hi: 75, lo: 25 } }],
      ['BTC >= +65 -> wait under +40', { ...M, btcCool: { hi: 65, lo: 40 } }],
      ['BTC >= +55 -> wait under +25', { ...M, btcCool: { hi: 55, lo: 25 } }],
      ['-- reference --', null],
      ['score 50 (old live)', {}],
      ['score 50 + BTC >= +65 -> under +25', { btcCool: { hi: 65, lo: 25 } }],
    ], series, times, start, now, 'BTC_COOL.md', 'Cool-down: once BTC\'s 4H score reaches +hi, no new longs until it drops below +lo (shorts mirrored at -hi / -lo). Open trades are untouched.');
  }
  if (SLOTS) return variantTable('Slot limits on the live setup', [
    ['A  live: 5 open, 4 per direction', {}],
    ['3 open, 2 per direction', { maxOpen: 3, maxSameDir: 2 }],
    ['3 open, 3 per direction', { maxOpen: 3, maxSameDir: 3 }],
    ['4 open, 2 per direction', { maxOpen: 4, maxSameDir: 2 }],
    ['4 open, 3 per direction', { maxOpen: 4, maxSameDir: 3 }],
    ['5 open, 3 per direction', { maxOpen: 5, maxSameDir: 3 }],
    ['5 open, 2 per direction', { maxOpen: 5, maxSameDir: 2 }],
    ['6 open, 4 per direction', { maxOpen: 6, maxSameDir: 4 }],
  ], series, times, start, now, 'SLOTS.md');
  if (SPLIT) return variantTable('Close shares at T1 / T2 / T3 (live setup)', [
    ['A  live 20 / 30 / 50', {}],
    ['10 / 30 / 60', { split: [0.1, 0.3, 0.6] }],
    ['25 / 25 / 50', { split: [0.25, 0.25, 0.5] }],
    ['20 / 40 / 40', { split: [0.2, 0.4, 0.4] }],
    ['30 / 30 / 40', { split: [0.3, 0.3, 0.4] }],
    ['33 / 33 / 34', { split: [0.33, 0.33, 0.34] }],
    ['40 / 30 / 30', { split: [0.4, 0.3, 0.3] }],
    ['50 / 25 / 25', { split: [0.5, 0.25, 0.25] }],
    ['50 / 30 / 20', { split: [0.5, 0.3, 0.2] }],
  ], series, times, start, now, 'SPLIT.md');
  if (COMBO) {
    const T = { targetsR: [1.5, 2.5, 3.5] }, R = { cRiskPct: 2.5 }, M = { maxOpen: 5 };
    return variantTable('Tuning combinations on the live coins', [
      ['A  live (1.5/3/4.5R, 3.75%, 7 open)', {}],
      ['risk 2.5%', R],
      ['max 5 open', M],
      ['targets 1.5/2.5/3.5', T],
      ['risk 2.5% + max 5 open', { ...R, ...M }],
      ['risk 2.5% + 1.5/2.5/3.5', { ...R, ...T }],
      ['max 5 open + 1.5/2.5/3.5', { ...M, ...T }],
      ['ALL 3: 2.5% + 5 open + 1.5/2.5/3.5', { ...R, ...M, ...T }],
      ['ALL 3 + no stop to T1 after T2', { ...R, ...M, ...T, lockT1AfterT2: false }],
      ['risk 3% + 5 open + 1.5/2.5/3.5', { cRiskPct: 3, ...M, ...T }],
    ], series, times, start, now, 'COMBO.md');
  }
  if (TUNE) return variantTable('Tuning on the live coins', [
    ['A  live (1.5/3/4.5R, 20/30/50, score 50, 3.75%)', {}],
    ['-- targets (R) --', null],
    ['targets 1 / 2 / 3', { targetsR: [1, 2, 3] }],
    ['targets 1.5 / 2.5 / 3.5', { targetsR: [1.5, 2.5, 3.5] }],
    ['targets 2 / 3 / 4.5', { targetsR: [2, 3, 4.5] }],
    ['targets 2 / 4 / 6', { targetsR: [2, 4, 6] }],
    ['targets 1.5 / 3 / 6', { targetsR: [1.5, 3, 6] }],
    ['targets 1 / 3 / 5', { targetsR: [1, 3, 5] }],
    ['-- close shares at T1/T2/T3 --', null],
    ['close 30 / 30 / 40', { split: [0.3, 0.3, 0.4] }],
    ['close 10 / 30 / 60', { split: [0.1, 0.3, 0.6] }],
    ['close 40 / 35 / 25', { split: [0.4, 0.35, 0.25] }],
    ['close 33 / 33 / 34', { split: [0.33, 0.33, 0.34] }],
    ['-- stops after T1 / T2 --', null],
    ['stop to entry after T2 (not T1)', { breakevenAfter: 't2' }],
    ['no stop to T1 after T2', { lockT1AfterT2: false }],
    ['runner trails 3 ATR after T2', { trail: { after: 't2', atr: 3 } }],
    ['-- min score to enter --', null],
    ['min score 40', { minScore: 40 }],
    ['min score 45', { minScore: 45 }],
    ['min score 55', { minScore: 55 }],
    ['min score 60', { minScore: 60 }],
    ['min score 65', { minScore: 65 }],
    ['-- risk per trade (compound; per year = same % of 2000) --', null],
    ['risk 2%', { cRiskPct: 2 }],
    ['risk 2.5%', { cRiskPct: 2.5 }],
    ['risk 3%', { cRiskPct: 3 }],
    ['risk 4.5%', { cRiskPct: 4.5 }],
    ['risk 5%', { cRiskPct: 5 }],
    ['-- margin cap / leverage --', null],
    ['max margin $200', { margin: 200 }],
    ['max margin $600', { margin: 600 }],
    ['max margin $800', { margin: 800 }],
    ['leverage 5x (same margin cap)', { leverage: 5 }],
    ['leverage 20x (same margin cap)', { leverage: 20 }],
    ['-- slots --', null],
    ['max 5 open', { maxOpen: 5 }],
    ['max 9 open', { maxOpen: 9, maxSameDir: 5 }],
    ['max 3 per direction', { maxSameDir: 3 }],
    ['max 5 per direction', { maxSameDir: 5 }],
    ['max 2 new per candle', { maxNewPerCandle: 2 }],
    ['no per-candle limit', { maxNewPerCandle: null }],
    ['-- protection --', null],
    ['half risk while 30%+ below peak', { ddThrottle: { at: 0.3, factor: 0.5 } }],
    ['BTC filter off', { btcFilter: false }],
  ], series, times, start, now, 'TUNE.md');
  if (COINSET) {
    const set = COINSET.filter(s => series[s]);
    const liveSet = config.SYMBOLS.filter(s => series[s]);
    return variantTable('Coin list comparison', [
      [`live list (${liveSet.length} coins)`, { coins: liveSet }],
      [`your list (${set.length} coins)`, { coins: set }],
      [`your list without BTC filter coins missing`, null],
    ].filter(v => v[1]), series, times, start, now, 'COINSET.md', `your list: ${set.map(s => s.replace('USDT', '')).join(', ')}`);
  }
  if (PER_CANDLE) return variantTable('Max new entries per 4H candle', [
    ['live (no limit)', {}],
    ['max 1 new entry per candle', { maxNewPerCandle: 1 }],
    ['max 2 new entries per candle', { maxNewPerCandle: 2 }],
    ['max 3 new entries per candle', { maxNewPerCandle: 3 }],
    ['max 2 per candle + max 3 per direction', { maxNewPerCandle: 2, maxSameDir: 3 }],
  ], series, times, start, now, 'PER_CANDLE.md');
  if (TF_DAY) return variantTable('1D vs 4H signals', [
    ['4H signals (live)', {}],
    ['1D signals, same rules', { tf: '1D' }],
    ['1D signals, min score 40', { tf: '1D', minScore: 40 }],
    ['1D signals, min score 60', { tf: '1D', minScore: 60 }],
    ['1D signals, targets 1/2/3R', { tf: '1D', targetsR: [1, 2, 3] }],
    ['4H, only with the 1D signal (daily trend)', { dAgree: true }],
    ['4H, only with the 1D signal, min score 40', { dAgree: true, minScore: 40 }],
  ], series, times, start, now, 'TF_DAY.md');
  if (LAB3) return variantTable('Exit and risk combinations', [
    ['A  live', {}],
    ['close 20/30/50%', { split: [0.2, 0.3, 0.5] }],
    ['close 30/30/40%, runner trails 3 ATR after T2', { trail: { after: 't2', atr: 3 } }],
    ['close 20/30/50%, runner trails 3 ATR after T2', { split: [0.2, 0.3, 0.5], trail: { after: 't2', atr: 3 } }],
    ['close 20/30/50%, runner trails 4 ATR after T2', { split: [0.2, 0.3, 0.5], trail: { after: 't2', atr: 4 } }],
    ['close 20/30/50% + half risk 30%+ below peak', { split: [0.2, 0.3, 0.5], ddThrottle: { at: 0.3, factor: 0.5 } }],
    ['close 20/30/50% + max 3 per direction', { split: [0.2, 0.3, 0.5], maxSameDir: 3 }],
    ['20/30/50% + trail 3 ATR + half risk 30%+', { split: [0.2, 0.3, 0.5], trail: { after: 't2', atr: 3 }, ddThrottle: { at: 0.3, factor: 0.5 } }],
    ['20/30/50% + trail 3 ATR + max 3 per dir', { split: [0.2, 0.3, 0.5], trail: { after: 't2', atr: 3 }, maxSameDir: 3 }],
    ['half risk 25%+ below peak', { ddThrottle: { at: 0.25, factor: 0.5 } }],
    ['risk x0.67 while 30%+ below peak', { ddThrottle: { at: 0.3, factor: 0.67 } }],
  ], series, times, start, now, 'EXIT_RISK_COMBOS.md');
  if (LAB2) return lab2(series, symbols, times, start, now);
  if (SCORE_MOM) return scoreMom(series, symbols, times, start, now);
  if (SCORE_LAB) return scoreLab(series, symbols, times, start, now);
  if (TF_COMPARE) return tfCompare(series, symbols, times, start, now);
  if (COIN_WF && CANDIDATES.length) return coinCandidates(series, symbols.filter(s => CANDIDATES.includes(s) && !config.SYMBOLS.includes(s)), times, start, now);
  if (COIN_WF) return coinWalkForward(series, symbols, times, start, now);
  if (COINS) {
    const live = VARIANTS.find(v => v.focus), third = (now - start) / 3;
    const maxOpen = args.includes('--max-open') ? +args[args.indexOf('--max-open') + 1] : undefined;
    let rules = maxOpen ? { ...live.rules, maxOpen, maxSameDir: Math.ceil(maxOpen * 0.6) } : live.rules;
    if (args.includes('--lock-t1')) rules = { ...rules, lockT1AfterT2: true };
    const r = simulate(series, COINS, times, rules);
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

// A value from control/settings.json (the live overrides), else config.js.
function liveSetting(k) {
  try { const v = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'control', 'settings.json'), 'utf8'))[k]; if (v !== undefined) return v; } catch (e) { /* no file */ }
  return config[k];
}

function analyze(series, allSymbols, times, start, end) {
  const symbols = config.SYMBOLS.filter(s => series[s]); // BTC may be loaded for the BTC filter only
  const live = VARIANTS.find(v => v.focus);
  const P = config.PORTFOLIO;
  const rules = { ...live.rules, start: P.STARTING_BALANCE, riskUsd: P.RISK_PCT != null ? null : P.RISK_USDT, riskPct: P.RISK_PCT, margin: P.MARGIN_USDT, leverage: P.LEVERAGE, maxSameDir: P.MAX_SAME_DIRECTION, maxOpen: P.MAX_OPEN_POSITIONS,
    // the live entry rules (control/settings.json wins over config.js; the
    // backtest otherwise ignores that file): min score, pullback limit entry, breakeven buffer
    minScore: liveSetting('ENTRY_MIN_SCORE'), beBufferPct: liveSetting('BREAKEVEN_BUFFER_PCT') || 0, maxAdx: liveSetting('ADX_MAX') || null,
    limit: liveSetting('LIMIT_ENTRY_ATR') > 0 ? { atr: liveSetting('LIMIT_ENTRY_ATR'), hours: liveSetting('LIMIT_ENTRY_HOURS') || 4 } : null };
  process.stderr.write(`analysis rules: min score ${rules.minScore}, limit ${JSON.stringify(rules.limit)}, BE buffer ${rules.beBufferPct}%\n`);
  const r = simulate(series, symbols, times, rules);
  const T = [...r.tradeList].sort((a, b) => a.closedAt - b.closedAt);
  const $ = (x) => (x < 0 ? '-$' : '$') + Math.abs(x).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const sum = (xs) => xs.reduce((a, t) => a + t.pnl, 0);
  const wins = T.filter(t => t.pnl > 1), losses = T.filter(t => t.pnl < -1), flat = T.filter(t => Math.abs(t.pnl) <= 1);
  let ws = 0, ls = 0, maxW = 0, maxL = 0;
  for (const t of T) { if (t.pnl > 1) { ws++; ls = 0; } else if (t.pnl < -1) { ls++; ws = 0; } maxW = Math.max(maxW, ws); maxL = Math.max(maxL, ls); }
  const hold = (xs) => xs.length ? (xs.reduce((a, t) => a + (t.closedAt - t.openedAt), 0) / xs.length / HOUR).toFixed(0) + 'h' : '—';
  const gw = sum(wins), gl = -sum(losses);
  const reached = (k) => T.filter(t => t.path.includes(k)).length;
  const L = [];
  L.push(`# Live setup analysis`, '', `${new Date(start).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)} · ${symbols.length} coins · start ${P.STARTING_BALANCE} USDT · ${P.RISK_PCT != null ? P.RISK_PCT + '% of balance' : '$' + P.RISK_USDT} risk (max $${P.MARGIN_USDT} margin, ${P.LEVERAGE}x) · ${rules.maxOpen} slots, ${rules.maxSameDir} per direction · targets ${rules.targetsR.join(' / ')}R, closing ${rules.split.map(x => Math.round(x * 100)).join(' / ')}% · BTC filter ${rules.btcFilter ? 'on' : 'off'} · fees included`, '');
  L.push('## Overall', '', '| | |', '|---|---:|',
    `| Start → end | ${$(P.STARTING_BALANCE)} → ${$(P.STARTING_BALANCE + r.net)} (${r.returnPct >= 0 ? '+' : ''}${r.returnPct.toFixed(0)}%) |`,
    `| Trades | ${T.length} (${(T.length / ((end - start) / (30 * 24 * HOUR))).toFixed(0)} per month) |`,
    `| Winners / losers / breakeven | ${wins.length} / ${losses.length} / ${flat.length} |`,
    `| Win rate (winners of all trades) | ${(wins.length / T.length * 100).toFixed(0)}% |`,
    `| Profit factor (gross won / gross lost) | ${(gw / gl).toFixed(2)} |`,
    `| Gross won / gross lost | ${$(gw)} / ${$(-gl)} |`,
    `| Average win / average loss | ${$(gw / wins.length)} / ${$(-gl / losses.length)} (${(gw / wins.length / (gl / losses.length)).toFixed(2)} : 1) |`,
    `| Average per trade | ${$(r.net / T.length)} |`,
    `| Biggest win / biggest loss | ${$(Math.max(...T.map(t => t.pnl)))} / ${$(Math.min(...T.map(t => t.pnl)))} |`,
    `| Longest winning / losing streak | ${maxW} / ${maxL} |`,
    `| Biggest drop from a peak | ${r.maxDDPct.toFixed(1)}% |`,
    `| Average time in trade (win / loss) | ${hold(wins)} / ${hold(losses)} |`,
    `| Reached T1 / T2 / T3 | ${reached('T1')} / ${reached('T2')} / ${reached('T3')} of ${T.length} |`, '');
  const exits = {};
  for (const t of T) { const e = t.exit; exits[e] = exits[e] || []; exits[e].push(t); }
  L.push('## How trades ended', '', '| Final exit | Trades | Net |', '|---|---:|---:|',
    ...Object.entries(exits).sort((a, b) => b[1].length - a[1].length).map(([e, xs]) => `| ${e} | ${xs.length} | ${$(sum(xs))} |`), '');
  L.push('## Long vs short', '', '| | Trades | Win rate | Net |', '|---|---:|---:|---:|',
    ...[[1, 'Long'], [-1, 'Short']].map(([b, n]) => { const xs = T.filter(t => t.bias === b); return `| ${n} | ${xs.length} | ${(xs.filter(t => t.pnl > 1).length / (xs.length || 1) * 100).toFixed(0)}% | ${$(sum(xs))} |`; }), '');
  const coins = {};
  for (const t of T) (coins[t.symbol] = coins[t.symbol] || []).push(t);
  L.push('## Per coin', '', '| Coin | Trades | Win rate | Profit factor | Net |', '|---|---:|---:|---:|---:|',
    ...Object.entries(coins).sort((a, b) => sum(b[1]) - sum(a[1])).map(([c, xs]) => {
      const w = xs.filter(t => t.pnl > 0), l = xs.filter(t => t.pnl <= 0);
      return `| ${c.replace('USDT', '')} | ${xs.length} | ${(xs.filter(t => t.pnl > 1).length / xs.length * 100).toFixed(0)}% | ${(sum(w) / (-sum(l) || 1)).toFixed(2)} | ${$(sum(xs))} |`;
    }), '');
  const months = {};
  for (const t of T) (months[new Date(t.closedAt).toISOString().slice(0, 7)] = months[new Date(t.closedAt).toISOString().slice(0, 7)] || []).push(t);
  L.push('## Per month', '', '| Month | Trades | Win rate | Net |', '|---|---:|---:|---:|',
    ...Object.entries(months).sort().map(([m, xs]) => `| ${m} | ${xs.length} | ${(xs.filter(t => t.pnl > 1).length / xs.length * 100).toFixed(0)}% | ${$(sum(xs))} |`), '');
  const years = {};
  for (const t of T) (years[new Date(t.closedAt).toISOString().slice(0, 4)] = years[new Date(t.closedAt).toISOString().slice(0, 4)] || []).push(t);
  if (Object.keys(years).length > 1) {
    let bal = P.STARTING_BALANCE;
    L.push('## Per year', '', '| Year | Coins traded | Trades | Win rate | Profit factor | Net | Balance at year end |', '|---|---:|---:|---:|---:|---:|---:|');
    for (const [y, xs] of Object.entries(years).sort()) {
      const w = xs.filter(t => t.pnl > 0), l = xs.filter(t => t.pnl <= 0);
      bal += sum(xs);
      L.push(`| ${y} | ${new Set(xs.map(t => t.symbol)).size} | ${xs.length} | ${(xs.filter(t => t.pnl > 1).length / xs.length * 100).toFixed(0)}% | ${(sum(w) / (-sum(l) || 1)).toFixed(2)} | ${$(sum(xs))} | ${$(bal)} |`);
    }
    L.push('');
  }
  L.push('Picked partly on this same period (coins, targets, filters), so live results will likely be lower.');
  const md = L.join('\n') + '\n';
  console.log(md);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'ANALYSIS.md'), md);
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

// For each coin (traded alone, live rules otherwise), tries entry-score
// thresholds 30..85 and reports the best one: highest net among thresholds
// with at least MIN_TRADES trades that were profitable in all three equal
// sub-periods ("robust"); if none qualifies, the highest net of any
// threshold with enough trades ("no robust choice — most profitable shown").
function scoreScan(series, symbols, times, start, end) {
  const live = VARIANTS.find(v => v.focus);
  const GRID = [30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85];
  const MIN_TRADES = 15;
  const third = (end - start) / 3;
  const pad = (x, n) => String(x).padStart(n);
  const coinRows = [];
  const detail = [];
  for (const s of symbols) {
    if (s === 'BTCUSDT' && !config.SYMBOLS.includes('BTCUSDT')) continue; // BTC-for-filter only
    const tries = GRID.map((minScore) => {
      const r = simulate(series, [s], times, { ...live.rules, maxOpen: 1, minScore });
      const part = [0, 1, 2].map(k => r.tradeList.filter(t => t.closedAt >= start + k * third && t.closedAt < start + (k + 1) * third).reduce((a, t) => a + t.pnl, 0));
      return { minScore, trades: r.trades, win: r.winRate * 100, net: r.net, pf: r.profitFactor, dd: r.maxDDPct, part, robust: r.trades >= MIN_TRADES && part.every(x => x > 0) };
    });
    const eligible = tries.filter(t => t.trades >= MIN_TRADES);
    const robust = tries.filter(t => t.robust).sort((a, b) => b.net - a.net);
    const best = robust[0] || eligible.slice().sort((a, b) => b.net - a.net)[0] || tries[tries.length - 1];
    coinRows.push({ s, best, hasRobust: robust.length > 0, live: config.SYMBOLS.includes(s), liveScore: config.ENTRY_MIN_SCORE });
    detail.push({ s, tries });
  }
  coinRows.sort((a, b) => b.best.net - a.best.net);

  const lines = [];
  lines.push(`Score scan, live rules (${live.name.replace(' (live now)', '')}), one coin at a time, ${new Date(start).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)}`);
  lines.push(`Grid tried: ${GRID.join(', ')}. "Robust" = >= ${MIN_TRADES} trades and profitable in each of the 3 sub-periods. Current live entry score: ${config.ENTRY_MIN_SCORE} for all coins.`, '');
  lines.push('coin'.padEnd(10) + pad('best', 6) + pad('trades', 7) + pad('win%', 6) + pad('net $', 8) + pad('PF', 6) + pad('maxDD%', 8) + pad('1/3', 8) + pad('2/3', 8) + pad('3/3', 8) + '  robust?');
  for (const r of coinRows) {
    const b = r.best;
    lines.push((r.s.replace('USDT', '') + (r.live ? '' : ' *')).padEnd(10) + pad(b.minScore, 6) + pad(b.trades, 7) + pad(b.win.toFixed(0), 6) + pad(b.net.toFixed(0), 8) +
      pad(b.pf == null ? '—' : b.pf.toFixed(2), 6) + pad(b.dd.toFixed(1), 8) + b.part.map(x => pad(x.toFixed(0), 8)).join('') + '  ' + (r.hasRobust ? 'yes' : 'no robust choice — most profitable shown'));
  }
  lines.push('', '* = not currently traded live', '');
  lines.push('## Full grid per coin', '');
  for (const d of detail) {
    lines.push(`### ${d.s.replace('USDT', '')}`, '');
    lines.push('score'.padEnd(7) + pad('trades', 7) + pad('win%', 6) + pad('net $', 8) + pad('PF', 6) + pad('maxDD%', 8) + pad('1/3', 8) + pad('2/3', 8) + pad('3/3', 8));
    for (const t of d.tries) {
      lines.push(String(t.minScore).padEnd(7) + pad(t.trades, 7) + pad(t.win.toFixed(0), 6) + pad(t.net.toFixed(0), 8) +
        pad(t.pf == null ? '—' : t.pf.toFixed(2), 6) + pad(t.dd.toFixed(1), 8) + t.part.map(x => pad(x.toFixed(0), 8)).join('') + (t.robust ? '  *' : ''));
    }
    lines.push('');
  }
  console.log(lines.slice(0, lines.indexOf('## Full grid per coin')).join('\n'));
  console.log(`\n(full per-score grid for every coin written to backtest/SCORE_SCAN.md)`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'SCORE_SCAN.md'), '# Entry-score scan\n\n```\n' + lines.join('\n') + '\n```\n');
}

function coinWalkForward(series, symbols, times, start, end) {
  const live = VARIANTS.find(v => v.focus);
  const P = config.PORTFOLIO;
  const coins = config.SYMBOLS;
  const pad = (x, n) => String(x).padStart(n);
  const base = { ...live.rules, start: P.STARTING_BALANCE, margin: P.MARGIN_USDT, leverage: P.LEVERAGE, maxOpen: P.MAX_OPEN_POSITIONS, maxSameDir: P.MAX_SAME_DIRECTION, riskUsd: 100, riskPct: null };
  const y0 = new Date(start).getUTCFullYear(), y1 = new Date(end).getUTCFullYear();
  const years = [];
  for (let y = y0; y <= y1; y++) years.push(y);
  const yearTimes = (y) => times.filter(t => new Date(t).getUTCFullYear() === y);
  const listed = (s, y) => series[s].h1.length && new Date(series[s].h1[0].t).getUTCFullYear() < y; // traded the whole year
  const L = [];
  L.push(`Coin selection · live rules, $100 fixed risk, fresh 2000 USDT each year · ${new Date(start).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)}`, '');
  // 1) each coin alone, per year
  const solo = {};
  L.push('1) Each coin traded alone — net $ per year (blank = not listed yet / partial first year skipped)', '');
  L.push('coin'.padEnd(10) + years.map(y => pad(y, 8)).join('') + pad('years +', 9) + pad('total', 9) + pad('PF', 6));
  for (const s of coins) {
    solo[s] = {};
    let w = 0, n = 0, tot = 0, gw = 0, gl = 0;
    for (const y of years) {
      if (!listed(s, y)) continue;
      const r = simulate(series, [s], yearTimes(y), { ...base, maxOpen: 1 });
      solo[s][y] = r.net; n++; if (r.net > 0) w++; tot += r.net;
      for (const t of r.tradeList) { if (t.pnl > 0) gw += t.pnl; else gl -= t.pnl; }
    }
    L.push(s.replace('USDT', '').padEnd(10) + years.map(y => pad(solo[s][y] == null ? '' : solo[s][y].toFixed(0), 8)).join('') + pad(`${w}/${n}`, 9) + pad(tot.toFixed(0), 9) + pad(gl ? (gw / gl).toFixed(2) : '-', 6));
  }
  // 2) walk-forward selection vs all coins, portfolio per year
  L.push('', '2) Portfolio per year: all coins vs coins picked by their record in the years before', '');
  const strategies = {
    'all coins': () => true,
    'past record > 0 (new coins in)': (s, y) => { const past = years.filter(p => p < y && solo[s][p] != null); return !past.length || past.reduce((a, p) => a + solo[s][p], 0) > 0; },
    'past record > 0 (new coins out)': (s, y) => { const past = years.filter(p => p < y && solo[s][p] != null); return past.length > 0 && past.reduce((a, p) => a + solo[s][p], 0) > 0; },
    'last year > 0 (new coins in)': (s, y) => solo[s][y - 1] == null || solo[s][y - 1] > 0,
  };
  const head = 'selection'.padEnd(34) + years.slice(1).map(y => pad(y, 8)).join('') + pad('total', 9) + pad('avg DD', 8);
  L.push(head);
  for (const [name, pick] of Object.entries(strategies)) {
    let tot = 0, dds = [];
    const cells = years.slice(1).map((y) => {
      const list = coins.filter(s => series[s].h1.length && new Date(series[s].h1[0].t).getUTCFullYear() <= y && pick(s, y));
      if (!list.length) return pad('-', 8);
      const r = simulate(series, list, yearTimes(y), base);
      tot += r.net; dds.push(r.maxDDPct);
      return pad(r.net.toFixed(0), 8);
    });
    L.push(name.padEnd(34) + cells.join('') + pad(tot.toFixed(0), 9) + pad((dds.reduce((a, x) => a + x, 0) / dds.length).toFixed(1) + '%', 8));
  }
  L.push('', 'Selections only use results from earlier years (walk-forward). BTC is always loaded for the BTC filter.');
  const out = L.join('\n');
  console.log(out);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'COIN_WF.md'), '# Coin selection, walk-forward\n\n```\n' + out + '\n```\n');
}

// Candidate coins: each alone per year, then the live list with candidates
// added — all of them, or only those with a good record in earlier years
// (walk-forward), or picked on the whole period (in-sample, optimistic).
function coinCandidates(series, cands, times, start, end) {
  const live = VARIANTS.find(v => v.focus);
  const P = config.PORTFOLIO;
  const pad = (x, n) => String(x).padStart(n);
  const base = { ...live.rules, start: P.STARTING_BALANCE, margin: P.MARGIN_USDT, leverage: P.LEVERAGE, maxOpen: P.MAX_OPEN_POSITIONS, maxSameDir: P.MAX_SAME_DIRECTION, riskUsd: 100, riskPct: null };
  const y0 = new Date(start).getUTCFullYear(), y1 = new Date(end).getUTCFullYear();
  const years = [];
  for (let y = y0; y <= y1; y++) years.push(y);
  const yearTimes = (y) => times.filter(t => new Date(t).getUTCFullYear() === y);
  const listed = (s, y) => series[s].h1.length && new Date(series[s].h1[0].t).getUTCFullYear() < y;
  const all = [...config.SYMBOLS, ...cands];
  const solo = {}, stat = {};
  for (const s of all) {
    process.stderr.write(`solo ${s}\n`);
    solo[s] = {};
    let w = 0, n = 0, tot = 0, gw = 0, gl = 0, tr = 0;
    for (const y of years) {
      if (!listed(s, y)) continue;
      const r = simulate(series, [s], yearTimes(y), { ...base, maxOpen: 1 });
      solo[s][y] = r.net; n++; if (r.net > 0) w++; tot += r.net; tr += r.trades;
      for (const t of r.tradeList) { if (t.pnl > 0) gw += t.pnl; else gl -= t.pnl; }
    }
    stat[s] = { w, n, tot, pf: gl ? gw / gl : null, tr };
  }
  const L = [];
  L.push(`Candidate coins · live rules, $100 fixed risk, fresh 2000 USDT each year · ${new Date(start).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)}`, '');
  const row = (s) => s.replace('USDT', '').padEnd(10) + years.map(y => pad(solo[s][y] == null ? '' : solo[s][y].toFixed(0), 8)).join('') + pad(`${stat[s].w}/${stat[s].n}`, 9) + pad(stat[s].tot.toFixed(0), 9) + pad(stat[s].pf == null ? '-' : stat[s].pf.toFixed(2), 6) + pad(stat[s].tr, 7);
  const head = 'coin'.padEnd(10) + years.map(y => pad(y, 8)).join('') + pad('years +', 9) + pad('total', 9) + pad('PF', 6) + pad('trades', 7);
  const rank = (a, b) => (stat[b].n ? stat[b].w / stat[b].n : 0) - (stat[a].n ? stat[a].w / stat[a].n : 0) || stat[b].tot - stat[a].tot;
  L.push('1) Candidates traded alone — net $ per full year (first partial year skipped), best record first', '', head);
  for (const s of cands.filter(s => stat[s].n).sort(rank)) L.push(row(s));
  const none = cands.filter(s => !stat[s].n);
  if (none.length) L.push('', 'Listed too recently for a full year: ' + none.map(s => s.replace('USDT', '')).join(', '));
  L.push('', 'Live coins for comparison', '', head);
  for (const s of config.SYMBOLS.filter(s => stat[s].n).sort(rank)) L.push(row(s));
  // 2) portfolio per year
  const pastOk = (s, y) => { const past = years.filter(p => p < y && solo[s][p] != null); return past.length > 0 && past.reduce((a, p) => a + solo[s][p], 0) > 0 && past.filter(p => solo[s][p] > 0).length * 2 >= past.length; };
  const inSample = cands.filter(s => stat[s].n >= 2 && stat[s].w / stat[s].n >= 0.66 && stat[s].pf >= 1.15);
  const noBtc = config.SYMBOLS.filter(s => s !== 'BTCUSDT');
  // Walk-forward top N: candidates with at least 2 full years before y, all
  // (or all but one) profitable, ranked by past profit per year.
  const bestPast = (y, n) => cands.map(s => {
    const past = years.filter(p => p < y && solo[s][p] != null);
    const w = past.filter(p => solo[s][p] > 0).length;
    return { s, ok: past.length >= 2 && w >= past.length - (past.length >= 4 ? 1 : 0), avg: past.reduce((a, p) => a + solo[s][p], 0) / (past.length || 1) };
  }).filter(x => x.ok && x.avg > 0).sort((a, b) => b.avg - a.avg).slice(0, n).map(x => x.s);
  const topSolo = cands.filter(s => stat[s].n >= 3).sort((a, b) => stat[b].tot / stat[b].n - stat[a].tot / stat[a].n).filter(s => stat[s].w >= stat[s].n - 1).slice(0, 6);
  const strategies = {
    'live': () => config.SYMBOLS,
    'live + all candidates': () => all,
    'live + candidates, past record good': (y) => [...config.SYMBOLS, ...cands.filter(s => pastOk(s, y))],
    'live without BTC + past record good': (y) => [...noBtc, ...cands.filter(s => pastOk(s, y))],
    'live without BTC': () => noBtc,
    'live + best 2 by past record': (y) => [...config.SYMBOLS, ...bestPast(y, 2)],
    'live + best 4 by past record': (y) => [...config.SYMBOLS, ...bestPast(y, 4)],
    'live + best 6 by past record': (y) => [...config.SYMBOLS, ...bestPast(y, 6)],
    'live without BTC + best 4 by past record': (y) => [...noBtc, ...bestPast(y, 4)],
    ...Object.fromEntries(topSolo.map(s => [`live + ${s.replace('USDT', '')} only`, () => [...config.SYMBOLS, s]])),
    'live + in-sample picks': () => [...config.SYMBOLS, ...inSample],
    'live without BTC + in-sample picks': () => [...noBtc, ...inSample],
  };
  L.push('', '2) Portfolio per year (7 slots, max 4 per direction) — "past record good" only uses earlier years', '');
  L.push('selection'.padEnd(40) + years.slice(1).map(y => pad(y, 8)).join('') + pad('total', 9) + pad('avg DD', 8) + pad('PF', 6));
  for (const [name, pick] of Object.entries(strategies)) {
    process.stderr.write(`portfolio ${name}\n`);
    let tot = 0, gw = 0, gl = 0; const dds = [];
    const cells = years.slice(1).map((y) => {
      const list = pick(y).filter(s => series[s] && series[s].h1.length && new Date(series[s].h1[0].t).getUTCFullYear() <= y);
      const r = simulate(series, list, yearTimes(y), base);
      tot += r.net; dds.push(r.maxDDPct);
      for (const t of r.tradeList) { if (t.pnl > 0) gw += t.pnl; else gl -= t.pnl; }
      return pad(r.net.toFixed(0), 8);
    });
    L.push(name.padEnd(40) + cells.join('') + pad(tot.toFixed(0), 9) + pad((dds.reduce((a, x) => a + x, 0) / dds.length).toFixed(1) + '%', 8) + pad((gw / gl).toFixed(2), 6));
  }
  L.push('', `In-sample picks (≥ 2/3 of years profitable, PF ≥ 1.15, whole period — optimistic): ${inSample.map(s => s.replace('USDT', '')).join(', ') || 'none'}`);
  L.push(`Best 4 by past record, per year: ${years.slice(1).map(y => y + ' ' + bestPast(y, 4).map(s => s.replace('USDT', '')).join('/')).join(' · ')} · next year ${bestPast(y1 + 1, 4).map(s => s.replace('USDT', '')).join('/')}`);
  L.push(`Picked for next year by past record (all years so far, needs a full year): ${cands.filter(s => pastOk(s, y1 + 1)).map(s => s.replace('USDT', '')).join(', ') || 'none'}`);
  const out = L.join('\n');
  console.log(out);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'COIN_CANDIDATES.md'), '# Candidate coins\n\n```\n' + out + '\n```\n');
}

function lab2(series, symbols, times, start, end) {
  const V = [
    ['A  live', {}],
    ['-- exits --', null],
    ['BE after T2 (not T1)', { breakevenAfter: 't2' }],
    ['no stop to T1 after T2', { lockT1AfterT2: false }],
    ['runner trails 2 ATR after T2 (no T3)', { trail: { after: 't2', atr: 2 } }],
    ['runner trails 3 ATR after T2 (no T3)', { trail: { after: 't2', atr: 3 } }],
    ['runner trails 2.5 ATR after T1 (no T3)', { trail: { after: 't1', atr: 2.5 } }],
    ['close if no T1 after 48h', { timeStopH: 48 }],
    ['close if no T1 after 96h', { timeStopH: 96 }],
    ['close 50/30/20% at T1/T2/T3', { split: [0.5, 0.3, 0.2] }],
    ['close 20/30/50% at T1/T2/T3', { split: [0.2, 0.3, 0.5] }],
    ['-- bad years --', null],
    ['half risk while 20%+ below peak', { ddThrottle: { at: 0.2, factor: 0.5 } }],
    ['half risk while 30%+ below peak', { ddThrottle: { at: 0.3, factor: 0.5 } }],
    ['pause 24h after 4 losses in a row', { streakPause: { n: 4, hours: 24 } }],
    ['pause 48h after 6 losses in a row', { streakPause: { n: 6, hours: 48 } }],
    ['only when BTC 4H ADX >= 20 (trending)', { btcMinAdx: 20 }],
    ['only when the coin 4H ADX >= 20', { minAdx: 20 }],
    ['only when the coin 4H ADX >= 25', { minAdx: 25 }],
    ['max 3 per direction', { maxSameDir: 3 }],
    ['max 5 open in total', { maxOpen: 5 }],
  ];
  variantTable('Exits after T1 and risk in bad years', V, series, times, start, end, 'EXIT_RISK_LAB.md');
}

// One row per variant (rule overrides on the live setup): per year with
// fresh 2000 USDT and $100 fixed risk, 2020-23 vs 2024-26, and compounding.
function leakReport(series, times, start, end) {
  const P = config.PORTFOLIO;
  const R = { ...VARIANTS.find(v => v.focus).rules, minScore: 65, limit: { atr: 0.3, hours: 4 }, beBufferPct: 0.2, start: P.STARTING_BALANCE, margin: P.MARGIN_USDT, leverage: P.LEVERAGE,
    maxOpen: P.MAX_OPEN_POSITIONS, maxSameDir: P.MAX_SAME_DIRECTION, riskUsd: 100, riskPct: null };
  const T = simulate(series, config.SYMBOLS, times, R).tradeList;
  const split = Date.UTC(2024, 0, 1);
  const stat = (xs) => {
    const w = xs.filter(x => x.pnl > 0).reduce((a, x) => a + x.pnl, 0), l = -xs.filter(x => x.pnl <= 0).reduce((a, x) => a + x.pnl, 0);
    return { n: xs.length, pf: l ? w / l : 0, net: w - l, win: xs.length ? xs.filter(x => x.pnl > 0).length / xs.length : 0 };
  };
  const btcAt = (x) => { const b = series.BTCUSDT && series.BTCUSDT.sig4.get(x.sigT); return b ? b.score * x.bias : null; };
  const prevScore = (x) => { const q = series[x.symbol].sig4.get(x.sigT - 4 * HOUR); return q ? (x.sig.score - q.score) * x.bias : null; };
  const F = [
    ['|score| at entry', x => Math.abs(x.sig.score), [65, 70, 75, 80, 85, 90]],
    ['BTC score in trade direction', btcAt, [-100, -25, 0, 25, 50, 75]],
    ['score change vs previous 4H candle (trade direction)', prevScore, [-100, 0, 10, 20, 40]],
    ['ATR % of price', x => x.sig.atr / x.sig.close * 100, [0, 1.5, 2.5, 3.5, 5]],
    ['stop distance %', x => x.stopPct * 100, [0, 2, 3, 4, 6]],
    ['ADX (4H)', x => x.sig.adx, [0, 20, 25, 30, 40]],
    ['volume vs 20-candle average', x => x.sig.vr, [0, 0.7, 1, 1.5, 2.5]],
    ['chase (ATR from signal price)', x => x.sig.chaseDist, [0, 0.25, 0.5, 0.75]],
    ['Supertrend 4H with the trade', x => x.sig.st4 === x.bias ? 1 : 0, [0, 1]],
    ['direction (1 = long)', x => x.bias === 1 ? 1 : 0, [0, 1]],
    ['hours from signal to fill', x => (x.openedAt - x.sigT) / HOUR, [0, 1, 2, 3]],
    ['UTC hour of the signal close', x => new Date(x.sigT + HOUR).getUTCHours(), [0, 4, 8, 12, 16, 20]],
    ['weekday of the signal (0 = Sun)', x => new Date(x.sigT + HOUR).getUTCDay(), [0, 1, 2, 3, 4, 5, 6]],
  ];
  const L = ['# Where the PF comes from', '', `Live setup (score 65, limit 0.3 ATR 4h, BE +0.2%, ${config.SYMBOLS.length} coins), $100 fixed risk, ${new Date(start).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)}, ${T.length} trades. Each bucket: trades / win % / PF / net $, for 2020-23 and 2024-26 separately. A bucket only counts as a real pattern when both periods agree.`, ''];
  for (const [name, fn, edges] of F) {
    L.push('## ' + name, '', '| bucket | 2020-23: n | win | PF | net | 2024-26: n | win | PF | net |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (let i = 0; i < edges.length; i++) {
      const lo = edges[i], hi = edges[i + 1];
      const inB = (x) => { const v = fn(x); return v != null && !Number.isNaN(v) && v >= lo && (hi == null || v < hi); };
      const a = stat(T.filter(x => x.openedAt < split && inB(x))), b = stat(T.filter(x => x.openedAt >= split && inB(x)));
      const c = (s) => s.n ? `${s.n} | ${(s.win * 100).toFixed(0)}% | ${s.pf.toFixed(2)} | ${s.net.toFixed(0)}` : '0 | - | - | -';
      L.push(`| ${hi == null ? '>= ' + lo : lo + ' to <' + hi} | ${c(a)} | ${c(b)} |`);
    }
    L.push('');
  }
  fs.writeFileSync(path.join(OUT, 'LEAK.md'), L.join('\n'));
  console.log(L.join('\n'));
}

function variantTable(title, V, series, times, start, end, file, note) {
  const live = VARIANTS.find(v => v.focus);
  const P = config.PORTFOLIO;
  const coins = config.SYMBOLS;
  const pad = (x, n) => String(x).padStart(n);
  const base = { ...live.rules, start: P.STARTING_BALANCE, margin: P.MARGIN_USDT, leverage: P.LEVERAGE, maxOpen: P.MAX_OPEN_POSITIONS, maxSameDir: P.MAX_SAME_DIRECTION };
  const y0 = new Date(start).getUTCFullYear(), y1 = new Date(end).getUTCFullYear();
  const years = []; for (let y = y0; y <= y1; y++) years.push(y);
  const yearTimes = Object.fromEntries(years.map(y => [y, times.filter(t => new Date(t).getUTCFullYear() === y)]));
  const pf = (r) => { let w = 0, l = 0; for (const t of r.tradeList) { if (t.pnl > 0) w += t.pnl; else l -= t.pnl; } return l ? w / l : 0; };
  const L = [];
  L.push(`${title} · ${coins.length} coins · ${new Date(start).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)} · 4H, live rules otherwise`, '');
  L.push('Per year: fresh 2000 USDT, $100 fixed risk — net $ (worst drop). Compound: 2000 USDT, ' + P.RISK_PCT + '% risk, whole period.', '');
  if (note) L.push(note, '');
  L.push('variant'.padEnd(42) + years.map(y => pad(y, 14)).join('') + pad('20-23', 8) + pad('24-26', 8) + pad('yrs+', 6) + '  | compound end $ / PF / worst drop / trades');
  for (const [name, extra] of V) {
    if (!extra) { L.push(name); continue; }
    process.stderr.write(`${name}\n`);
    let tr = 0, te = 0, w = 0;
    const cells = years.map(y => {
      const r = simulate(series, extra.coins || coins, yearTimes[y], { ...base, ...extra, riskUsd: extra.cRiskPct ? P.STARTING_BALANCE * extra.cRiskPct / 100 : 100, riskPct: null });
      if (y <= 2023) tr += r.net; else te += r.net;
      if (r.net > 0) w++;
      return pad(`${r.net.toFixed(0)} (${r.maxDDPct.toFixed(0)}%)`, 14);
    });
    const c = simulate(series, extra.coins || coins, times, { ...base, ...extra, riskUsd: null, riskPct: extra.cRiskPct || P.RISK_PCT });
    L.push(name.padEnd(42) + cells.join('') + pad(tr.toFixed(0), 8) + pad(te.toFixed(0), 8) + pad(`${w}/${years.length}`, 6) +
      `  | ${Math.round(P.STARTING_BALANCE + c.net).toLocaleString('en-US')} / ${pf(c).toFixed(2)} / ${c.maxDDPct.toFixed(1)}% / ${c.trades}`);
  }
  const out = L.join('\n');
  console.log(out);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, file), `# ${title}\n\n\`\`\`\n` + out + '\n\`\`\`\n');
}

// Candidate coins on the current live setup (score 65, pullback limit 0.3 ATR
// / 4h, breakeven +0.2%): 1) each alone, $100 fixed risk; 2) the strongest
// ones added one by one to the live coin list, compounding at the live risk.
function newCoinsLive(series, cands, times, start, end) {
  const live = VARIANTS.find(v => v.focus);
  const P = config.PORTFOLIO;
  const NOW = { minScore: 65, limit: { atr: 0.3, hours: 4 }, beBufferPct: 0.2 };
  const base = { ...live.rules, start: P.STARTING_BALANCE, margin: P.MARGIN_USDT, leverage: P.LEVERAGE, maxOpen: P.MAX_OPEN_POSITIONS, maxSameDir: P.MAX_SAME_DIRECTION, ...NOW };
  const pad = (x, n) => String(x).padStart(n);
  const pf = (r) => { let w = 0, l = 0; for (const t of r.tradeList) { if (t.pnl > 0) w += t.pnl; else l -= t.pnl; } return l ? w / l : 0; };
  const split = Date.UTC(2024, 0, 1);
  const tA = times.filter(t => t < split), tB = times.filter(t => t >= split);
  const L = [];
  L.push(`Candidate coins on the live setup (score 65, limit 0.3 ATR 4h, BE +0.2%) · ${new Date(start).toISOString().slice(0, 10)} -> ${new Date(end).toISOString().slice(0, 10)}`, '');
  L.push('1) Each coin alone · $100 fixed risk per trade · 2000 start · since its listing', '');
  L.push('coin'.padEnd(10) + pad('since', 9) + pad('trades', 8) + pad('net $', 9) + pad('PF', 6) + pad('win%', 6) + pad('drop', 7) + pad('20-23 $', 9) + pad('24-26 $', 9));
  const rows = [];
  for (const s of cands) {
    process.stderr.write(`alone ${s}\n`);
    const R = { ...base, riskUsd: 100, riskPct: null };
    const r = simulate(series, [s], times, R);
    const a = simulate(series, [s], tA, R), b = simulate(series, [s], tB, R);
    const first = series[s].h1.find(c => c.t >= start);
    rows.push({ s, since: first ? new Date(first.t).toISOString().slice(0, 7) : '?', n: r.trades, net: r.net, pf: pf(r), win: r.winRate * 100, dd: r.maxDDPct, a: a.net, b: b.net });
  }
  rows.sort((x, y) => y.pf - x.pf);
  for (const r of rows) L.push(r.s.replace('USDT', '').padEnd(10) + pad(r.since, 9) + pad(r.n, 8) + pad(r.net.toFixed(0), 9) + pad(r.pf.toFixed(2), 6) + pad(r.win.toFixed(0), 6) + pad(r.dd.toFixed(0) + '%', 7) + pad(r.a.toFixed(0), 9) + pad(r.b.toFixed(0), 9));
  // the strongest: enough trades, profitable in 2024-26, PF >= 1.3 (best 8)
  const best = rows.filter(r => r.n >= 25 && r.b > 0 && r.pf >= 1.3).slice(0, 8);
  L.push('', `2) Added to the ${config.SYMBOLS.length} live coins one at a time · compounding from 2000 at ${P.RISK_PCT}% risk · whole period`, '');
  L.push('coin list'.padEnd(26) + pad('end $', 10) + pad('PF', 6) + pad('drop', 8) + pad('trades', 8) + pad('24-26 $', 10));
  const port = (coins, label) => {
    process.stderr.write(`portfolio ${label}\n`);
    const R = { ...base, riskUsd: null, riskPct: P.RISK_PCT };
    const c = simulate(series, coins, times, R), b = simulate(series, coins, tB, { ...base, riskUsd: 100, riskPct: null });
    L.push(label.padEnd(26) + pad(Math.round(P.STARTING_BALANCE + c.net).toLocaleString('en-US'), 10) + pad(pf(c).toFixed(2), 6) + pad(c.maxDDPct.toFixed(1) + '%', 8) + pad(c.trades, 8) + pad(b.net.toFixed(0), 10));
  };
  port(config.SYMBOLS, `live ${config.SYMBOLS.length} coins`);
  for (const r of best) port([...config.SYMBOLS, r.s], `+ ${r.s.replace('USDT', '')}`);
  if (best.length > 1) port([...config.SYMBOLS, ...best.slice(0, 3).map(r => r.s)], '+ best 3 together');
  L.push('', '"24-26 $" in part 2: $100 fixed risk from 2024 on, the recent-years check. A coin is only worth adding if the whole list gets better, not just because it does well alone.');
  const out = L.join('\n');
  console.log(out);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'NEW_COINS_LIVE.md'), '# New coin candidates (live setup)\n\n```\n' + out + '\n```\n');
}

function scoreMom(series, symbols, times, start, end) {
  const live = VARIANTS.find(v => v.focus);
  const P = config.PORTFOLIO;
  const coins = config.SYMBOLS;
  const pad = (x, n) => String(x).padStart(n);
  const base = { ...live.rules, start: P.STARTING_BALANCE, margin: P.MARGIN_USDT, leverage: P.LEVERAGE, maxOpen: P.MAX_OPEN_POSITIONS, maxSameDir: P.MAX_SAME_DIRECTION };
  // s0 / s1 / s2: score in the trade's direction now, 1 and 2 candles ago
  const V = [
    ['A  now: |score| >= 50', null],
    ['B  rose >= 10 over 2 candles, still rising, >= 30', (s0, s1, s2) => s0 >= 30 && s0 - s2 >= 10 && s0 > s1],
    ['B2 same, >= 40', (s0, s1, s2) => s0 >= 40 && s0 - s2 >= 10 && s0 > s1],
    ['C  rose >= 10 on each of 2 candles, >= 40', (s0, s1, s2) => s0 >= 40 && s0 - s1 >= 10 && s1 - s2 >= 10],
    ['D  >= 50 and still rising', (s0, s1) => s0 >= 50 && s0 > s1],
    ['D2 >= 50 and not falling', (s0, s1) => s0 >= 50 && s0 >= s1],
    ['D3 >= 50 and rose >= 10 over 2 candles', (s0, s1, s2) => s0 >= 50 && s0 - s2 >= 10],
    ['E  >= 35 and jumped >= 15 in 1 candle', (s0, s1) => s0 >= 35 && s0 - s1 >= 15],
    ['F  >= 50, or >= 35 and jumped >= 15', (s0, s1) => s0 >= 50 || (s0 >= 35 && s0 - s1 >= 15)],
  ];
  const y0 = new Date(start).getUTCFullYear(), y1 = new Date(end).getUTCFullYear();
  const years = []; for (let y = y0; y <= y1; y++) years.push(y);
  const yearTimes = Object.fromEntries(years.map(y => [y, times.filter(t => new Date(t).getUTCFullYear() === y)]));
  const pf = (r) => { let w = 0, l = 0; for (const t of r.tradeList) { if (t.pnl > 0) w += t.pnl; else l -= t.pnl; } return l ? w / l : 0; };
  const L = [];
  L.push(`Score-momentum entries · ${coins.length} coins · ${new Date(start).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)} · 4H, live rules otherwise (chase limit, Fibonacci, BTC filter, one trade per signal)`, '');
  L.push('Per year: fresh 2000 USDT, $100 fixed risk — net $ (worst drop). Compound: 2000 USDT, ' + P.RISK_PCT + '% risk, whole period.', '');
  L.push('entry rule'.padEnd(46) + years.map(y => pad(y, 14)).join('') + pad('20-23', 8) + pad('24-26', 8) + pad('yrs+', 6) + '  | compound end $ / PF / worst drop / trades / win%');
  for (const [name, fn] of V) {
    process.stderr.write(`${name}\n`);
    let tr = 0, te = 0, w = 0;
    const cells = years.map(y => {
      const r = simulate(series, coins, yearTimes[y], { ...base, entryFn: fn, riskUsd: 100, riskPct: null });
      if (y <= 2023) tr += r.net; else te += r.net;
      if (r.net > 0) w++;
      return pad(`${r.net.toFixed(0)} (${r.maxDDPct.toFixed(0)}%)`, 14);
    });
    const c = simulate(series, coins, times, { ...base, entryFn: fn, riskUsd: null, riskPct: P.RISK_PCT });
    L.push(name.padEnd(46) + cells.join('') + pad(tr.toFixed(0), 8) + pad(te.toFixed(0), 8) + pad(`${w}/${years.length}`, 6) +
      `  | ${Math.round(P.STARTING_BALANCE + c.net).toLocaleString('en-US')} / ${pf(c).toFixed(2)} / ${c.maxDDPct.toFixed(1)}% / ${c.trades} / ${(c.winRate * 100).toFixed(0)}%`);
  }
  const out = L.join('\n');
  console.log(out);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'SCORE_MOM.md'), '# Score-momentum entries\n\n```\n' + out + '\n```\n');
}

function scoreLab(series, symbols, times, start, end) {
  const live = VARIANTS.find(v => v.focus);
  const P = config.PORTFOLIO;
  const coins = config.SYMBOLS;
  const base = { ...live.rules, start: P.STARTING_BALANCE, margin: P.MARGIN_USDT, leverage: P.LEVERAGE, maxOpen: P.MAX_OPEN_POSITIONS, maxSameDir: P.MAX_SAME_DIRECTION };
  const y0 = new Date(start).getUTCFullYear(), y1 = new Date(end).getUTCFullYear();
  const years = []; for (let y = y0; y <= y1; y++) years.push(y);
  const yearTimes = Object.fromEntries(years.map(y => [y, times.filter(t => new Date(t).getUTCFullYear() === y)]));
  const pf = (r) => { let w = 0, l = 0; for (const t of r.tradeList) { if (t.pnl > 0) w += t.pnl; else l -= t.pnl; } return l ? w / l : 0; };
  // how often the score is strong: share of 4H candles with |score| >= x
  const all = coins.flatMap(s => [...series[s].sig4.values()].map(r => Math.abs(r.score)));
  const dist = Object.fromEntries([30, 40, 50, 60, 70].map(x => [x, all.filter(v => v >= x).length / all.length]));
  const rows = [];
  for (let th = 30; th <= 70; th += 5) {
    process.stderr.write(`threshold ${th}\n`);
    const per = {};
    for (const y of years) {
      const r = simulate(series, coins, yearTimes[y], { ...base, minScore: th, riskUsd: 100, riskPct: null });
      per[y] = { net: Math.round(r.net), dd: +r.maxDDPct.toFixed(1), trades: r.trades, pf: +pf(r).toFixed(2) };
    }
    const c = simulate(series, coins, times, { ...base, minScore: th, riskUsd: null, riskPct: P.RISK_PCT });
    rows.push({ th, per, compound: { end: Math.round(P.STARTING_BALANCE + c.net), dd: +c.maxDDPct.toFixed(1), trades: c.trades, pf: +pf(c).toFixed(2), win: Math.round(c.winRate * 100) } });
  }
  const res = { tag: LAB_TAG, mode: LAB_MODE, mtf: LAB_MTF, years, dist, rows, period: [start, end] };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `score-lab-${LAB_TAG}.json`), JSON.stringify(res, null, 1) + '\n');
  console.log(scoreLabText([res]));
}

// Merges score-lab-*.json into backtest/SCORE_LAB.md.
function scoreLabText(results) {
  const pad = (x, n) => String(x).padStart(n);
  const TRAIN = (y) => y <= 2023;
  const L = [];
  for (const res of results) {
    const years = res.years;
    L.push(`== ${res.tag}: score ${res.mode}${res.mtf ? ' + trim when 1H/4H/1D disagree' : ''} · 4H candles with |score| >= 30/40/50/60/70: ${Object.values(res.dist).map(x => Math.round(x * 100) + '%').join(' / ')}`, '');
    L.push('min score' + years.map(y => pad(y, 14)).join('') + pad('train 20-23', 13) + pad('test 24-26', 12) + pad('years +', 9) + '   | compound: end $ / PF / worst drop / trades');
    for (const r of res.rows) {
      const tr = years.filter(TRAIN).reduce((a, y) => a + r.per[y].net, 0), te = years.filter(y => !TRAIN(y)).reduce((a, y) => a + r.per[y].net, 0);
      L.push(pad(r.th, 9) + years.map(y => pad(`${r.per[y].net} (${Math.round(r.per[y].dd)}%)`, 14)).join('') + pad(tr, 13) + pad(te, 12) + pad(`${years.filter(y => r.per[y].net > 0).length}/${years.length}`, 9) +
        `   | ${r.compound.end.toLocaleString('en-US')} / ${r.compound.pf} / ${r.compound.dd}% / ${r.compound.trades}`);
    }
    const best = res.rows.slice().sort((a, b) => years.filter(TRAIN).reduce((s, y) => s + b.per[y].net, 0) - years.filter(TRAIN).reduce((s, y) => s + a.per[y].net, 0))[0];
    L.push('', `picked on 2020-2023: min score ${best.th} -> 2024-2026: ${years.filter(y => !TRAIN(y)).reduce((a, y) => a + best.per[y].net, 0)}`, '');
  }
  return L.join('\n');
}

function tfCompare(series, symbols, times, start, end) {
  const live = VARIANTS.find(v => v.focus);
  const P = config.PORTFOLIO;
  const coins = config.SYMBOLS;
  const pad = (x, n) => String(x).padStart(n);
  const base = { ...live.rules, start: P.STARTING_BALANCE, margin: P.MARGIN_USDT, leverage: P.LEVERAGE, maxOpen: P.MAX_OPEN_POSITIONS, maxSameDir: P.MAX_SAME_DIRECTION };
  const V = [
    ['4H signals (live)', { tf: '4H' }],
    ['1H signals, same rules', { tf: '1H' }],
    ['1H + 4H Supertrend agrees', { tf: '1H', st4Agree: true }],
    ['1H + 4H Supertrend + volume >= 1.2x', { tf: '1H', st4Agree: true, volMin: 1.2 }],
    ['1H + 1H & 4H Supertrend + volume >= 1.2x', { tf: '1H', st1Agree: true, st4Agree: true, volMin: 1.2 }],
  ];
  const y0 = new Date(start).getUTCFullYear(), y1 = new Date(end).getUTCFullYear();
  const years = []; for (let y = y0; y <= y1; y++) years.push(y);
  const yearTimes = (y) => times.filter(t => new Date(t).getUTCFullYear() === y);
  const pf = (r) => { let w = 0, l = 0; for (const t of r.tradeList) { if (t.pnl > 0) w += t.pnl; else l -= t.pnl; } return l ? w / l : 0; };
  const L = [];
  L.push(`1H vs 4H signals · ${coins.length} coins · ${new Date(start).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)} · live rules (targets ${base.targetsR.join('/')}R, ${base.maxOpen} slots, ${base.maxSameDir} per direction, BTC filter, fees)`, '');
  L.push(`A) Compounding: start ${P.STARTING_BALANCE} USDT, ${P.RISK_PCT}% of balance risk, max $${P.MARGIN_USDT} margin x${P.LEVERAGE}`, '');
  L.push('variant'.padEnd(44) + pad('trades', 8) + pad('win%', 6) + pad('end $', 11) + pad('PF', 6) + pad('worst drop', 12));
  for (const [name, extra] of V) {
    process.stderr.write(`compound ${name}\n`);
    const r = simulate(series, coins, times, { ...base, ...extra, riskUsd: null, riskPct: P.RISK_PCT });
    L.push(name.padEnd(44) + pad(r.trades, 8) + pad((r.winRate * 100).toFixed(0), 6) + pad(Math.round(P.STARTING_BALANCE + r.net).toLocaleString('en-US'), 11) + pad(pf(r).toFixed(2), 6) + pad(r.maxDDPct.toFixed(1) + '%', 12));
  }
  L.push('', `B) Per year: fresh ${P.STARTING_BALANCE} USDT each year, $100 fixed risk — net $ (worst drop)`, '');
  L.push('variant'.padEnd(44) + years.map(y => pad(y, 15)).join('') + pad('total', 9) + pad('years +', 9));
  for (const [name, extra] of V) {
    process.stderr.write(`years ${name}\n`);
    let tot = 0, w = 0;
    const cells = years.map(y => {
      const r = simulate(series, coins, yearTimes(y), { ...base, ...extra, riskUsd: 100, riskPct: null });
      tot += r.net; if (r.net > 0) w++;
      return pad(`${r.net.toFixed(0)} (${r.maxDDPct.toFixed(0)}%)`, 15);
    });
    L.push(name.padEnd(44) + cells.join('') + pad(tot.toFixed(0), 9) + pad(`${w}/${years.length}`, 9));
  }
  L.push('', 'Same coins, targets, stops and filters for every row; only the signal candle changes. Coins, targets and filters were tuned on 4H.');
  const out = L.join('\n');
  console.log(out);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'TF_COMPARE.md'), '# 1H vs 4H signals\n\n```\n' + out + '\n```\n');
}

function riskStarts(series, symbols, times, start, end) {
  const live = VARIANTS.find(v => v.focus);
  const P = config.PORTFOLIO;
  const coins = config.SYMBOLS;
  const pad = (x, n) => String(x).padStart(n);
  const d = (t) => new Date(t).toISOString().slice(0, 10);
  const base = { ...live.rules, start: P.STARTING_BALANCE, margin: P.MARGIN_USDT, leverage: P.LEVERAGE, maxOpen: P.MAX_OPEN_POSITIONS, maxSameDir: P.MAX_SAME_DIRECTION };
  const V = [['$50 fixed', { riskUsd: 50 }], ['$100 fixed', { riskUsd: 100 }], ['2.5% of balance', { riskUsd: null, riskPct: 2.5 }], ['3.75% of balance', { riskUsd: null, riskPct: 3.75 }]];
  const DAY = 24 * HOUR, WIN = 120 * DAY;
  const L = [];
  L.push(`Risk sizing from 12 start dates · live setup · ${coins.length} coins · start ${P.STARTING_BALANCE} USDT each time · 120-day windows starting 20 days apart`, '');
  L.push('window'.padEnd(26) + V.map(([n]) => pad(n + ' ret', 20) + pad('maxDD', 8)).join(''));
  const agg = V.map(() => ({ rets: [], dds: [] }));
  for (let k = 0; k < 12; k++) {
    const ws = start + k * 20 * DAY, we = ws + WIN;
    if (we > end) break;
    const T = times.filter(t => t >= ws && t < we);
    const cells = V.map(([, extra], i) => {
      const r = simulate(series, coins, T, { ...base, ...extra });
      agg[i].rets.push(r.returnPct); agg[i].dds.push(r.maxDDPct);
      return pad(r.returnPct.toFixed(0) + '%', 20) + pad(r.maxDDPct.toFixed(1) + '%', 8);
    });
    L.push(`${d(ws)} → ${d(we)}`.padEnd(26) + cells.join(''));
  }
  const med = (xs) => { const a = [...xs].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  L.push('', 'summary'.padEnd(26) + V.map(([n]) => pad(n, 28)).join(''));
  L.push('median return'.padEnd(26) + agg.map(a => pad(med(a.rets).toFixed(0) + '%', 28)).join(''));
  L.push('worst return'.padEnd(26) + agg.map(a => pad(Math.min(...a.rets).toFixed(0) + '%', 28)).join(''));
  L.push('median worst drop'.padEnd(26) + agg.map(a => pad(med(a.dds).toFixed(1) + '%', 28)).join(''));
  L.push('largest worst drop'.padEnd(26) + agg.map(a => pad(Math.max(...a.dds).toFixed(1) + '%', 28)).join(''));
  L.push('', 'Margin cap with 2.5% of balance, whole year:');
  for (const cap of [400, 600, 800, 1200]) {
    const r = simulate(series, coins, times, { ...base, riskUsd: null, riskPct: 2.5, margin: cap });
    const cut = r.tradeList.filter(t => t.margin >= cap * 0.999).length;
    L.push(`  max margin $${cap} (position $${cap * P.LEVERAGE})`.padEnd(40) + pad(r.returnPct.toFixed(0) + '%', 8) + pad(r.maxDDPct.toFixed(1) + '%', 8) + `   trades at the cap: ${cut} of ${r.trades}`);
  }
  const out = L.join('\n');
  console.log(out);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'RISK_STARTS.md'), '# Risk sizing from different start dates\n\n```\n' + out + '\n```\n');
}

function ddLab(series, symbols, times, start, end) {
  const live = VARIANTS.find(v => v.focus);
  const P = config.PORTFOLIO;
  const coins = config.SYMBOLS;
  const third = (end - start) / 3;
  const pad = (x, n) => String(x).padStart(n);
  const d = (t) => new Date(t).toISOString().slice(0, 10);
  const base = { ...live.rules, start: P.STARTING_BALANCE, margin: P.MARGIN_USDT, leverage: P.LEVERAGE, riskUsd: P.RISK_USDT };
  const V = [
    ['live: $100 fixed', {}],
    ['$75 fixed', { riskUsd: 75 }],
    ['$50 fixed', { riskUsd: 50 }],
    ['5% of balance', { riskUsd: null, riskPct: 5 }],
    ['3.75% of balance', { riskUsd: null, riskPct: 3.75 }],
    ['2.5% of balance', { riskUsd: null, riskPct: 2.5 }],
    ['$100, half risk at -15%', { ddThrottle: { at: 0.15, factor: 0.5 } }],
    ['$100, half risk at -20%', { ddThrottle: { at: 0.2, factor: 0.5 } }],
    ['$100, half risk at -25%', { ddThrottle: { at: 0.25, factor: 0.5 } }],
    ['$100, pause at -25%', { ddThrottle: { at: 0.25, factor: 0 } }],
    ['$100, 4 losses -> 24h pause', { streakPause: { n: 4, hours: 24 } }],
    ['$100, 5 losses -> 48h pause', { streakPause: { n: 5, hours: 48 } }],
  ];
  const L = [];
  L.push(`Drawdown lab · live setup · ${coins.length} coins · start ${P.STARTING_BALANCE} USDT · ${d(start)} → ${d(end)}`, '');
  L.push('setup'.padEnd(30) + pad('trades', 7) + pad('net $', 8) + pad('ret', 7) + pad('maxDD', 8) + pad('DD $', 8) + '  worst drop (peak -> low)'.padEnd(42) + pad('PF', 6) + pad('worst mo', 10) + pad('1/3', 7) + pad('2/3', 7) + pad('3/3', 7));
  for (const [name, extra] of V) {
    const r = simulate(series, coins, times, { ...base, ...extra });
    const T = r.tradeList;
    const part = [0, 1, 2].map(k => T.filter(t => t.closedAt >= start + k * third && t.closedAt < start + (k + 1) * third).reduce((a, t) => a + t.pnl, 0));
    const months = {};
    for (const t of T) { const m = new Date(t.closedAt).toISOString().slice(0, 7); months[m] = (months[m] || 0) + t.pnl; }
    const dd = r.dd;
    const ddTxt = dd ? `${d(dd.peakT)} -> ${d(dd.troughT)} (${dd.peak.toFixed(0)} -> ${dd.trough.toFixed(0)})` : '-';
    L.push(name.padEnd(30) + pad(r.trades, 7) + pad(r.net.toFixed(0), 8) + pad(r.returnPct.toFixed(0) + '%', 7) + pad(r.maxDDPct.toFixed(1) + '%', 8) + pad(dd ? (dd.peak - dd.trough).toFixed(0) : '-', 8) +
      ('  ' + ddTxt).padEnd(42) + pad(r.profitFactor.toFixed(2), 6) + pad(Math.min(...Object.values(months)).toFixed(0), 10) + part.map(x => pad(x.toFixed(0), 7)).join(''));
  }
  const out = L.join('\n');
  console.log(out);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'DD_LAB.md'), '# Drawdown lab\n\n```\n' + out + '\n```\n');
}

function levGrid(series, symbols, times, start, end) {
  const live = VARIANTS.find(v => v.focus);
  const P = config.PORTFOLIO;
  const coins = config.SYMBOLS;
  const third = (end - start) / 3;
  const pad = (x, n) => String(x).padStart(n);
  const plan = { ...live.rules, start: P.STARTING_BALANCE, riskUsd: 100, maxOpen: 7, maxSameDir: 4 };
  const L = [];
  L.push(`Leverage grid · planned setup ($100 risk, 7 slots, max 4/direction) · ${coins.length} coins · start ${P.STARTING_BALANCE} USDT · ${new Date(start).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)}`);
  L.push('"capped" = trades whose size was cut because the position cap was below $100 / stop distance.');
  L.push('"stop > liq" = trades whose stop sat beyond the isolated-margin liquidation price (1/lev - 0.5%).', '');
  const head = 'setup'.padEnd(34) + pad('trades', 7) + pad('net $', 8) + pad('ret', 7) + pad('maxDD', 8) + pad('PF', 6) + pad('avg mgn', 9) + pad('peak mgn', 10) + pad('capped', 8) + pad('stop>liq', 10) + pad('1/3', 7) + pad('2/3', 7) + pad('3/3', 7);
  for (const [title, capOf] of [['Max margin fixed at $400 (position cap = $400 x lev)', () => 400], ['Max position fixed at $4000 (margin cap = $4000 / lev)', (lev) => 4000 / lev]]) {
    L.push(title, head);
    for (const lev of [5, 6, 7, 8, 9, 10]) {
      const r = simulate(series, coins, times, { ...plan, leverage: lev, margin: capOf(lev) });
      const T = r.tradeList;
      const part = [0, 1, 2].map(k => T.filter(t => t.closedAt >= start + k * third && t.closedAt < start + (k + 1) * third).reduce((a, t) => a + t.pnl, 0));
      const capped = T.filter(t => t.notional < 100 / t.stopPct * 0.98).length;
      const beyond = T.filter(t => t.stopPct >= 1 / lev - 0.005).length;
      const avgM = T.reduce((a, t) => a + t.margin, 0) / (T.length || 1);
      // peak total margin in use at once
      const ev = [];
      for (const t of T) { ev.push([t.openedAt, t.margin]); ev.push([t.closedAt, -t.margin]); }
      ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let cur = 0, peakM = 0; for (const [, d] of ev) { cur += d; peakM = Math.max(peakM, cur); }
      L.push(`${lev}x · cap $${capOf(lev).toFixed(0)} margin`.padEnd(34) + pad(r.trades, 7) + pad(r.net.toFixed(0), 8) + pad(r.returnPct.toFixed(0) + '%', 7) + pad(r.maxDDPct.toFixed(1) + '%', 8) +
        pad(r.profitFactor.toFixed(2), 6) + pad('$' + avgM.toFixed(0), 9) + pad('$' + peakM.toFixed(0), 10) + pad(capped, 8) + pad(beyond, 10) + part.map(x => pad(x.toFixed(0), 7)).join(''));
    }
    L.push('');
  }
  const out = L.join('\n');
  console.log(out);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'LEV_GRID.md'), '# Leverage grid\n\n```\n' + out + '\n```\n');
}

function riskGrid(series, symbols, times, start, end) {
  const live = VARIANTS.find(v => v.focus);
  const P = config.PORTFOLIO;
  const coins = config.SYMBOLS;
  const third = (end - start) / 3;
  const pad = (x, n) => String(x).padStart(n);
  const base = { ...live.rules, start: P.STARTING_BALANCE, margin: P.MARGIN_USDT, leverage: P.LEVERAGE };
  const combos = [];
  const risks = args.includes('--risk') ? String(args[args.indexOf('--risk') + 1]).split(',').map(Number) : [50, 75, 100];
  for (const risk of risks) {
    if (args.includes('--slots')) {
      // --slots 4,5,6,...: total slots, each with max 4 per direction (or all of them if fewer)
      for (const tot of String(args[args.indexOf('--slots') + 1]).split(',').map(Number)) {
        const dir = Math.min(4, tot);
        combos.push({ name: `$${risk} risk · ${tot} slots · max ${dir}/direction`, rules: { riskUsd: risk, maxOpen: tot, maxSameDir: dir } });
      }
      continue;
    }
    for (const dir of [3, 4, 5]) combos.push({ name: `$${risk} risk · 7 slots · max ${dir}/direction`, rules: { riskUsd: risk, maxOpen: 7, maxSameDir: dir } });
    for (const tot of [3, 4]) combos.push({ name: `$${risk} risk · ${tot} slots total`, rules: { riskUsd: risk, maxOpen: tot, maxSameDir: tot } });
  }
  const L = [];
  L.push(`Risk & slot grid · ${coins.length} coins · start ${P.STARTING_BALANCE} USDT · max $${P.MARGIN_USDT} margin, ${P.LEVERAGE}x · ${new Date(start).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)}`, '');
  L.push('setup'.padEnd(36) + pad('trades', 7) + pad('win', 6) + pad('net $', 8) + pad('ret', 7) + pad('maxDD', 8) + pad('PF', 6) + pad('worst mo', 10) + pad('1/3', 8) + pad('2/3', 8) + pad('3/3', 8));
  for (const c of combos) {
    const r = simulate(series, coins, times, { ...base, ...c.rules });
    const part = [0, 1, 2].map(k => r.tradeList.filter(t => t.closedAt >= start + k * third && t.closedAt < start + (k + 1) * third).reduce((a, t) => a + t.pnl, 0));
    const months = {};
    for (const t of r.tradeList) { const m = new Date(t.closedAt).toISOString().slice(0, 7); months[m] = (months[m] || 0) + t.pnl; }
    const worst = Math.min(...Object.values(months));
    const live_ = c.rules.riskUsd === P.RISK_USDT && c.rules.maxOpen === P.MAX_OPEN_POSITIONS && c.rules.maxSameDir === P.MAX_SAME_DIRECTION;
    L.push((c.name + (live_ ? ' (live)' : '')).padEnd(36) + pad(r.trades, 7) + pad((r.winRate * 100).toFixed(0) + '%', 6) + pad(r.net.toFixed(0), 8) + pad(r.returnPct.toFixed(0) + '%', 7) +
      pad(r.maxDDPct.toFixed(1) + '%', 8) + pad(r.profitFactor.toFixed(2), 6) + pad(worst.toFixed(0), 10) + part.map(x => pad(x.toFixed(0), 8)).join(''));
  }
  const out = L.join('\n');
  console.log(out);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, args.includes('--slots') ? 'SLOT_GRID.md' : 'RISK_GRID.md'), '# ' + (args.includes('--slots') ? 'Total slot grid' : 'Risk and slot grid') + '\n\n```\n' + out + '\n```\n');
}

function exitLab(series, symbols, times, start, end) {
  const live = VARIANTS.find(v => v.focus);
  const coins = config.SYMBOLS;
  const split = start + (end - start) * 2 / 3;
  const trainT = times.filter(t => t < split), testT = times.filter(t => t >= split);
  const third = (end - start) / 3;
  const pad = (x, n) => String(x).padStart(n);
  const FAMILIES = {
    'Trailing stop (replaces fixed T3)': [
      ['after T2, 2 ATR', { trail: { after: 't2', atr: 2 } }], ['after T2, 3 ATR', { trail: { after: 't2', atr: 3 } }],
      ['after T2, 4 ATR', { trail: { after: 't2', atr: 4 } }], ['after T1, 2 ATR', { trail: { after: 't1', atr: 2 } }],
      ['after T1, 3 ATR', { trail: { after: 't1', atr: 3 } }], ['after T1, 4 ATR', { trail: { after: 't1', atr: 4 } }],
    ],
    'Time stop (no T1 within N hours)': [
      ['24h', { timeStopH: 24 }], ['36h', { timeStopH: 36 }], ['48h', { timeStopH: 48 }],
      ['72h', { timeStopH: 72 }], ['96h', { timeStopH: 96 }],
    ],
    'Regime filter (ADX on 4H)': [
      ['coin ADX >= 15', { minAdx: 15 }], ['coin ADX >= 20', { minAdx: 20 }], ['coin ADX >= 25', { minAdx: 25 }],
      ['BTC ADX >= 15', { btcMinAdx: 15 }], ['BTC ADX >= 20', { btcMinAdx: 20 }], ['BTC ADX >= 25', { btcMinAdx: 25 }],
    ],
  };
  const run = (T, extra) => simulate(series, coins, T, { ...live.rules, ...extra });
  const thirds = (r) => [0, 1, 2].map(k => r.tradeList.filter(t => t.closedAt >= start + k * third && t.closedAt < start + (k + 1) * third).reduce((a, t) => a + t.pnl, 0));
  const head = ''.padEnd(24) + pad('trades', 7) + pad('win', 6) + pad('net $', 8) + pad('maxDD', 8) + pad('PF', 6) + pad('1/3', 8) + pad('2/3', 8) + pad('3/3', 8) + pad('train', 8) + pad('test', 8);
  const line = (name, r, rt, rs) => name.padEnd(24) + pad(r.trades, 7) + pad((r.winRate * 100).toFixed(0) + '%', 6) + pad(r.net.toFixed(0), 8) + pad(r.maxDDPct.toFixed(1) + '%', 8) + pad(r.profitFactor.toFixed(2), 6) + thirds(r).map(x => pad(x.toFixed(0), 8)).join('') + pad(rt.net.toFixed(0), 8) + pad(rs.net.toFixed(0), 8);
  const L = [];
  L.push(`Exit lab · live portfolio (${coins.length} coins, ${live.name.replace(' (live now)', '')}) · ${new Date(start).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)} · start 1000 USDT, $50 risk`);
  L.push(`train = first 2/3 (to ${new Date(split).toISOString().slice(0, 10)}), test = last 1/3 — the walk-forward pick uses train only.`, '');
  const base = { all: run(times, {}), tr: run(trainT, {}), te: run(testT, {}) };
  L.push(head, line('baseline (live now)', base.all, base.tr, base.te), '');
  for (const [fam, vars] of Object.entries(FAMILIES)) {
    L.push(fam);
    const res = vars.map(([name, extra]) => ({ name, all: run(times, extra), tr: run(trainT, extra), te: run(testT, extra) }));
    for (const r of res) L.push(line('  ' + r.name, r.all, r.tr, r.te));
    const pick = [...res].sort((a, b) => b.tr.net - a.tr.net)[0];
    const beats = pick.tr.net > base.tr.net;
    L.push(`  walk-forward: train pick "${pick.name}" (train ${pick.tr.net.toFixed(0)} vs baseline ${base.tr.net.toFixed(0)})` +
      (beats ? ` → test ${pick.te.net.toFixed(0)} vs baseline ${base.te.net.toFixed(0)} (${pick.te.net >= base.te.net ? 'holds up' : 'does NOT hold up'})` : ' → nothing beat the baseline on train'), '');
  }
  const out = L.join('\n');
  console.log(out);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'EXIT_LAB.md'), '# Exit lab: trailing stop, time stop, regime filter\n\n```\n' + out + '\n```\n');
}

function scoreWalkForward(series, symbols, times, start, end) {
  const live = VARIANTS.find(v => v.focus);
  const GRID = [30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80];
  const split = start + (end - start) * 2 / 3;
  const trainT = times.filter(t => t < split), testT = times.filter(t => t >= split);
  const coins = config.SYMBOLS;
  const pad = (x, n) => String(x).padStart(n);
  const L = [];
  L.push(`Walk-forward entry-score check · live rules · train ${new Date(start).toISOString().slice(0, 10)} → ${new Date(split).toISOString().slice(0, 10)} · test ${new Date(split).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)}`, '');
  L.push('Per coin, traded alone. "train pick" = score chosen on the train window only (best average of it and its two', 'neighbouring scores, >= 10 trades; falls back to 50 if nothing makes money). Test columns: net $ on the unseen last third.', '');
  L.push('coin'.padEnd(10) + pad('live', 6) + pad('train', 7) + pad('test@50', 9) + pad('test@live', 11) + pad('test@train', 12) + pad('full-year best', 16));
  const wfMap = {};
  const liveMap = config.ENTRY_MIN_SCORE_BY_SYMBOL || {};
  const tot = { t50: 0, tLive: 0, tTrain: 0 };
  for (const s of coins) {
    const run = (T, minScore) => simulate(series, [s], T, { ...live.rules, maxOpen: 1, minScore });
    const train = GRID.map(g => { const r = run(trainT, g); return { g, net: r.net, trades: r.trades }; });
    const smooth = train.map((x, i) => {
      const nb = [train[i - 1], x, train[i + 1]].filter(Boolean);
      return { g: x.g, avg: nb.reduce((a, y) => a + y.net, 0) / nb.length, trades: x.trades };
    }).filter(x => x.trades >= 10).sort((a, b) => b.avg - a.avg);
    const pick = smooth.length && smooth[0].avg > 0 ? smooth[0].g : 50;
    wfMap[s] = pick;
    const liveScore = liveMap[s] != null ? liveMap[s] : config.ENTRY_MIN_SCORE;
    const t50 = run(testT, 50).net, tLive = run(testT, liveScore).net, tTrain = run(testT, pick).net;
    tot.t50 += t50; tot.tLive += tLive; tot.tTrain += tTrain;
    const full = GRID.map(g => ({ g, net: run(times, g).net })).sort((a, b) => b.net - a.net)[0];
    L.push(s.replace('USDT', '').padEnd(10) + pad(liveScore, 6) + pad(pick, 7) + pad(t50.toFixed(0), 9) + pad(tLive.toFixed(0), 11) + pad(tTrain.toFixed(0), 12) + pad(full.g + ' (' + full.net.toFixed(0) + ')', 16));
  }
  L.push('TOTAL'.padEnd(10) + pad('', 6) + pad('', 7) + pad(tot.t50.toFixed(0), 9) + pad(tot.tLive.toFixed(0), 11) + pad(tot.tTrain.toFixed(0), 12), '');
  L.push('Portfolio (all coins together, live slots and BTC filter):', '');
  const port = (T, extra) => simulate(series, coins, T, { ...live.rules, ...extra });
  const row = (name, r) => name.padEnd(34) + pad(r.trades, 7) + pad((r.winRate * 100).toFixed(0) + '%', 6) + pad(r.net.toFixed(0), 8) + pad(r.maxDDPct.toFixed(1) + '%', 8) + pad(r.profitFactor.toFixed(2), 6);
  L.push(''.padEnd(34) + pad('trades', 7) + pad('win', 6) + pad('net $', 8) + pad('maxDD', 8) + pad('PF', 6));
  L.push('Test window only (never seen by the train pick):');
  L.push(row('  flat 50', port(testT, { minScore: 50 })));
  L.push(row('  live per-coin map', port(testT, { minScoreBySymbol: liveMap })));
  L.push(row('  walk-forward map', port(testT, { minScoreBySymbol: wfMap })));
  L.push('Whole period:');
  L.push(row('  flat 50', port(times, { minScore: 50 })));
  L.push(row('  live per-coin map (in-sample)', port(times, { minScoreBySymbol: liveMap })));
  L.push('', 'Walk-forward map: ' + Object.entries(wfMap).map(([k, v]) => k.replace('USDT', '') + ' ' + v).join(', '));
  const out = L.join('\n');
  console.log(out);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'SCORE_WF.md'), '# Entry-score walk-forward check\n\n```\n' + out + '\n```\n');
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { simulate, precompute, to4h, BASE_RULES, addFilterInputs, VARIANTS };
