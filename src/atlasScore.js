// The "best entry" engine — ported from ATLAS's analyse() (alicetin1905-ux/atlas
// index.html), the same ~25-indicator weighted score, Chandelier Exit stop and
// flip-triggered entry the dashboard itself shows. This is the primary signal;
// fib.js and liquidity.js (ported from GoldenRatio / CRUCIBLE) layer on top of
// it as confluence and target/stop refinement, not separate opinions.
'use strict';

const I = require('./indicators');
const { sizeFor } = require('./risk');
const config = require('../config');

const nn = I.nn;
const watchKey = (s, t) => `${s}:${t}`;

// entry = the price at the moment the score FIRST flipped into this bias,
// held stable across later runs until it flips again — otherwise "entry"
// would just keep sliding to whatever the current price is, which isn't a
// plan. flipStore is a plain object the caller persists to disk between runs.
function trackFlipEntry(flipStore, symbol, tf, bias, price) {
  const key = watchKey(symbol, tf);
  const prev = flipStore[key];
  if (bias !== 0 && (!prev || prev.bias !== bias)) {
    flipStore[key] = { bias, price };
  } else if (bias === 0 && prev) {
    delete flipStore[key];
  }
}
function flipEntryPrice(flipStore, symbol, tf, price) {
  const e = flipStore[watchKey(symbol, tf)];
  return e ? e.price : price;
}

function analyse({ symbol, candles, ticker, oi, ratio, book, tape, entryTf, mtfTfs, flipStore, account, riskPct, leverage, scoreThreshold }) {
  const c = candles[entryTf];
  if (!c || c.length < 220) return null;
  const k = c.slice(0, -1); // closed candles only — drop the forming bar
  const i = k.length - 1;
  const close = k.map(x => x.c);
  const price = k[i].c;
  const sig = [];
  const add = (group, name, value, dir, weight, note) => sig.push({ group, name, value, dir, weight, note });

  /* --- trend --- */
  const e20 = I.ema(close, 20), e50 = I.ema(close, 50), e200 = I.ema(close, 200);
  const stacked = e20[i] > e50[i] && e50[i] > e200[i] ? 1 : (e20[i] < e50[i] && e50[i] < e200[i] ? -1 : 0);
  add('Trend', 'EMA stack 20/50/200', stacked === 1 ? 'bullish stack' : stacked === -1 ? 'bearish stack' : 'tangled', stacked, 8);
  add('Trend', 'Price vs EMA200', `${((price / e200[i] - 1) * 100).toFixed(2)}%`, price > e200[i] ? 1 : -1, 6);

  const st = I.supertrend(k, 10, 3);
  add('Trend', 'Supertrend 10/3', `${st.dir[i] === 1 ? 'long' : 'short'} @ ${fmt(st.st[i])}`, st.dir[i], 7);

  const ce = I.chandelier(k, 4, 2);
  const ceStop = ce.dir[i] === 1 ? ce.longStop[i] : ce.shortStop[i];
  add('Trend', 'Chandelier Exit 4/2', `${ce.dir[i] === 1 ? 'long' : 'short'} - stop ${fmt(ceStop)}`, ce.dir[i], 7);

  const zl = I.zlsma(close, 32);
  const zlDir = price > zl[i] ? 1 : -1;
  const zlSlope = zl[i] > zl[i - 3] ? 1 : -1;
  add('Trend', 'ZLSMA 32', `${fmt(zl[i])} - slope ${zlSlope === 1 ? 'up' : 'down'}`, zlDir === zlSlope ? zlDir : 0, 5);

  const dm = I.adx(k, 14);
  const adxV = dm.adx[i];
  add('Trend', 'ADX / DI 14', `${adxV.toFixed(1)}`, adxV < 20 ? 0 : (dm.pdi[i] > dm.ndi[i] ? 1 : -1), 5);

  const ich = I.ichimoku(k);
  let ichDir = 0;
  if (nn(ich.cloudTop)) ichDir = price > ich.cloudTop ? 1 : price < ich.cloudBot ? -1 : 0;
  add('Trend', 'Ichimoku cloud', ichDir === 1 ? 'above cloud' : ichDir === -1 ? 'below cloud' : 'inside cloud', ichDir, 5);

  /* --- momentum --- */
  const r14 = I.rsi(close, 14);
  add('Momentum', 'RSI 14', r14[i].toFixed(1), r14[i] > 55 ? 1 : r14[i] < 45 ? -1 : 0, 6);
  const md = I.macd(close, 12, 26, 9);
  const mdDir = md.line[i] > md.signal[i] ? 1 : -1;
  add('Momentum', 'MACD 12/26/9', `hist ${md.hist[i].toFixed(1)}`, (md.hist[i] > 0 ? 1 : -1) === mdDir ? mdDir : 0, 7);
  const sr = I.stochRsi(close, 14, 14, 3, 3);
  add('Momentum', 'Stoch RSI', `K ${sr.k[i].toFixed(0)} / D ${sr.d[i].toFixed(0)}`,
    sr.k[i] > sr.d[i] && sr.k[i] < 80 ? 1 : sr.k[i] < sr.d[i] && sr.k[i] > 20 ? -1 : 0, 4);
  const cc = I.cci(k, 20);
  add('Momentum', 'CCI 20', cc[i].toFixed(0), cc[i] > 100 ? 1 : cc[i] < -100 ? -1 : 0, 3);
  const wr = I.willr(k, 14);
  add('Momentum', 'Williams %R', wr[i].toFixed(1), wr[i] > -50 ? 1 : -1, 3);
  const roc = (close[i] / close[i - 10] - 1) * 100;
  add('Momentum', 'Rate of change 10', `${roc.toFixed(2)}%`, roc > 0.3 ? 1 : roc < -0.3 ? -1 : 0, 3);

  /* --- volatility & structure --- */
  const bb = I.bollinger(close, 20, 2), kc = I.keltner(k, 20, 1.5);
  const pctB = (price - bb.dn[i]) / (bb.up[i] - bb.dn[i]);
  add('Structure', 'Bollinger %B', pctB.toFixed(2), pctB > 0.55 ? 1 : pctB < 0.45 ? -1 : 0, 3);
  const structureRes = I.structure(k);
  add('Structure', 'Market structure', structureRes.label, structureRes.dir, 6);
  const vw = I.vwapAnchored(k, entryTf);
  add('Structure', 'VWAP', `${fmt(vw[i])}`, price > vw[i] ? 1 : -1, 4);

  const d1 = candles['D'];
  if (d1 && d1.length > 2) {
    const p = d1[d1.length - 2];
    const P = (p.h + p.l + p.c) / 3;
    add('Structure', 'Daily pivot', `${fmt(P)}`, price > P ? 1 : -1, 3);
  }

  /* --- volume & flow --- */
  const vAvg = I.sma(k.map(x => x.v), 20)[i];
  const vRatio = k[i].v / vAvg;
  add('Flow', 'Volume vs 20-avg', `${vRatio.toFixed(2)}x`, 0, 3);
  const ob = I.obv(k);
  const obvDir = ob[i] > ob[i - 10] ? 1 : -1;
  add('Flow', 'OBV slope (10)', obvDir === 1 ? 'accumulating' : 'distributing', obvDir, 4);
  const mf = I.mfi(k, 14);
  add('Flow', 'Money flow 14', mf[i].toFixed(1), mf[i] > 55 ? 1 : mf[i] < 45 ? -1 : 0, 3);

  if (ticker) {
    const f = +ticker.fundingRate * 100;
    let fDir = 0;
    if (f > 0.03) fDir = -1;
    else if (f < -0.02) fDir = 1;
    else if (f > 0.005) fDir = 1;
    else if (f < -0.005) fDir = -1;
    add('Flow', 'Funding rate', `${f.toFixed(4)}% / 8h`, fDir, 5);
  }
  if (oi && oi.length > 5) {
    const oiNow = +oi[oi.length - 1].openInterest;
    const oiPrev = +oi[0].openInterest;
    const oiChg = (oiNow / oiPrev - 1) * 100;
    const pChg = (price / k[Math.max(0, i - 24)].c - 1) * 100;
    let dir = 0;
    if (oiChg > 0.5 && pChg > 0) dir = 1;
    else if (oiChg > 0.5 && pChg < 0) dir = -1;
    add('Flow', 'Open interest 24h', `${oiChg > 0 ? '+' : ''}${oiChg.toFixed(2)}%`, dir, 5);
  }
  if (ratio) {
    const lr = +ratio.buyRatio, sr2 = +ratio.sellRatio;
    const skew = lr / (lr + sr2);
    add('Flow', 'Account long/short', `${(lr * 100).toFixed(1)}% long`, skew > 0.72 ? -1 : skew < 0.45 ? 1 : 0, 3);
  }
  if (book) {
    const bid = book.b.reduce((s, x) => s + +x[1], 0);
    const ask = book.a.reduce((s, x) => s + +x[1], 0);
    const imb = (bid - ask) / (bid + ask);
    add('Flow', 'Order book imbalance', `${(imb * 100).toFixed(1)}%`, imb > 0.08 ? 1 : imb < -0.08 ? -1 : 0, 3);
  }
  if (tape) {
    const buy = tape.filter(t => t.S === 'Buy').reduce((s, t) => s + +t.v, 0);
    const sell = tape.filter(t => t.S === 'Sell').reduce((s, t) => s + +t.v, 0);
    const tot = buy + sell, pctBuy = tot ? buy / tot : 0.5;
    add('Flow', 'Taker tape', `${(pctBuy * 100).toFixed(1)}% buy`, pctBuy > 0.55 ? 1 : pctBuy < 0.45 ? -1 : 0, 3);
  }

  /* --- multi timeframe alignment --- */
  const mtf = mtfTfs.map((tf) => {
    const cc2 = candles[tf];
    if (!cc2 || cc2.length < 210) return { tf, dir: 0 };
    const kk = cc2.slice(0, -1), j = kk.length - 1, cl = kk.map(x => x.c);
    const a200 = I.ema(cl, 200)[j], a50 = I.ema(cl, 50)[j];
    const ceD = I.chandelier(kk, 4, 2).dir[j];
    const rr = I.rsi(cl, 14)[j];
    let s = 0;
    s += cl[j] > a200 ? 1 : -1;
    s += a50 > a200 ? 1 : -1;
    s += ceD;
    s += rr > 50 ? 1 : -1;
    return { tf, dir: s >= 2 ? 1 : s <= -2 ? -1 : 0 };
  });
  const aligned = mtf.filter(m => m.dir !== 0);
  const mtfDir = aligned.length && aligned.every(m => m.dir === aligned[0].dir) ? aligned[0].dir : 0;

  /* --- aggregate --- */
  let wsum = 0, tot = 0;
  sig.forEach(s => { wsum += s.weight; tot += s.dir * s.weight; });
  const score = Math.round((tot / wsum) * 100);

  /* --- trade plan --- */
  const a14 = I.atr(k, 14)[i];
  const bias = score >= scoreThreshold ? 1 : score <= -scoreThreshold ? -1 : 0;
  trackFlipEntry(flipStore, symbol, entryTf, bias, price);

  let plan = null;
  if (bias !== 0) {
    const entry = flipEntryPrice(flipStore, symbol, entryTf, price);
    const stopAtr = config.STOP_ATR ?? 1.5;
    let stop = bias === 1 ? entry - stopAtr * a14 : entry + stopAtr * a14;
    if (bias === 1 && ce.dir[i] === 1 && ce.longStop[i] < entry) stop = Math.min(stop, ce.longStop[i]);
    if (bias === -1 && ce.dir[i] === -1 && ce.shortStop[i] > entry) stop = Math.max(stop, ce.shortStop[i]);
    plan = sizeFor({ symbol, equity: account, bias, entry, stop, riskPct, leverage });
  }

  return { symbol, sig, score, bias, plan, mtf, mtfDir, atr: a14, price, closedAt: k[i].t, ce: { dir: ce.dir[i], stop: ceStop } };
}

function fmt(x) { return nn(x) ? (+x).toFixed(2) : '—'; }

module.exports = { analyse, trackFlipEntry, flipEntryPrice };
