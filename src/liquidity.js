// Estimated liquidation-cluster model — ported (simplified) from CRUCIBLE
// (alicetin1905-ux/crucible index.html). liqPrice() is exact; the clustering
// pass is a leaner version of CRUCIBLE's full heatmap (fewer bins, most
// recent candles only) since the bot only needs "where's the nearest dense
// cluster" for TP/SL refinement, not a chart to render.
'use strict';

function liqPrice(entry, lev, mmr, isLong) {
  return isLong ? (entry * (1 - 1 / lev)) / (1 - mmr)
                : (entry * (1 + 1 / lev)) / (1 + mmr);
}

// Returns { clusters: [{price, weight}], nearestAbove, nearestBelow }
// candles: recent closed 1h candles. tiers: config.LEV_TIERS. mmr: config.LIQ_MMR.
function estimateClusters(candles, tiers, mmr, bins = 120, lookback = 300) {
  const recent = candles.slice(-lookback);
  if (!recent.length) return { clusters: [], nearestAbove: null, nearestBelow: null };

  const wSum = tiers.reduce((a, t) => a + t.w, 0) || 1;
  const norm = tiers.map(t => ({ lev: t.lev, w: t.w / wSum }));
  const minLev = Math.min(...norm.map(t => t.lev));
  const lo = Math.min(...recent.map(c => c.l)) * (1 - 1 / minLev) * 0.99;
  const hi = Math.max(...recent.map(c => c.h)) * (1 + 1 / minLev) * 1.01;
  const step = (hi - lo) / bins;
  if (!(step > 0)) return { clusters: [], nearestAbove: null, nearestBelow: null };

  const weight = new Float64Array(bins);
  const put = (price, amt) => {
    if (!isFinite(price) || price <= lo || price >= hi) return;
    const k = Math.floor((price - lo) / step);
    if (k >= 0 && k < bins) weight[k] += amt;
  };

  for (const c of recent) {
    if (!c.v) continue;
    const slices = 4, per = c.v / slices;
    for (let s = 0; s < slices; s++) {
      const entry = c.l + ((c.h - c.l) * (s + 0.5)) / slices;
      for (const t of norm) {
        put(liqPrice(entry, t.lev, mmr, true), per * t.w);
        put(liqPrice(entry, t.lev, mmr, false), per * t.w);
      }
    }
  }

  const clusters = [];
  for (let i = 0; i < bins; i++) {
    if (weight[i] > 0) clusters.push({ price: lo + step * (i + 0.5), weight: weight[i] });
  }
  const price = recent[recent.length - 1].c;
  const above = clusters.filter(c => c.price > price).sort((a, b) => b.weight - a.weight)[0] || null;
  const below = clusters.filter(c => c.price < price).sort((a, b) => b.weight - a.weight)[0] || null;
  return { clusters, nearestAbove: above, nearestBelow: below };
}

// Nudges a stop/target away from sitting right on top of a dense cluster,
// and caps a target just short of one big enough to act as a price magnet
// (liquidation cascades often stall or reverse right at a heavy cluster).
function refinePlan(plan, clustersInfo) {
  const out = { ...plan };
  const { nearestAbove, nearestBelow } = clustersInfo;
  const stopCluster = plan.bias === 1 ? nearestBelow : nearestAbove;
  const targetCluster = plan.bias === 1 ? nearestAbove : nearestBelow;

  // If the stop sits within 0.15% of a dense cluster, push it just past it
  // (clusters are exactly where a stop-hunt wick is most likely).
  if (stopCluster && Math.abs(stopCluster.price - plan.stop) / plan.entry < 0.0015) {
    out.stop = plan.bias === 1 ? stopCluster.price * 0.999 : stopCluster.price * 1.001;
  }

  // If T2 would overshoot a dense cluster sitting between entry and T2,
  // pull T2 in just short of it — likelier to actually fill. Only when the
  // pulled-in T2 still lies beyond T1: a cluster before T1 would otherwise
  // drag T2 back toward entry, so T2 would fill below T1 right after it.
  if (targetCluster) {
    const betweenT2 = plan.bias === 1
      ? targetCluster.price > plan.entry && targetCluster.price < plan.t2
      : targetCluster.price < plan.entry && targetCluster.price > plan.t2;
    const pulledT2 = plan.bias === 1 ? targetCluster.price * 0.998 : targetCluster.price * 1.002;
    const beyondT1 = plan.bias === 1 ? pulledT2 > plan.t1 : pulledT2 < plan.t1;
    if (betweenT2 && beyondT1) out.t2 = pulledT2;
  }
  out.liqClusterNote = {
    stopNear: stopCluster ? stopCluster.price : null,
    targetNear: targetCluster ? targetCluster.price : null,
  };
  return out;
}

module.exports = { liqPrice, estimateClusters, refinePlan };
