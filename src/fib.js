// Impulse + Fibonacci retracement detection — ported from GoldenRatio
// (alicetin1905-ux/goldenratio index.html). Used here as a confluence check
// on ATLAS's bias: an impulse that contradicts the score's direction holds
// the trade back rather than letting the score fire alone.
'use strict';

const RATIOS = [-0.618, -0.272, 0, 0.5, 0.618, 1, 1.272, 1.618];

function detectImpulse(candles, thresholdPct, windowN, maxScan) {
  const n = candles.length;
  if (n < 2) return null;
  const scanLimit = Math.max(0, n - (maxScan || 300));
  for (let j = n - 1; j > scanLimit; j--) {
    const start = Math.max(0, j - windowN);
    let loIdx = start, hiIdx = start;
    for (let k = start; k <= j; k++) {
      if (candles[k].l < candles[loIdx].l) loIdx = k;
      if (candles[k].h > candles[hiIdx].h) hiIdx = k;
    }
    const lo = candles[loIdx].l, hi = candles[hiIdx].h;
    if (lo <= 0) continue;
    if (hiIdx > loIdx && ((hi - lo) / lo) * 100 >= thresholdPct) {
      let endIdx = hiIdx, endHi = hi;
      for (let k = hiIdx + 1; k < n; k++) {
        if (candles[k].l < lo) break;
        if (candles[k].h > endHi) { endHi = candles[k].h; endIdx = k; }
      }
      return { dir: 'up', startIdx: loIdx, endIdx, p0: endHi, p1: lo, movePct: ((endHi - lo) / lo) * 100 };
    }
    if (loIdx > hiIdx && ((hi - lo) / hi) * 100 >= thresholdPct) {
      let endIdx = loIdx, endLo = lo;
      for (let k = loIdx + 1; k < n; k++) {
        if (candles[k].h > hi) break;
        if (candles[k].l < endLo) { endLo = candles[k].l; endIdx = k; }
      }
      return { dir: 'down', startIdx: hiIdx, endIdx, p0: endLo, p1: hi, movePct: ((hi - endLo) / hi) * 100 };
    }
  }
  return null;
}

function fibLevels(imp) {
  return RATIOS.map(r => ({ ratio: r, price: imp.p0 + (imp.p1 - imp.p0) * r }));
}

// candles here are {t,o,h,l,c,v}; detectImpulse wants {h,l}.
function confluence({ candles1h, thresholdPct, windowN, bias, maxScan }) {
  const closed = candles1h.slice(0, -1).map(x => ({ h: x.h, l: x.l }));
  const imp = detectImpulse(closed, thresholdPct, windowN, maxScan || 300);
  if (!imp) return { impulse: null, agrees: true, inPocket: false }; // no impulse = neutral, doesn't block

  const impDir = imp.dir === 'up' ? 1 : -1;
  const agrees = bias === 0 || impDir === bias;

  // "golden pocket" — retracement between the 0.5 and 0.618 ratios back
  // from the impulse's terminal extreme (p0) toward its origin (p1).
  const levels = fibLevels(imp);
  const p50 = levels.find(l => l.ratio === 0.5).price;
  const p618 = levels.find(l => l.ratio === 0.618).price;
  const lastClose = candles1h[candles1h.length - 2].c; // last closed candle
  const inPocket = lastClose >= Math.min(p50, p618) && lastClose <= Math.max(p50, p618);

  return { impulse: imp, impDir, agrees, inPocket, levels };
}

module.exports = { RATIOS, detectImpulse, fibLevels, confluence };
