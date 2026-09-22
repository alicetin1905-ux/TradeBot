// Position sizing — ported from ATLAS's sizeFor(), risk-based branch only
// (this bot always sizes by risk %, never "full margin"). Reused directly by
// atlasScore.js's trade plan and re-checked by strategy.js on every trade.
'use strict';

// Exchange lot-size rules need an authenticated instruments-info call to
// fetch live; a conservative generic step keeps paper sizing sane across
// the six coins without needing exchange credentials.
const QTY_STEP = { BTCUSDT: 0.001, ETHUSDT: 0.01, SOLUSDT: 0.1, XRPUSDT: 1, BNBUSDT: 0.01, DOGEUSDT: 1 };

// maxMargin (optional) caps the margin this one position may tie up — the
// pooled balance uses it so several positions share one balance.
// marginPct (optional) sizes by margin instead of risk: margin = marginPct%
// of equity, position value = margin x leverage, whatever the stop distance.
function sizeFor({ symbol, equity, bias, entry, stop, riskPct, leverage, mmr = 0.005, maxMargin = Infinity, marginPct = null }) {
  const risk = Math.abs(entry - stop);
  const step = QTY_STEP[symbol] || 0.001;
  const toStep = (q) => Math.floor(q / step + 1e-9) * step;

  let qty = marginPct != null ? (equity * marginPct / 100 * leverage) / entry : (equity * riskPct / 100) / risk;
  const maxQty = (Math.min(equity, maxMargin) * leverage) / entry;
  const capped = qty > maxQty;
  if (capped) qty = maxQty;
  qty = toStep(qty);

  const notional = qty * entry;
  const margin = notional / leverage;
  const riskAmt = qty * risk;
  const liq = bias === 1 ? entry * (1 - 1 / leverage + mmr) : entry * (1 + 1 / leverage - mmr);

  return {
    bias, entry, stop, risk, qty, notional, margin, leverage, riskAmt, capped, liq,
    t1: entry + bias * risk, t2: entry + bias * 2 * risk, t3: entry + bias * 3 * risk,
    riskShare: equity > 0 ? (riskAmt / equity) * 100 : 0,
    marginShare: equity > 0 ? (margin / equity) * 100 : 0,
    belowMin: qty <= 0,
    liqDist: Math.abs(liq - entry) / entry * 100,
    stopDist: (risk / entry) * 100,
    stopSafe: bias === 1 ? stop > liq : stop < liq,
  };
}

module.exports = { sizeFor, QTY_STEP };
