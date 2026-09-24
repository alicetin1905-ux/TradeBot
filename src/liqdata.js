// Real liquidations, tracking only — nothing here affects trading.
//
// Every hourly run pulls OKX's public liquidation feed per coin (it only keeps
// about a day, so it has to be collected as we go) into hourly buckets of
// liquidated longs / shorts in USD. On each new signal candle it stores a
// sample: the last 4h / 24h of liquidations, the signal, and — filled in
// later runs — where price went over the next candle and the next 24h. The
// dashboard's "Real liquidations" card reads the stats from that, to show
// whether a big long flush (or short squeeze) says anything about what comes
// next before any of it is allowed to steer trades.
// State: state/demo/liqlog.json.
'use strict';

const config = require('../config');

const BASE = 'https://www.okx.com/api/v5/public';
const HOUR = 3600000;
const KEEP_HOURS = 7 * 24;
const MAX_SAMPLES = 2500;
const MAX_PAGES = 20;

function empty() { return { ctVal: {}, lastTs: {}, since: {}, hours: {}, samples: [], stats: null }; }

const uly = (symbol) => symbol.replace('USDT', '') + '-USDT';

async function getJson(url, fetchImpl) {
  const r = await fetchImpl(url);
  const d = await r.json();
  if (d.code !== '0') throw new Error(`${url} -> ${d.msg || 'OKX error ' + d.code}`);
  return d.data;
}

// Pulls liquidations newer than lastTs (paging back, newest first) into hourly buckets.
async function collectOne(log, symbol, now, fetchImpl) {
  if (log.ctVal[symbol] == null) {
    const inst = await getJson(`${BASE}/instruments?instType=SWAP&instId=${uly(symbol)}-SWAP`, fetchImpl);
    log.ctVal[symbol] = +inst[0].ctVal;
  }
  const ct = log.ctVal[symbol];
  const last = log.lastTs[symbol] || now - 24 * HOUR;
  const rows = [];
  let after = '', reached = false;
  for (let p = 0; p < MAX_PAGES; p++) {
    const data = await getJson(`${BASE}/liquidation-orders?instType=SWAP&state=filled&uly=${uly(symbol)}&limit=100${after ? '&after=' + after : ''}`, fetchImpl);
    const d = data[0] ? data[0].details : [];
    if (!d.length) break;
    for (const x of d) {
      if (+x.ts <= last) { reached = true; break; }
      rows.push(x);
    }
    if (reached) break;
    after = d[d.length - 1].ts;
  }
  const hours = (log.hours[symbol] = log.hours[symbol] || {});
  let newest = last;
  for (const x of rows) {
    const ts = +x.ts;
    const usd = +x.sz * ct * +x.bkPx;
    const isLong = x.posSide === 'long' || (x.posSide !== 'short' && x.side === 'sell');
    const h = Math.floor(ts / HOUR) * HOUR;
    const b = (hours[h] = hours[h] || [0, 0]);
    b[isLong ? 0 : 1] += usd;
    newest = Math.max(newest, ts);
  }
  log.lastTs[symbol] = newest;
  // Complete coverage starts where we reached the previous point (or the
  // oldest row, if the feed or page limit ran out first — then there's a gap
  // and coverage restarts from there).
  const oldest = rows.length ? +rows[rows.length - 1].ts : now;
  if (!reached && rows.length) log.since[symbol] = oldest;
  else if (!log.since[symbol]) log.since[symbol] = reached ? last : now;
  for (const h of Object.keys(hours)) if (+h < now - KEEP_HOURS * HOUR) delete hours[h];
  return rows.length;
}

async function collect(log, symbols, { now = Date.now(), fetchImpl = fetch, logFn = console.log } = {}) {
  for (const s of symbols) {
    try {
      await collectOne(log, s, now, fetchImpl);
    } catch (err) {
      logFn(`liquidation feed ${s}: ${err.message}`);
    }
  }
}

// Liquidated longs / shorts (USD) in the `hours` hours before `at`.
function windowSum(log, symbol, at, hours) {
  const b = log.hours[symbol] || {};
  let long = 0, short = 0;
  for (const [h, [l, s]] of Object.entries(b)) {
    if (+h >= at - hours * HOUR && +h < at) { long += l; short += s; }
  }
  return { long, short };
}

// On every new closed signal candle: one sample per coin. Forward returns are
// filled in once the later candles have closed. tfMs: signal candle length.
function sample(log, signals, tfMs) {
  const lastT = {};
  for (const x of log.samples) lastT[x.s] = Math.max(lastT[x.s] || 0, x.t);
  for (const [symbol, sig] of Object.entries(signals)) {
    const a = sig.analysis;
    if (!a || a.closedAt == null) continue;
    const t = a.closedAt + tfMs; // the moment the signal candle closed
    if (t > (lastT[symbol] || 0)) {
      const w4 = windowSum(log, symbol, t, 4), w24 = windowSum(log, symbol, t, 24);
      log.samples.push({
        s: symbol, t, p: a.price, sc: a.score, b: a.bias,
        l4: Math.round(w4.long), s4: Math.round(w4.short), l24: Math.round(w24.long), s24: Math.round(w24.short),
        full: (log.since[symbol] || Infinity) <= t - 24 * HOUR, // a whole 24h of liquidations was collected
        f1: null, f24: null,
      });
    }
    // forward returns from the closed candles we have now
    const closed = sig.data && sig.data.candles[config.ENTRY_TF] ? sig.data.candles[config.ENTRY_TF].slice(0, -1) : [];
    const closeAt = new Map(closed.map(c => [c.t + tfMs, c.c])); // close time -> close
    for (const x of log.samples) {
      if (x.s !== symbol) continue;
      if (x.f1 == null && closeAt.has(x.t + tfMs)) x.f1 = +((closeAt.get(x.t + tfMs) / x.p - 1) * 100).toFixed(3);
      if (x.f24 == null && closeAt.has(x.t + 24 * HOUR)) x.f24 = +((closeAt.get(x.t + 24 * HOUR) / x.p - 1) * 100).toFixed(3);
    }
  }
  if (log.samples.length > MAX_SAMPLES) log.samples = log.samples.slice(-MAX_SAMPLES);
  log.stats = stats(log.samples);
}

// Groups complete samples by what the last 4h of liquidations looked like:
// "long flush" = at least 70% of it was longs AND the total was over 2x that
// coin's usual 4h amount; "short squeeze" the same for shorts. For each group:
// how many, average move over the next candle / 24h, and how often up.
function stats(samples) {
  const done = samples.filter(x => x.full && x.f24 != null);
  const med = {};
  for (const s of new Set(done.map(x => x.s))) {
    const tot = done.filter(x => x.s === s).map(x => x.l4 + x.s4).sort((a, b) => a - b);
    med[s] = tot[Math.floor(tot.length / 2)] || 0;
  }
  const group = (x) => {
    const tot = x.l4 + x.s4;
    if (!tot || tot < 2 * med[x.s]) return 'normal';
    if (x.l4 / tot >= 0.7) return 'longFlush';
    if (x.s4 / tot >= 0.7) return 'shortSqueeze';
    return 'normal';
  };
  const out = {};
  for (const g of ['longFlush', 'shortSqueeze', 'normal']) {
    const xs = done.filter(x => group(x) === g);
    const avg = (k) => (xs.length ? +(xs.reduce((a, x) => a + x[k], 0) / xs.length).toFixed(3) : null);
    out[g] = { n: xs.length, avgNext: avg('f1'), avg24: avg('f24'), up24: xs.length ? Math.round(xs.filter(x => x.f24 > 0).length / xs.length * 100) : null };
  }
  out.samples = done.length;
  out.pending = samples.length - done.length;
  return out;
}

module.exports = { empty, collect, sample, windowSum, stats };
