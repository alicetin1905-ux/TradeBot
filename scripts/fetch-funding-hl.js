#!/usr/bin/env node
// Funding-rate history from Hyperliquid (public, no key; history from May 2023)
// as a stand-in for Bybit's, which the cloud backtest server cannot reach.
// Hourly rates are summed per 8 hours (the Bybit funding period) into
// backtest/funding-hl/<BYBIT SYMBOL>.json as [[periodStart ms, rate per 8h], ...].
const fs = require('fs');
const path = require('path');
const config = require('../config');

const OUT = path.join(__dirname, '..', 'backtest', 'funding-hl');
const H8 = 8 * 3600e3;
const coinOf = (sym) => { const b = sym.replace(/USDT$/, ''); return b.startsWith('1000') ? 'k' + b.slice(4) : b; };

async function post(body) {
  for (let i = 0; i < 6; i++) {
    const res = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (res.status === 429) { await new Promise(r => setTimeout(r, 5000 * (i + 1))); continue; }
    return res.json();
  }
  throw new Error('rate limited');
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const meta = await post({ type: 'meta' });
  const listed = new Set(meta.universe.map(x => x.name));
  for (const sym of ['BTCUSDT', ...config.SYMBOLS]) {
    const coin = coinOf(sym);
    if (!listed.has(coin)) { console.log(`${sym}: not on Hyperliquid`); continue; }
    const per8 = new Map();
    let start = Date.UTC(2023, 0, 1);
    for (;;) {
      const rows = await post({ type: 'fundingHistory', coin, startTime: start });
      if (!Array.isArray(rows) || !rows.length) break;
      for (const r of rows) { const k = Math.floor(r.time / H8) * H8; per8.set(k, (per8.get(k) || 0) + +r.fundingRate); }
      const last = rows[rows.length - 1].time;
      if (rows.length < 500 || last <= start) break;
      start = last + 1;
      await new Promise(r => setTimeout(r, 400));
    }
    const out = [...per8.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => [t, +v.toPrecision(6)]);
    fs.writeFileSync(path.join(OUT, sym + '.json'), JSON.stringify(out));
    console.log(`${sym}: ${out.length} 8h periods from ${out.length ? new Date(out[0][0]).toISOString().slice(0, 10) : '-'}`);
  }
})().catch(e => { console.error(e.message); process.exit(1); });
