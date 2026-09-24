// Entry gates and entry-plan building used by src/run.js / src/exchange.js:
//   - atlasScore  -> primary signal: weighted score, bias, entry/stop/targets
//   - fib         -> confluence filter: does GoldenRatio's own impulse agree?
//   - liquidity   -> refines stop/T2 away from / short of dense liq clusters
'use strict';

const fib = require('./fib');
const liquidity = require('./liquidity');
const config = require('../config');

function dirName(bias) { return bias === 1 ? 'long' : bias === -1 ? 'short' : 'flat'; }

// Signal-side entry gates that don't depend on account size: GoldenRatio
// confluence and the max-chase distance from the flip entry. src/run.js sizes
// the plan itself.
function entryFilters({ symbol, data, analysis }) {
  const fibCheck = config.USE_FIB === false ? { agrees: true, impulse: null } : fib.confluence({
    candles1h: data.candles[config.ENTRY_TF],
    thresholdPct: config.FIB_THRESHOLD[symbol] ?? 2,
    windowN: config.FIB_WINDOW,
    bias: analysis.bias,
    maxAgeH: config.FIB_MAX_AGE_H,
    recovery: config.FIB_RECOVERY,
  });
  if (!fibCheck.agrees) {
    const imp = fibCheck.impulse;
    return {
      ok: false, code: 'fib', fibCheck,
      reason: `ATLAS wants ${dirName(analysis.bias)} but a fresh ${imp.movePct.toFixed(1)}% ${imp.dir} move (${fibCheck.ageH}h ago, ${Math.round(fibCheck.recovered * 100)}% recovered) still points the other way`,
    };
  }

  const chaseDist = Math.abs(analysis.price - analysis.plan.entry);
  if (chaseDist > config.MAX_CHASE_ATR * analysis.atr) {
    return { ok: false, code: 'chase', reason: 'price has drifted too far from the flip entry to still take it' };
  }
  return { ok: true, fibCheck };
}

// Takes an already-sized plan, liquidity-refines it and builds the
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
  const refined = withTargetsR(liquidity.refinePlan(plan, clusters));

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

// config.TARGETS_R: T1/T2/T3 at those multiples of the (refined) stop
// distance from entry, replacing the plan's own 1R/2R/3R levels.
function withTargetsR(plan) {
  const R = config.TARGETS_R;
  if (!R) return plan;
  const d = Math.abs(plan.entry - plan.stop);
  const at = (m) => plan.entry + plan.bias * d * m;
  return { ...plan, t1: at(R[0]), t2: at(R[1]), t3: at(R[2]) };
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

// One trade per signal: once a coin has been traded in a direction, it can't
// be entered in that direction again until its signal has reset — the score
// went neutral or flipped at least once since. memory[symbol] = { bias, reset }.
function rememberSignals(memory, signals, positions) {
  for (const [symbol, pos] of Object.entries(positions)) {
    const m = memory[symbol];
    if (!m || m.bias !== pos.bias) memory[symbol] = { bias: pos.bias, reset: false };
  }
  for (const [symbol, m] of Object.entries(memory)) {
    const sig = signals[symbol];
    if (sig && sig.analysis.bias !== m.bias) m.reset = true;
    if (m.reset && !positions[symbol]) delete memory[symbol]; // re-armed
  }
}
function signalUsed(memory, symbol, bias) {
  const m = memory[symbol];
  return !!m && !m.reset && m.bias === bias;
}

module.exports = { withTargetsR, entryFilters, openEntry, rememberSignals, signalUsed };
