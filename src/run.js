#!/usr/bin/env node
// TradeBot — pooled-balance bot trading on Bybit Demo Trading
// (api-demo.bybit.com: mainnet prices, demo funds) via src/exchange.js.
// Signals (ATLAS score, GoldenRatio confluence, CRUCIBLE liquidity
// refinement, scaled T1/T2/T3 exit) are the same as UltimateTradingBot's;
// the money rules differ:
//   - ONE shared balance (config.PORTFOLIO.STARTING_BALANCE) for all coins
//   - each trade puts up config.PORTFOLIO.MARGIN_USDT (or MARGIN_PCT of the balance)
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
const notify = require('./notify');
const shadow = require('./shadow');
const summary = require('./summary');
const { loadEnv } = require('./env');

loadEnv();
// TRADEBOT_MODE is optional; 'demo' is the only mode (older .env files set it).
const MODE = (process.env.TRADEBOT_MODE || 'demo').toLowerCase();
if (MODE !== 'demo') {
  console.error(`Unknown TRADEBOT_MODE "${MODE}" — TradeBot only trades Bybit demo now (TRADEBOT_MODE=demo).`);
  process.exit(1);
}

const P = config.PORTFOLIO;
// Length of one signal candle, and its name for messages ("4H").
const TF_MS = config.ENTRY_TF === 'D' ? 86400000 : +config.ENTRY_TF * 60000;
const TF_LABEL = config.ENTRY_TF === 'D' ? '1D' : TF_MS >= 3600000 ? `${TF_MS / 3600000}H` : `${TF_MS / 60000}m`;
const DIR = path.join(__dirname, '..', 'state', 'demo');
if (Object.keys(config.SETTINGS_APPLIED).length) console.log('settings.json:', JSON.stringify(config.SETTINGS_APPLIED));
for (const e of config.SETTINGS_ERRORS) console.log('settings.json ignored —', e);

/* ---------------- persistence ---------------- */

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, name + '.json'), 'utf8')); } catch (e) { return fallback; }
}
function writeJson(name, data) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, name + '.json'), JSON.stringify(data, null, 2) + '\n');
}
function freshAccount() {
  return { balance: P.STARTING_BALANCE, startingBalance: P.STARTING_BALANCE, marginPct: P.MARGIN_PCT, marginUsdt: P.MARGIN_USDT, riskUsdt: P.RISK_USDT, targetsR: config.TARGETS_R, entryTf: config.ENTRY_TF, leverage: P.LEVERAGE, maxOpenPositions: P.MAX_OPEN_POSITIONS, mode: MODE };
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
    usedSignals: readJson('usedSignals', {}),   // one trade per signal (strategy.rememberSignals)
    shadow: readJson('shadow', null) || shadow.empty(), // what Fibonacci-blocked trades would have done
    summary: readJson('summary', null),         // last daily summary { date, balance }
    commandsDone: readJson('commandsDone', []), // ids of control/commands.json entries already carried out
  };
}
function saveState(st) {
  // Settings are re-stamped every run so the dashboard always shows the live rules.
  delete st.account.riskPct; // pre-MARGIN_PCT field
  st.account.marginPct = P.MARGIN_PCT;
  st.account.marginUsdt = P.MARGIN_USDT;
  st.account.riskUsdt = P.RISK_USDT;
  st.account.targetsR = config.TARGETS_R;
  st.account.entryTf = config.ENTRY_TF;
  // Effective adjustable settings (config.js + control/settings.json) for the dashboard.
  st.account.settings = require('./settings').current(config);
  st.account.settingsDefaults = config.SETTINGS_DEFAULTS;
  st.account.settingsErrors = config.SETTINGS_ERRORS;
  st.account.leverage = P.LEVERAGE;
  st.account.maxOpenPositions = P.MAX_OPEN_POSITIONS;
  st.account.mode = MODE;
  st.account.updatedAt = Date.now();
  for (const k of ['account', 'positions', 'trades', 'flipEntries', 'scores', 'closing', 'seenOrderIds', 'usedSignals', 'shadow', 'summary', 'commandsDone']) writeJson(k, st[k]);
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
// strongest |score| first. A coin held back gets a code in scores.json
// (wait: 'weak' | 'used' | 'stale' | 'fib' | 'chase') so the dashboard can say why.
function entryCandidates(signals, st, events, blocked = [], now = Date.now()) {
  const out = [];
  for (const sig of Object.values(signals)) {
    const { symbol, data, analysis } = sig;
    if (st.positions[symbol]) continue;
    if (analysis.bias === 0 || !analysis.plan) {
      events.push({ symbol, type: 'flat', reason: analysis.bias === 0 ? 'score inside the stand-aside band' : 'no plan', score: analysis.score });
      continue;
    }
    if (Math.abs(analysis.score) < config.ENTRY_MIN_SCORE) {
      if (st.scores[symbol]) st.scores[symbol].wait = 'weak';
      events.push({ symbol, type: 'hold', reason: `score ${analysis.score} is below the entry minimum of ${config.ENTRY_MIN_SCORE}`, score: analysis.score });
      continue;
    }
    if (strategy.signalUsed(st.usedSignals, symbol, analysis.bias)) {
      if (st.scores[symbol]) st.scores[symbol].wait = 'used';
      events.push({ symbol, type: 'hold', reason: 'already traded this signal — waits for the score to go neutral or flip first', score: analysis.score });
      continue;
    }
    const closedAgo = now - (analysis.closedAt + TF_MS);
    if (config.ENTRY_FRESH_MIN != null && closedAgo > config.ENTRY_FRESH_MIN * 60000) {
      if (st.scores[symbol]) st.scores[symbol].wait = 'stale';
      events.push({ symbol, type: 'hold', reason: `signal candle closed ${Math.round(closedAgo / 60000)} min ago — new entries only right after a ${TF_LABEL} close`, score: analysis.score });
      continue;
    }
    const check = strategy.entryFilters({ symbol, data, analysis });
    if (!check.ok) {
      if (st.scores[symbol]) st.scores[symbol].wait = check.code;
      if (check.code === 'fib') blocked.push({ symbol, data, analysis, fibCheck: check.fibCheck });
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

// Remote commands: control/commands.json (committed to the repo, pulled by the
// Mac before every run and sync) lists one-off actions, e.g.
//   [{ "id": "2026-09-24-close", "action": "close-all" }]
// Each id is carried out once and remembered in commandsDone. A command that
// hits an error isn't marked done, so the next sync retries it. Returns true
// if anything was carried out.
async function runCommands(client, st, events) {
  let cmds = [];
  try { cmds = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'control', 'commands.json'), 'utf8')); } catch (e) { return false; }
  let ran = false;
  for (const c of Array.isArray(cmds) ? cmds : []) {
    if (!c || !c.id || st.commandsDone.includes(c.id)) continue;
    if (c.action === 'close-all') {
      const evs = [];
      await exchange.closeAll({ client, st, events: evs });
      events.push(...evs);
      const failed = evs.filter(e => e.type === 'error');
      const closed = evs.filter(e => e.type === 'info').map(e => e.symbol.replace('USDT', ''));
      await notify.push([{
        title: failed.length ? 'Close-all: some positions failed — retrying' : 'All positions closed',
        message: `${closed.length ? 'Closed at market: ' + closed.join(', ') : 'Nothing was open.'} Orders cancelled.` +
          (failed.length ? `\nFailed: ${failed.map(e => e.symbol.replace('USDT', '') + ' (' + e.reason + ')').join(', ')}` : '') +
          '\nThe bot keeps running; coins it just held won\'t reopen on the same signal.',
        tags: ['octagonal_sign'],
      }]);
      if (failed.length) continue;
    } else {
      events.push({ symbol: '-', type: 'error', reason: `unknown command ${c.action} (${c.id})` });
    }
    st.commandsDone.push(c.id);
    ran = true;
  }
  return ran;
}

async function run() {
  const client = exchangeClient(); // fail fast on missing keys
  const st = loadState();
  const events = [];
  await runCommands(client, st, events);
  const signals = await scoreAll(st, events);

  const halt = /^(1|true|yes)$/i.test(process.env.TRADEBOT_HALT || '');
  // A coin whose position closes during this run's reconcile becomes a
  // candidate again next run; coins with an untracked exchange position
  // are skipped inside runExchange.
  // One trade per signal: note which signals reset since last run (a coin
  // whose position Bybit closed since then re-arms one run later, once the
  // reconcile inside runExchange has dropped it).
  strategy.rememberSignals(st.usedSignals, signals, st.positions);
  const blocked = [];
  const candidates = entryCandidates(signals, st, events, blocked);
  await exchange.runExchange({ client, st, signals, candidates, events, halt });
  shadow.update({ shadow: st.shadow, signals, blocked, balance: st.account.balance });
  const daily = summary.due(st);
  strategy.rememberSignals(st.usedSignals, {}, st.positions); // mark what just opened

  saveState(st);
  printSummary(events, st);
  await notify.send(events, st);
  if (daily) await notify.push([daily]);
  else if (config.NOTIFY.HOURLY_STATUS && summary.statusDue()) await notify.push([summary.hourly(st)]);
}

// Quick reconcile for the dashboard between hourly runs: books fills, moves
// the stop to breakeven after T1, forgets closed positions. No signals are
// passed, so it never opens or signal-closes anything.
async function syncOnExchange() {
  const client = exchangeClient();
  const st = loadState();
  // Live mark/P&L fields change constantly; only real changes (fills,
  // closes, stop moves) should trigger a save and upload.
  const snapshot = () => JSON.stringify([st.positions, st.trades, st.closing, st.account.balance],
    (k, v) => (k === 'markPrice' || k === 'unrealisedPnl' ? undefined : v));
  const before = snapshot();
  const events = [];
  const ranCommand = await runCommands(client, st, events);
  await exchange.runExchange({ client, st, signals: {}, candidates: [], events });
  // A new control/settings.json also counts, so the dashboard shows it within minutes.
  const settingsChanged = JSON.stringify(require('./settings').current(config)) !== JSON.stringify(st.account.settings)
    || JSON.stringify(config.SETTINGS_ERRORS) !== JSON.stringify(st.account.settingsErrors || []);
  if (!ranCommand && !settingsChanged && snapshot() === before) { console.log(`[${MODE}] sync: no changes`); return; }
  saveState(st);
  printSummary(events, st);
  await notify.send(events, st);
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
  st.usedSignals = {};
  saveState(st); // trade history is kept
  console.log(`Tracking reset to ${P.STARTING_BALANCE} USDT (this step alone doesn't touch Bybit; scripts/reset.sh also closes everything there).`);
}

/* ---------------- output ---------------- */

function printSummary(events, st) {
  console.log(`\n=== TradeBot [${MODE}] (${P.STARTING_BALANCE} USDT pool, ${P.LEVERAGE}x, ${P.MARGIN_USDT != null ? '$' + P.MARGIN_USDT : P.MARGIN_PCT + '%'} margin/trade, max ${P.MAX_OPEN_POSITIONS}) @ ${new Date().toISOString()} ===\n`);
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
