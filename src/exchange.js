// Exchange executor — turns the strategy's decisions into real orders on a
// Bybit Demo Trading account (see bybit.js).
//
// Per run:
//   1. Reconcile every tracked position with the exchange: record realized
//      fills (closed-pnl, net of fees), detect T1/T2 fills from the shrinking
//      position size, move the stop to breakeven after T1, close on a signal
//      flip, and forget positions the exchange has fully closed.
//   2. Open new positions into free slots (strongest |score| first):
//      margin = MARGIN_PCT of the allocated balance, x LEVERAGE, market entry
//      with the stop attached, then reduce-only limit orders for T1/T2/T3.
//
// The stop and targets live ON the exchange, so they still work if this
// machine goes down between runs. The strategy's levels come from OKX
// mainnet candles; they're carried over to the exchange as % distances from
// its own fill price (OKX and Bybit prices differ slightly).
'use strict';

const config = require('../config');
const strategy = require('./strategy');
const { sizeFor } = require('./risk');

const P = config.PORTFOLIO;
const DAY_MS = 86400000;

function floorStep(x, step) { return Math.floor(x / step + 1e-9) * step; }
function roundStep(x, step) {
  const dp = Math.max(0, (String(step).split('.')[1] || '').length);
  return +(Math.round(x / step) * step).toFixed(dp);
}
function fixStep(x, step) {
  const dp = Math.max(0, (String(step).split('.')[1] || '').length);
  return +x.toFixed(dp);
}

// Allocation = the capital this bot may use on the account: the configured
// starting balance plus everything it has realized since. Sizing uses the
// smaller of this and the exchange's own equity, so a big demo wallet
// still trades like the configured 1000 USDT account.
function sizingBase(st, wallet) { return Math.max(0, Math.min(st.account.balance, wallet.equity)); }

function usedMargin(positions) {
  return Object.values(positions).reduce((s, p) => s + p.margin * (p.qtyRemaining / p.qtyTotal), 0);
}

function reasonFor(pos, orderId) {
  const o = pos.orders || {};
  if (orderId && orderId === o.t1) return 'T1 hit, stop moved to breakeven';
  if (orderId && orderId === o.t2) return 'T2 hit';
  if (orderId && orderId === o.t3) return 'T3 hit, position closed';
  if (orderId && orderId === o.close) return 'signal-flip';
  return pos.breakeven ? 'breakeven stop hit' : 'stop hit';
}

// Pulls closed-pnl records for one position since its last sync and appends
// any new ones to the trade log; returns the realized sum added.
async function recordFills(client, st, pos, events) {
  const seen = new Set(st.seenOrderIds);
  const records = await client.getClosedPnl(pos.symbol, pos.openedAt - 60000);
  let added = 0;
  for (const r of records.sort((a, b) => a.at - b.at)) {
    if (seen.has(r.orderId) || r.at < pos.openedAt - 60000) continue;
    seen.add(r.orderId);
    st.seenOrderIds.push(r.orderId);
    const reason = reasonFor(pos, r.orderId);
    st.trades.push({
      symbol: pos.symbol, bias: pos.bias, entry: pos.entry, exit: r.exit, qty: r.qty, pnl: r.pnl,
      reason, openedAt: pos.openedAt, closedAt: r.at, score: pos.score,
    });
    events.push({ symbol: pos.symbol, type: /T[12] hit/.test(reason) ? 'partial' : 'exit', reason, pnl: r.pnl, price: r.exit });
    st.account.balance += r.pnl;
    added += r.pnl;
  }
  if (st.seenOrderIds.length > 1000) st.seenOrderIds = st.seenOrderIds.slice(-1000);
  return added;
}

async function reconcile({ client, st, exPos, signals, events, now }) {
  // Positions closed earlier whose final closed-pnl record may have landed late.
  for (const [sym, pos] of Object.entries(st.closing)) {
    await recordFills(client, st, pos, events);
    if (now - pos.closedDetectedAt > DAY_MS) delete st.closing[sym];
  }

  for (const sym of Object.keys(st.positions)) {
    const pos = st.positions[sym];
    try {
      await recordFills(client, st, pos, events);
      const live = exPos[sym];

      if (!live || live.bias !== pos.bias) {
        await client.cancelAll(sym); // leftover reduce-only target orders
        pos.closedDetectedAt = now;
        st.closing[sym] = pos;
        delete st.positions[sym];
        if (!events.some(e => e.symbol === sym && e.type === 'exit')) {
          events.push({ symbol: sym, type: 'exit', reason: 'closed on exchange (P&L record pending)', pnl: 0 });
        }
        continue;
      }

      pos.qtyRemaining = live.size;
      pos.markPrice = live.markPrice;         // Bybit's own live view, for the hourly status
      pos.unrealisedPnl = live.unrealisedPnl;
      const eps = pos.qtyTotal * 1e-6;
      if (!pos.filled.t1 && live.size <= pos.qtyTotal - pos.qtyT1 + eps) pos.filled.t1 = true;
      if (!pos.filled.t2 && pos.qtyT2 > 0 && live.size <= pos.qtyT3 + eps) pos.filled.t2 = true;

      if (pos.filled.t1 && !pos.breakeven) {
        try {
          const be = pos.tickSize ? roundStep(pos.entry, pos.tickSize) : pos.entry;
          await client.setStopLoss(sym, be);
          pos.stop = be;
          pos.breakeven = true;
          events.push({ symbol: sym, type: 'info', reason: 'T1 filled, exchange stop moved to breakeven' });
        } catch (err) {
          // Price already back through entry: a breakeven stop would have
          // triggered, so close what's left now.
          const id = await client.closeMarket({ symbol: sym, bias: pos.bias, qty: live.size });
          pos.orders = { ...pos.orders, close: id };
          pos.breakeven = true;
          events.push({ symbol: sym, type: 'info', reason: `couldn't move stop to breakeven (${err.message}) — closed at market` });
          await recordFills(client, st, pos, events);
          pos.closedDetectedAt = now;
          st.closing[sym] = pos;
          delete st.positions[sym];
          delete exPos[sym];
          continue;
        }
      }

      const sig = signals[sym];
      if (st.positions[sym] && sig && sig.analysis.bias !== 0 && sig.analysis.bias !== pos.bias) {
        await client.cancelAll(sym);
        const id = await client.closeMarket({ symbol: sym, bias: pos.bias, qty: live.size });
        pos.orders = { ...pos.orders, close: id };
        events.push({ symbol: sym, type: 'info', reason: 'score flipped against open position — closed at market' });
        await recordFills(client, st, pos, events);
        pos.closedDetectedAt = now;
        st.closing[sym] = pos;
        delete st.positions[sym];
        delete exPos[sym];
      }
    } catch (err) {
      events.push({ symbol: sym, type: 'error', reason: err.message });
    }
  }
}

// Splits qty into the T1/T2/T3 shares on the exchange's lot step; a slice
// below the minimum order size is folded into the next target.
function splitTargets(qty, inst) {
  const [a, b] = config.TARGET_SPLIT;
  let q1 = floorStep(qty * a, inst.qtyStep);
  let q2 = floorStep(qty * b, inst.qtyStep);
  let q3 = qty - q1 - q2;
  if (q1 < inst.minOrderQty) { q2 += q1; q1 = 0; }
  if (q2 < inst.minOrderQty) { q3 += q2; q2 = 0; }
  return [q1, q2, q3].map(q => fixStep(q, inst.qtyStep));
}

function dailyLossHit(st, now) {
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const today = st.trades.filter(t => t.closedAt >= dayStart).reduce((s, t) => s + t.pnl, 0);
  const startOfDay = st.account.balance - today;
  return today < 0 && -today >= startOfDay * config.EXECUTION.DAILY_LOSS_LIMIT_PCT / 100;
}

async function openEntries({ client, st, exPos, wallet, candidates, events, halt, now }) {
  if (!candidates.length) return;
  const block =
    halt ? 'trading halted (TRADEBOT_HALT) — no new entries'
      : dailyLossHit(st, now) ? `daily loss limit (${config.EXECUTION.DAILY_LOSS_LIMIT_PCT}%) reached — no new entries until 00:00 UTC`
        : null;
  if (block) {
    for (const c of candidates) events.push({ symbol: c.symbol, type: 'hold', reason: block, score: c.analysis.score });
    return;
  }

  let available = wallet.available;
  for (const c of candidates) {
    const sym = c.symbol;
    const hold = (reason) => events.push({ symbol: sym, type: 'hold', reason, score: c.analysis.score });
    try {
      if (exPos[sym]) { hold('a position is already open on the exchange for this coin'); continue; }
      if (Object.keys(exPos).length >= P.MAX_OPEN_POSITIONS) { hold(`all ${P.MAX_OPEN_POSITIONS} position slots in use`); continue; }

      const base = sizingBase(st, wallet);
      const margin = Math.min(base * P.MARGIN_PCT / 100, base - usedMargin(st.positions), available * 0.95);
      if (margin <= 0) { hold('no free margin'); continue; }

      // Strategy levels (with GoldenRatio/CRUCIBLE refinement) as % of entry.
      const basePlan = sizeFor({
        symbol: sym, equity: base, bias: c.analysis.bias, entry: c.analysis.plan.entry, stop: c.analysis.plan.stop,
        leverage: P.LEVERAGE, marginPct: P.MARGIN_PCT,
      });
      const opened = strategy.openEntry({ symbol: sym, data: c.data, analysis: c.analysis, plan: basePlan, fibCheck: c.fibCheck });
      if (!opened.position) { hold(opened.reason); continue; }
      const lv = opened.position;
      const ratio = (x) => x / lv.entry;

      const inst = await client.getInstrument(sym);
      const mark = await client.getMarkPrice(sym);
      const qty = fixStep(floorStep((margin * P.LEVERAGE) / mark, inst.qtyStep), inst.qtyStep);
      if (qty < inst.minOrderQty || qty * mark < (inst.minNotional || 0)) { hold(`size ${qty} is below Bybit's minimum order`); continue; }

      const stopLoss = roundStep(mark * ratio(lv.stop), inst.tickSize);
      if ((stopLoss - mark) * c.analysis.bias >= 0) { hold('stop would be on the wrong side of the Bybit price'); continue; }

      await client.setLeverage(sym, P.LEVERAGE);
      const entryId = await client.openMarket({ symbol: sym, bias: c.analysis.bias, qty, stopLoss });

      const after = await client.getPositions();
      const live = after[sym];
      if (!live) { events.push({ symbol: sym, type: 'error', reason: `entry order ${entryId} sent but no position showed up` }); continue; }

      const entry = live.avgPrice;
      const tp = [lv.t1, lv.t2, lv.t3].map(t => roundStep(entry * ratio(t), inst.tickSize));
      const [q1, q2, q3] = splitTargets(live.size, inst);
      const orders = { entry: entryId };
      const slices = [['t1', q1, tp[0]], ['t2', q2, tp[1]], ['t3', q3, tp[2]]];
      for (const [k, q, price] of slices) {
        if (q <= 0) continue;
        try {
          orders[k] = await client.placeTakeProfit({ symbol: sym, bias: c.analysis.bias, qty: q, price });
        } catch (err) {
          events.push({ symbol: sym, type: 'error', reason: `${k.toUpperCase()} order failed (stop is still in place): ${err.message}` });
        }
      }

      const posMargin = (live.size * entry) / P.LEVERAGE;
      st.positions[sym] = {
        symbol: sym, bias: c.analysis.bias, entry, stop: stopLoss, initialStop: stopLoss,
        t1: tp[0], t2: tp[1], t3: tp[2],
        qtyTotal: live.size, qtyRemaining: live.size, qtyT1: q1, qtyT2: q2, qtyT3: q3,
        margin: posMargin, notional: live.size * entry, riskAmt: live.size * Math.abs(entry - stopLoss),
        filled: { t1: q1 === 0, t2: q2 === 0, t3: false }, breakeven: false,
        openedAt: now, score: c.analysis.score, orders, tickSize: inst.tickSize,
        markPrice: live.markPrice || entry, unrealisedPnl: live.unrealisedPnl || 0,
      };
      exPos[sym] = live;
      available -= posMargin;
      events.push({
        symbol: sym, type: 'enter', bias: c.analysis.bias, score: c.analysis.score, entry, stop: stopLoss,
        t1: tp[0], t2: tp[1], t3: tp[2], qty: live.size, margin: posMargin, riskAmt: st.positions[sym].riskAmt,
      });
    } catch (err) {
      events.push({ symbol: sym, type: 'error', reason: err.message });
    }
  }
}

async function runExchange({ client, st, signals, candidates, events, halt = false, now = Date.now() }) {
  const wallet = await client.getWallet();
  const exPos = await client.getPositions();
  await reconcile({ client, st, exPos, signals, events, now });
  await openEntries({ client, st, exPos, wallet, candidates, events, halt, now });
  st.account.exchangeEquity = wallet.equity;
}

// Emergency flatten: cancel every order and market-close every position on
// the bot's coins, tracked or not.
async function closeAll({ client, st, events, now = Date.now() }) {
  const exPos = await client.getPositions();
  for (const sym of config.SYMBOLS) {
    try {
      await client.cancelAll(sym);
      const live = exPos[sym];
      if (!live) continue;
      const id = await client.closeMarket({ symbol: sym, bias: live.bias, qty: live.size });
      events.push({ symbol: sym, type: 'info', reason: `closed ${live.size} at market` });
      const pos = st.positions[sym];
      if (pos) {
        pos.orders = { ...pos.orders, close: id };
        pos.closedDetectedAt = now;
        st.closing[sym] = pos;
        delete st.positions[sym];
      }
    } catch (err) {
      events.push({ symbol: sym, type: 'error', reason: err.message });
    }
  }
}

module.exports = { runExchange, closeAll, splitTargets, sizingBase, usedMargin };
