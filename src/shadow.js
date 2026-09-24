// Shadow trades: what the trades the Fibonacci check blocked would have
// done. Each blocked entry is followed on paper with the same levels, size
// and exit rules a real one would get (40/35/25% at T1/T2/T3, stop to
// breakeven after T1, close on a score flip), replayed on closed signal (4H) candles.
// Nothing here touches Bybit — it's only evidence for whether the check
// earns its place. State: state/demo/shadow.json { open, closed, used }.
'use strict';

const config = require('../config');
const strategy = require('./strategy');
const { sizeFor } = require('./risk');
const { marginPerTrade } = require('./exchange');

const P = config.PORTFOLIO;

function empty() { return { open: {}, closed: [], used: {} }; }

// Walks candles in order; stop is checked first on each candle (worst case
// when stop and a target share a candle).
function replay(pos, candles) {
  const out = [];
  for (const c of candles) {
    if (pos.bias === 1 ? c.l <= pos.stop : c.h >= pos.stop) {
      out.push({ qty: pos.qtyRemaining, price: pos.stop, reason: pos.breakeven ? 'breakeven stop hit' : 'stop hit', at: c.t });
      pos.qtyRemaining = 0;
      return out;
    }
    for (const k of ['t1', 't2', 't3']) {
      if (pos.filled[k]) continue;
      if (!(pos.bias === 1 ? c.h >= pos[k] : c.l <= pos[k])) break;
      const qty = k === 't3' ? pos.qtyRemaining : pos.qty * pos.split[k];
      out.push({ qty, price: pos[k], reason: `${k.toUpperCase()} hit`, at: c.t });
      pos.qtyRemaining -= qty;
      pos.filled[k] = true;
      if (k === (pos.beAfter || 't1')) { pos.stop = pos.entry; pos.breakeven = true; }
      if (k === 't3') return out;
    }
  }
  return out;
}

function book(shadow, pos, fills, closedAt) {
  for (const f of fills) pos.pnl += (f.price - pos.entry) * pos.bias * f.qty;
  if (pos.qtyRemaining <= 1e-12) {
    const last = fills[fills.length - 1];
    shadow.closed.push({
      symbol: pos.symbol, bias: pos.bias, entry: pos.entry, openedAt: pos.openedAt,
      closedAt: last ? last.at : closedAt, pnl: pos.pnl, exitReason: last ? last.reason : 'closed',
      score: pos.score, blockedBy: pos.blockedBy,
    });
    delete shadow.open[pos.symbol];
  }
}

// signals: { symbol: { data, analysis } } from this run; blocked: the entries
// the Fibonacci check held back this run ({ symbol, data, analysis, fibCheck }).
function update({ shadow, signals, blocked, balance }) {
  // 1) advance open shadows over the candles closed since they opened
  for (const pos of Object.values(shadow.open)) {
    const sig = signals[pos.symbol];
    if (!sig) continue;
    const closed = sig.data.candles[config.ENTRY_TF].slice(0, -1).filter(c => c.t > pos.lastCandle);
    if (closed.length) pos.lastCandle = closed[closed.length - 1].t;
    book(shadow, pos, replay(pos, closed), pos.lastCandle);
    if (config.FLIP_EXIT !== false && shadow.open[pos.symbol] && sig.analysis.bias !== 0 && sig.analysis.bias !== pos.bias) {
      const at = sig.analysis.closedAt;
      const fill = { qty: pos.qtyRemaining, price: sig.analysis.price, reason: 'signal-flip', at };
      pos.qtyRemaining = 0;
      book(shadow, pos, [fill], at);
    }
  }

  // 2) one shadow per blocked signal, same one-trade-per-signal rule as real entries
  strategy.rememberSignals(shadow.used, signals, shadow.open);
  for (const b of blocked) {
    if (shadow.open[b.symbol] || strategy.signalUsed(shadow.used, b.symbol, b.analysis.bias)) continue;
    // Same margin and targets a real entry would get (RISK_USDT sizing capped
    // at MARGIN_USDT, or MARGIN_PCT of balance; TARGETS_R levels).
    const entry = b.analysis.price, stop = b.analysis.plan.stop;
    const margin = marginPerTrade(balance, Math.abs(1 - stop / entry));
    const plan = strategy.withTargetsR(sizeFor({
      symbol: b.symbol, equity: balance, bias: b.analysis.bias, entry, stop,
      leverage: P.LEVERAGE, marginPct: (margin / balance) * 100,
    }));
    if (plan.qty <= 0 || (plan.stop - plan.entry) * plan.bias >= 0) continue;
    const [a, c, d] = config.TARGET_SPLIT;
    shadow.open[b.symbol] = {
      symbol: b.symbol, bias: plan.bias, entry: plan.entry, stop: plan.stop, t1: plan.t1, t2: plan.t2, t3: plan.t3,
      qty: plan.qty, qtyRemaining: plan.qty, split: { t1: a, t2: c, t3: d }, filled: { t1: false, t2: false, t3: false },
      breakeven: false, beAfter: config.BREAKEVEN_AFTER || 't1', pnl: 0, score: b.analysis.score, openedAt: b.analysis.closedAt, lastCandle: b.analysis.closedAt,
      blockedBy: b.fibCheck && b.fibCheck.impulse ? `${b.fibCheck.impulse.dir} ${b.fibCheck.impulse.movePct.toFixed(1)}%` : 'fib',
    };
  }
  strategy.rememberSignals(shadow.used, {}, shadow.open);
  if (shadow.closed.length > 500) shadow.closed = shadow.closed.slice(-500);
}

module.exports = { empty, update, replay };
