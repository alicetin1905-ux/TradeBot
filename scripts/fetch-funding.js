#!/usr/bin/env node
// Downloads the funding-rate history of the live coins from Bybit (public
// market data, no API key) into backtest/funding/<SYMBOL>.json as
// [[fundingTime ms, rate], ...], oldest first. Run on the Mac (the cloud
// backtest server cannot reach Bybit), then commit and push the files:
//   node scripts/fetch-funding.js && git add backtest/funding && git commit -m "Funding history" && git push
const fs = require('fs');
const path = require('path');
const config = require('../config');

const OUT = path.join(__dirname, '..', 'backtest', 'funding');
const FROM = Date.UTC(2020, 0, 1);

async function fetchSymbol(symbol) {
  const rows = new Map();
  let end = Date.now();
  for (;;) {
    const url = `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}&limit=200&endTime=${end}`;
    const res = await fetch(url);
    const body = await res.json();
    if (body.retCode !== 0) throw new Error(`${symbol}: ${body.retMsg}`);
    const list = body.result.list || [];
    for (const r of list) rows.set(+r.fundingRateTimestamp, +r.fundingRate);
    if (list.length < 200) break;
    const oldest = Math.min(...list.map(r => +r.fundingRateTimestamp));
    if (oldest <= FROM || oldest >= end) break;
    end = oldest - 1;
    await new Promise(r => setTimeout(r, 120)); // stay well under the rate limit
  }
  return [...rows.entries()].filter(([t]) => t >= FROM).sort((a, b) => a[0] - b[0]);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const symbol of config.SYMBOLS) {
    const rows = await fetchSymbol(symbol);
    fs.writeFileSync(path.join(OUT, symbol + '.json'), JSON.stringify(rows));
    console.log(`${symbol}: ${rows.length} funding rates from ${rows.length ? new Date(rows[0][0]).toISOString().slice(0, 10) : '-'}`);
  }
})().catch(e => { console.error(e.message); process.exit(1); });
