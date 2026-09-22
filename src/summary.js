// Daily summary push: balance and change since the last summary, realized
// P&L of the last 24h, overall win rate, open trades and what the Fibonacci
// check's blocked (shadow) trades would have made. Sent once a day by the
// first full hourly run at/after config.NOTIFY.DAILY_SUMMARY_HOUR (local time).
'use strict';

const config = require('../config');

const DAY_MS = 86400000;
const coin = (s) => s.replace('USDT', '');
const money = (x) => `${x < 0 ? '-' : '+'}$${Math.abs(x).toFixed(2)}`;

function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// One P&L per real position: T1/T2/T3 fills of one trade are grouped.
function positionsFrom(trades) {
  const g = {};
  for (const t of trades) {
    const k = t.symbol + ':' + t.openedAt;
    g[k] = g[k] || { symbol: t.symbol, pnl: 0, closedAt: 0 };
    g[k].pnl += t.pnl;
    g[k].closedAt = Math.max(g[k].closedAt, t.closedAt);
  }
  return Object.values(g);
}

function build(st, now) {
  const a = st.account;
  const last = st.summary || {};
  const since = last.balance != null ? a.balance - last.balance : a.balance - a.startingBalance;
  const day = st.trades.filter(t => t.closedAt >= now - DAY_MS).reduce((s, t) => s + t.pnl, 0);
  const pos = positionsFrom(st.trades);
  const wins = pos.filter(p => p.pnl > 0.005).length, losses = pos.filter(p => p.pnl < -0.005).length;
  const open = Object.values(st.positions);
  const shadow = (st.shadow && st.shadow.closed) || [];
  const shadowPnl = shadow.reduce((s, t) => s + t.pnl, 0);

  const lines = [
    `Balance $${a.balance.toFixed(2)} (${money(since)} since ${last.date ? 'yesterday' : 'start'}; started $${a.startingBalance.toFixed(0)})`,
    `Last 24h realized: ${money(day)}`,
    pos.length ? `All trades: ${wins}W / ${losses}L (${Math.round((wins / pos.length) * 100)}% win)` : 'No closed trades yet',
    open.length
      ? `Open ${open.length}/${config.PORTFOLIO.MAX_OPEN_POSITIONS}: ${open.map(p => `${coin(p.symbol)} ${p.bias === 1 ? 'long' : 'short'}`).join(', ')}`
      : `Open 0/${config.PORTFOLIO.MAX_OPEN_POSITIONS}`,
  ];
  if (shadow.length) lines.push(`Fib-blocked trades: ${shadow.length}, would have made ${money(shadowPnl)}`);
  return { title: `TradeBot daily · ${money(since)}`, message: lines.join('\n'), tags: ['bar_chart'] };
}

// Returns the message if today's summary is due (and marks it sent), else null.
function due(st, now = Date.now()) {
  const today = localDate(now);
  if (new Date(now).getHours() < config.NOTIFY.DAILY_SUMMARY_HOUR) return null;
  if (st.summary && st.summary.date === today) return null;
  const msg = build(st, now);
  st.summary = { date: today, balance: st.account.balance };
  return msg;
}

module.exports = { due, build, positionsFrom };
