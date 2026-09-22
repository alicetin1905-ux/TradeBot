// Entry gates and paper-broker fill simulation shared by src/run.js
// (no real orders — see README):
//   - atlasScore  -> primary signal: weighted score, bias, entry/stop/targets
//   - fib         -> confluence filter: does GoldenRatio's own impulse agree?
//   - liquidity   -> refines stop/T2 away from / short of dense liq clusters
// Then simulates fills candle-by-candle since the position was opened
// (not just "is price past X right now"), with a scaled T1/T2/T3 exit and
// stop moved to breakeven once T1 fills.
'use strict';

const fib = require('./fib');
const liquidity = require('./liquidity');
const config = require('../config');

function dirName(bias) { return bias === 1 ? 'long' : bias === -1 ? 'short' : 'flat'; }

// Signal-side entry gates that don't depend on account size: GoldenRatio
// confluence and the max-chase distance from the flip entry. src/run.js sizes
// the plan itself.
function entryFilters({ symbol, data, analysis }) {
  const fibCheck = fib.confluence({
    candles1h: data.candles[config.ENTRY_TF],
    thresholdPct: config.FIB_THRESHOLD[symbol] ?? 2,
    windowN: config.FIB_WINDOW,
    bias: analysis.bias,
  });
  if (!fibCheck.agrees) {
    return { ok: false, code: 'fib', reason: `ATLAS wants ${dirName(analysis.bias)} but GoldenRatio's last impulse still points the other way` };
  }

  const chaseDist = Math.abs(analysis.price - analysis.plan.entry);
  if (chaseDist > config.MAX_CHASE_ATR * analysis.atr) {
    return { ok: false, code: 'chase', reason: 'price has drifted too far from the flip entry to still take it' };
  }
  return { ok: true, fibCheck };
}

// Takes an already-sized plan, liquidity-refines it and builds the paper
// position + its 'enter' event. Returns { reason } instead if it sizes to zero.
function openEntry({ symbol, data, analysis, plan, fibCheck }) {
  if (plan.qty <= 0 || plan.belowMin) {
    return { reason: 'position size rounds to zero at this risk/entry/stop' };
  }

  const clusters = liquidity.estimateClusters(
    data.candles[config.ENTRY_TF].slice(0, -1),
    config.LEV_TIERS,
    config.LIQ_MMR,
  );
  const refined = liquidity.refinePlan(plan, clusters);

  const position = openPositionFromPlan(symbol, refined, analysis, fibCheck);
  const event = {
    symbol, type: 'enter', bias: analysis.bias, score: analysis.score,
    entry: refined.entry, stop: refined.stop, t1: refined.t1, t2: refined.t2, t3: refined.t3,
    qty: refined.qty, margin: refined.margin, riskAmt: refined.riskAmt,
    fibNote: fibCheck.impulse ? `${fibCheck.impulse.dir} impulse agrees${fibCheck.inPocket ? ', price in golden pocket' : ''}` : 'no recent GoldenRatio impulse (neutral)',
    liqNote: refined.liqClusterNote,
  };
  return { position, event };
}

function openPositionFromPlan(symbol, plan, analysis, fibCheck) {
  const split = config.TARGET_SPLIT;
  return {
    symbol,
    bias: plan.bias,
    entry: plan.entry,
    stop: plan.stop,
    initialStop: plan.stop,
    t1: plan.t1, t2: plan.t2, t3: plan.t3,
    qtyTotal: plan.qty,
    qtyRemaining: plan.qty,
    qtyT1: plan.qty * split[0],
    qtyT2: plan.qty * split[1],
    qtyT3: plan.qty * split[2],
    margin: plan.margin,
    notional: plan.notional,
    riskAmt: plan.riskAmt,
    filled: { t1: false, t2: false, t3: false },
    breakeven: false,
    openedAt: analysis.closedAt,
    score: analysis.score,
    fibImpulse: fibCheck.impulse ? fibCheck.impulse.dir : null,
    liqClusterNote: plan.liqClusterNote,
  };
}

function closeTradeRecord(pos, exitPrice, qty, pnl, reason, closedAt) {
  return {
    symbol: pos.symbol, bias: pos.bias, entry: pos.entry, exit: exitPrice, qty, pnl,
    reason, openedAt: pos.openedAt, closedAt, score: pos.score,
  };
}

// Walks candles chronologically; on each one, checks in this order: stop
// first (conservative — assumes the worst if both stop and a target are
// inside the same candle's range), then any remaining targets low-to-high
// of distance from entry. Moves stop to breakeven once T1 fills.
function simulatePositionOutcome(position, candles) {
  const pos = { ...position, filled: { ...position.filled } };
  let realizedDelta = 0;
  const events = [];

  for (const c of candles) {
    const hitStop = pos.bias === 1 ? c.l <= pos.stop : c.h >= pos.stop;
    if (hitStop) {
      const pnl = (pos.stop - pos.entry) * pos.bias * pos.qtyRemaining;
      realizedDelta += pnl;
      events.push({ symbol: pos.symbol, type: 'exit', reason: pos.breakeven ? 'breakeven stop hit' : 'stop hit', pnl, price: pos.stop });
      return { closed: true, position: pos, realizedDelta, events };
    }

    if (!pos.filled.t1) {
      const hitT1 = pos.bias === 1 ? c.h >= pos.t1 : c.l <= pos.t1;
      if (hitT1) {
        const pnl = (pos.t1 - pos.entry) * pos.bias * pos.qtyT1;
        realizedDelta += pnl;
        pos.qtyRemaining -= pos.qtyT1;
        pos.filled.t1 = true;
        pos.stop = pos.entry; // move to breakeven
        pos.breakeven = true;
        events.push({ symbol: pos.symbol, type: 'partial', reason: 'T1 hit, stop moved to breakeven', pnl, price: pos.t1 });
      }
    }
    if (pos.filled.t1 && !pos.filled.t2) {
      const hitT2 = pos.bias === 1 ? c.h >= pos.t2 : c.l <= pos.t2;
      if (hitT2) {
        const pnl = (pos.t2 - pos.entry) * pos.bias * pos.qtyT2;
        realizedDelta += pnl;
        pos.qtyRemaining -= pos.qtyT2;
        pos.filled.t2 = true;
        events.push({ symbol: pos.symbol, type: 'partial', reason: 'T2 hit', pnl, price: pos.t2 });
      }
    }
    if (pos.filled.t2 && !pos.filled.t3) {
      const hitT3 = pos.bias === 1 ? c.h >= pos.t3 : c.l <= pos.t3;
      if (hitT3) {
        const pnl = (pos.t3 - pos.entry) * pos.bias * pos.qtyT3;
        realizedDelta += pnl;
        pos.qtyRemaining -= pos.qtyT3;
        pos.filled.t3 = true;
        events.push({ symbol: pos.symbol, type: 'exit', reason: 'T3 hit, position closed', pnl, price: pos.t3 });
        return { closed: true, position: pos, realizedDelta, events };
      }
    }
  }
  return { closed: false, position: pos, realizedDelta, events };
}

module.exports = { simulatePositionOutcome, entryFilters, openEntry, closeTradeRecord };
