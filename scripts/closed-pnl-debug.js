#!/usr/bin/env node
// Diagnostic: lists the raw closed-pnl records Bybit returns for one coin,
// per 7-day window over the last N days, plus the default (no time) query.
// Prints no keys. Usage:  node scripts/closed-pnl-debug.js XLMUSDT 25
'use strict';
const { loadEnv } = require('../src/env');
const { sign, ENVIRONMENTS } = require('../src/bybit');
loadEnv();

const symbol = (process.argv[2] || 'XLMUSDT').toUpperCase();
const days = +(process.argv[3] || 25);
const base = ENVIRONMENTS.demo.base;
const key = process.env.BYBIT_API_KEY, secret = process.env.BYBIT_API_SECRET;
const t = (ms) => new Date(+ms).toISOString().slice(0, 16).replace('T', ' ');

async function get(params) {
  const q = new URLSearchParams({ category: 'linear', symbol, limit: '100', ...params }).toString();
  const ts = Date.now().toString();
  const res = await fetch(base + '/v5/position/closed-pnl?' + q, {
    headers: { 'X-BAPI-API-KEY': key, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': '10000', 'X-BAPI-SIGN': sign(secret, ts, key, q) },
  });
  const j = await res.json();
  if (j.retCode !== 0) return console.log('  error', j.retCode, j.retMsg);
  for (const x of j.result.list || []) {
    console.log(`  created ${t(x.createdTime)}  updated ${t(x.updatedTime)}  ${x.side} ${x.orderType} qty ${x.closedSize} @ ${x.avgExitPrice}  pnl ${x.closedPnl}  order ${String(x.orderId).slice(0, 8)}`);
  }
  if (!(j.result.list || []).length) console.log('  (none)');
}

(async () => {
  console.log(`${symbol}: default query (no time)`);
  await get({});
  const WEEK = 7 * 86400000 - 60000, now = Date.now();
  for (let s = now - days * 86400000; s < now; s += WEEK) {
    const e = Math.min(s + WEEK, now);
    console.log(`${symbol}: ${t(s)} -> ${t(e)} UTC`);
    await get({ startTime: String(s), endTime: String(e) });
  }
})().catch(e => { console.error(e.message); process.exit(1); });
