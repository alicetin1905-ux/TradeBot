#!/usr/bin/env node
// TradeBot — pooled-balance bot trading on Bybit Demo Trading
// (api-demo.bybit.com: mainnet prices, demo funds) via src/exchange.js.
// Signals (ATLAS score, GoldenRatio confluence, CRUCIBLE liquidity
// refinement, scaled T1/T2/T3 exit) are the same as UltimateTradingBot's;
// the money rules differ:
//   - ONE shared balance (config.PORTFOLIO.STARTING_BALANCE) for all coins
//   - each trade puts up config.PORTFOLIO.MARGIN_PCT of the current balance
//     as margin; position value = margin x LEVERAGE (the strategy's own stop
//     and targets still decide where it exits)
//   - at most config.PORTFOLIO.MAX_OPEN_POSITIONS open at once; when more
//     coins qualify than there are free slots, the strongest |score| wins
//   - never more margin than is still free
//
// State lives in state/demo/*.json. Must run on a machine Bybit doesn't
// geo-block (README); keys come from .env.
//
//   node src/run.js              run once
//   node src/run.js --reset      back to the starting balance (tracking only,
//                                doesn't touch Bybit; scripts/reset.sh does both)
//   node src/run.js --close-all  cancel orders + close everything on Bybit
//   node src/run.js --sync       sync positions/fills from Bybit only — no
//                                market data, no new entries; state is written
//                                only if something changed
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const marketData = require('./okx');
const atlasScore = require('./atlasScore');
const strategy = require('./strategy');
const exchange = require('./exchange');
const { loadEnv } = require('./env');

loadEnv();
// TRADEBOT_MODE is optional; 'demo' is the only mode (older .env files set it).
const MODE = (process.env.TRADEBOT_MODE || 'demo').toLowerCase();
if (MODE !== 'demo') {
  console.error(`Unknown TRADEBOT_MODE "${MODE}" — TradeBot only trades Bybit demo now (TRADEBOT_MODE=demo).`);
  process.exit(1);
}

const P = config.PORTFOLIO;
const DIR = path.join(__dirname, '..', 'state', 'demo');

/* ---------------- persistence ---------------- */

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, name + '.json'), 'utf8')); } catch (e) { return fallback; }
}
function writeJson(name, data) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, name + '.json'), JSON.stringify(data, null, 2) + '\n');
}
function freshAccount() {
  return { balance: P.STARTING_BALANCE, startingBalance: P.STARTING_BALANCE, marginPct: P.MARGIN_PCT, leverage: P.LEVERAGE, maxOpenPositions: P.MAX_OPEN_POSITIONS, mode: MODE };
}
function loadState() {
  return {
    account: readJson('account', null) || freshAccount(),
    positions: readJson('positions', {}),
    trades: readJson('trades', []),
    flipEntries: readJson('flipEntries', {}),
    scores: readJson('scores', {}),
    closing: readJson('closing', {}),         // closed positions awaiting their final P&L record
    seenOrderIds: readJson('seenOrderIds', []), // closed-pnl records already booked
  };
}
function saveState(st) {
  // Settings are re-stamped every run so the dashboard always shows the live rules.
  delete st.account.riskPct; // pre-MARGIN_PCT field
  st.account.marginPct = P.MARGIN_PCT;
  st.account.leverage = P.LEVERAGE;
  st.account.maxOpenPositions = P.MAX_OPEN_POSITIONS;
  st.account.mode = MODE;
  st.account.updatedAt = Date.now();
  for (const k of ['account', 'positions', 'trades', 'flipEntries', 'scores', 'closing', 'seenOrderIds']) writeJson(k, st[k]);
}

/* ---------------- one run ---------------- */

// Scores every coin (records it for the dashboard) and returns
// { symbol: { symbol, data, analysis } } for the ones with enough history.
async function scoreAll(st, events) {
  const signals = {};
  for (const symbol of config.SYMBOLS) {
    try {
      const data = await marketData.loadSymbolData(symbol, config.MTF_TFS, config.ENTRY_TF);
      const analysis = atlasScore.analyse({
        symbol, candles: data.candles, ticker: data.ticker, oi: data.oi, ratio: data.ratio,
        book: data.book, tape: data.tape, entryTf: config.ENTRY_TF, mtfTfs: config.MTF_TFS,
        flipStore: st.flipEntries, account: st.account.balance, riskPct: P.MARGIN_PCT,
        leverage: P.LEVERAGE, scoreThreshold: config.SCORE_THRESHOLD,
      });
      if (!analysis) { events.push({ symbol, type: 'skip', reason: 'not enough candle history yet' }); continue; }
      st.scores[symbol] = { score: analysis.score, bias: analysis.bias, at: Date.now() };
      signals[symbol] = { symbol, data, analysis };
    } catch (err) {
      events.push({ symbol, type: 'error', reason: err.message });
    }
  }
  return signals;
}

// Coins with no open position whose signal passes the entry gates,
// strongest |score| first. A coin held back by a gate gets the gate's code
// in scores.json (wait: 'fib' | 'chase') so the dashboard can say why.
function entryCandidates(signals, st, events) {
  const out = [];
  for (const sig of Object.values(signals)) {
    const { symbol, data, analysis } = sig;
    if (st.positions[symbol]) continue;
    if (analysis.bias === 0 || !analysis.plan) {
      events.push({ symbol, type: 'flat', reason: analysis.bias === 0 ? 'score inside the stand-aside band' : 'no plan', score: analysis.score });
      continue;
    }
    const check = strategy.entryFilters({ symbol, data, analysis });
    if (!check.ok) {
      if (st.scores[symbol]) st.scores[symbol].wait = check.code;
      events.push({ symbol, type: 'hold', reason: check.reason, score: analysis.score });
      continue;
    }
    out.push({ symbol, data, analysis, fibCheck: check.fibCheck });
  }
  return out.sort((a, b) => Math.abs(b.analysis.score) - Math.abs(a.analysis.score));
}

function exchangeClient() {
  const { createClient } = require('./bybit');
  return createClient({ env: MODE, apiKey: process.env.BYBIT_API_KEY, apiSecret: process.env.BYBIT_API_SECRET });
}

async function run() {
  const client = exchangeClient(); // fail fast on missing keys
  const st = loadState();
  const events = [];
  const signals = await scoreAll(st, events);

  const halt = /^(1|true|yes)$/i.test(process.env.TRADEBOT_HALT || '');
  // A coin whose position closes during this run's reconcile becomes a
  // candidate again next run; coins with an untracked exchange position
  // are skipped inside runExchange.
  const candidates = entryCandidates(signals, st, events);
  await exchange.runExchange({ client, st, signals, candidates, events, halt });

  saveState(st);
  printSummary(events, st);
}

// Quick reconcile for the dashboard between hourly runs: books fills, moves
// the stop to breakeven after T1, forgets closed positions. No signals are
// passed, so it never opens or signal-closes anything.
async function syncOnExchange() {
  const client = exchangeClient();
  const st = loadState();
  const snapshot = () => JSON.stringify([st.positions, st.trades, st.closing, st.account.balance]);
  const before = snapshot();
  const events = [];
  await exchange.runExchange({ client, st, signals: {}, candidates: [], events });
  if (snapshot() === before) { console.log(`[${MODE}] sync: no changes`); return; }
  saveState(st);
  printSummary(events, st);
}

async function closeAllOnExchange() {
  const st = loadState();
  const events = [];
  await exchange.closeAll({ client: exchangeClient(), st, events });
  saveState(st);
  printSummary(events, st);
  // Non-zero exit if anything failed to close, so scripts/reset.sh stops
  // before wiping the bot's tracking of a position that's still open.
  if (events.some(e => e.type === 'error')) process.exitCode = 1;
}

function reset() {
  const st = loadState();
  st.account = freshAccount();
  st.positions = {};
  st.flipEntries = {};
  st.scores = {};
  st.closing = {};
  saveState(st); // trade history is kept
  console.log(`Tracking reset to ${P.STARTING_BALANCE} USDT (this step alone doesn't touch Bybit; scripts/reset.sh also closes everything there).`);
}

/* ---------------- output ---------------- */

function printSummary(events, st) {
  console.log(`\n=== TradeBot [${MODE}] (${P.STARTING_BALANCE} USDT pool, ${P.LEVERAGE}x, ${P.MARGIN_PCT}% margin/trade, max ${P.MAX_OPEN_POSITIONS}) @ ${new Date().toISOString()} ===\n`);
  for (const ev of events) {
    if (ev.type === 'enter') {
      console.log(`[${ev.symbol}] ENTER ${ev.bias === 1 ? 'LONG' : 'SHORT'} @ ${px(ev.entry)} | score ${ev.score} | SL ${px(ev.stop)} T1 ${px(ev.t1)} T2 ${px(ev.t2)} T3 ${px(ev.t3)} | qty ${ev.qty} margin $${fmt(ev.margin)} risk $${fmt(ev.riskAmt)}`);
    } else if (ev.type === 'partial' || ev.type === 'exit') {
      console.log(`[${ev.symbol}] ${ev.type === 'exit' ? 'EXIT — ' : ''}${ev.reason} | pnl ${money(ev.pnl)}${ev.price ? ' @ ' + px(ev.price) : ''}`);
    } else {
      console.log(`[${ev.symbol}] ${ev.type} — ${ev.reason}${ev.score != null ? ` (score ${ev.score})` : ''}`);
    }
  }
  const open = Object.values(st.positions);
  console.log(`\nbalance $${fmt(st.account.balance)} (started $${fmt(st.account.startingBalance)}) · ${open.length}/${P.MAX_OPEN_POSITIONS} open · margin used $${fmt(exchange.usedMargin(st.positions))}`);
  for (const p of open) console.log(`  ${p.symbol.padEnd(9)} ${p.bias === 1 ? 'long ' : 'short'} @ ${px(p.entry)}  SL ${px(p.stop)}  margin $${fmt(p.margin)}`);
}
function fmt(x) { return (Math.round(x * 100) / 100).toLocaleString('en-US'); }
// Prices keep enough decimals to tell levels apart on cheap coins (DOGE, XRP).
function px(x) {
  const a = Math.abs(x);
  const dp = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 4 : 5;
  return (+x).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function money(x) { return `${x < 0 ? '-' : '+'}$${fmt(Math.abs(x))}`; }

if (process.argv.includes('--reset')) {
  reset();
} else if (process.argv.includes('--sync')) {
  syncOnExchange().catch((err) => { console.error(err); process.exit(1); });
} else if (process.argv.includes('--close-all')) {
  closeAllOnExchange().catch((err) => { console.error(err); process.exit(1); });
} else {
  run().catch((err) => { console.error(err); process.exit(1); });
}
