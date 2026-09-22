#!/usr/bin/env node
// TradeBot — pooled-balance paper-trading bot. Signals (ATLAS score,
// GoldenRatio confluence, CRUCIBLE liquidity refinement, scaled T1/T2/T3
// exit) are the same as UltimateTradingBot's; the money rules differ:
//   - ONE shared balance (config.PORTFOLIO.STARTING_BALANCE) for all coins
//   - each trade puts up config.PORTFOLIO.MARGIN_PCT of the current balance
//     as margin; position value = margin x LEVERAGE (the strategy's own stop
//     and targets still decide where it exits)
//   - at most config.PORTFOLIO.MAX_OPEN_POSITIONS open at once; when more
//     coins qualify than there are free slots, the strongest |score| wins
//   - never more margin than is still free
//
// Three modes, picked by TRADEBOT_MODE (env or .env):
//   paper   (default) simulated fills, state in state/*.json — what the
//           hourly GitHub Actions workflow runs
//   demo    real orders on Bybit DEMO TRADING (api-demo.bybit.com: mainnet
//           prices, demo funds) via src/exchange.js, state in state/demo/
//   testnet real orders on Bybit TESTNET (api-testnet.bybit.com), state in
//           state/testnet/
// demo and testnet must run on a machine Bybit doesn't geo-block (README).
//
//   node src/run.js              run once
//   node src/run.js --reset      back to the starting balance (paper: all flat;
//                                demo/testnet: resets tracking only, not Bybit)
//   node src/run.js --close-all  demo/testnet: cancel orders + close everything
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const marketData = require('./okx');
const atlasScore = require('./atlasScore');
const strategy = require('./strategy');
const { sizeFor } = require('./risk');
const { loadEnv } = require('./env');

loadEnv();
const MODE = (process.env.TRADEBOT_MODE || 'paper').toLowerCase();
const EXCHANGE_MODES = ['demo', 'testnet'];
const ON_EXCHANGE = EXCHANGE_MODES.includes(MODE);
if (MODE !== 'paper' && !ON_EXCHANGE) {
  console.error(`Unknown TRADEBOT_MODE "${MODE}" — use paper, demo or testnet.`);
  process.exit(1);
}

const P = config.PORTFOLIO;
const DIR = path.join(__dirname, '..', 'state', ...(ON_EXCHANGE ? [MODE] : []));

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
    closing: readJson('closing', {}),         // demo/testnet: closed positions awaiting their final P&L record
    seenOrderIds: readJson('seenOrderIds', []), // demo/testnet: closed-pnl records already booked
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
  const keys = ['account', 'positions', 'trades', 'flipEntries', 'scores'];
  if (ON_EXCHANGE) keys.push('closing', 'seenOrderIds');
  for (const k of keys) writeJson(k, st[k]);
}

/* ---------------- one run ---------------- */

// Margin still tied up by open positions (scaled down as targets fill).
function usedMargin(positions) {
  return Object.values(positions).reduce((sum, p) => sum + p.margin * (p.qtyRemaining / p.qtyTotal), 0);
}

// Replays candles closed since the position opened against its stop/targets,
// then applies the signal-flip exit if the score has flipped against it.
function manageOpenPosition(symbol, data, analysis, st, events) {
  const openPos = st.positions[symbol];
  const closedSince = data.candles[config.ENTRY_TF].slice(0, -1).filter(c => c.t > openPos.openedAt);
  const outcome = strategy.simulatePositionOutcome(openPos, closedSince);
  const closedAt = closedSince.length ? closedSince[closedSince.length - 1].t : openPos.openedAt;
  for (const ev of outcome.events) {
    events.push(ev);
    st.trades.push({
      symbol, bias: openPos.bias, entry: openPos.entry, exit: ev.price, pnl: ev.pnl,
      reason: ev.reason, openedAt: openPos.openedAt, closedAt, score: openPos.score,
    });
  }
  st.account.balance += outcome.realizedDelta;
  if (outcome.closed) delete st.positions[symbol];
  else st.positions[symbol] = outcome.position;

  const pos = st.positions[symbol];
  if (pos && analysis.bias !== 0 && analysis.bias !== pos.bias) {
    const pnl = (analysis.price - pos.entry) * pos.bias * pos.qtyRemaining;
    st.account.balance += pnl;
    st.trades.push(strategy.closeTradeRecord(pos, analysis.price, pos.qtyRemaining, pnl, 'signal-flip', analysis.closedAt));
    events.push({ symbol, type: 'exit', reason: 'score flipped against open position', pnl, price: analysis.price });
    delete st.positions[symbol];
  }
}

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
// strongest |score| first.
function entryCandidates(signals, positions, events) {
  const out = [];
  for (const sig of Object.values(signals)) {
    const { symbol, data, analysis } = sig;
    if (positions[symbol]) continue;
    if (analysis.bias === 0 || !analysis.plan) {
      events.push({ symbol, type: 'flat', reason: analysis.bias === 0 ? 'score inside the stand-aside band' : 'no plan', score: analysis.score });
      continue;
    }
    const check = strategy.entryFilters({ symbol, data, analysis });
    if (!check.ok) { events.push({ symbol, type: 'hold', reason: check.reason, score: analysis.score }); continue; }
    out.push({ symbol, data, analysis, fibCheck: check.fibCheck });
  }
  return out.sort((a, b) => Math.abs(b.analysis.score) - Math.abs(a.analysis.score));
}

async function runPaper(st, signals, events) {
  for (const symbol of Object.keys(st.positions)) {
    if (signals[symbol]) manageOpenPosition(symbol, signals[symbol].data, signals[symbol].analysis, st, events);
  }

  // Fill free slots, sized off the balance as it stands after this run's exits.
  for (const c of entryCandidates(signals, st.positions, events)) {
    const open = Object.keys(st.positions).length;
    if (open >= P.MAX_OPEN_POSITIONS) {
      events.push({ symbol: c.symbol, type: 'hold', reason: `all ${P.MAX_OPEN_POSITIONS} position slots in use`, score: c.analysis.score });
      continue;
    }
    const balance = st.account.balance;
    const freeMargin = balance - usedMargin(st.positions);
    const plan = sizeFor({
      symbol: c.symbol, equity: balance, bias: c.analysis.bias, entry: c.analysis.plan.entry, stop: c.analysis.plan.stop,
      leverage: P.LEVERAGE, marginPct: P.MARGIN_PCT,
      maxMargin: Math.max(0, freeMargin),
    });
    const opened = strategy.openEntry({ symbol: c.symbol, data: c.data, analysis: c.analysis, plan, fibCheck: c.fibCheck });
    if (!opened.position) { events.push({ symbol: c.symbol, type: 'hold', reason: opened.reason, score: c.analysis.score }); continue; }
    st.positions[c.symbol] = opened.position;
    events.push(opened.event);
  }
}

function exchangeClient() {
  const { createClient } = require('./bybit');
  return createClient({ env: MODE, apiKey: process.env.BYBIT_API_KEY, apiSecret: process.env.BYBIT_API_SECRET });
}

async function run() {
  const client = ON_EXCHANGE ? exchangeClient() : null; // fail fast on missing keys
  const st = loadState();
  const events = [];
  const signals = await scoreAll(st, events);

  if (MODE === 'paper') {
    await runPaper(st, signals, events);
  } else {
    const exchange = require('./exchange');
    const halt = /^(1|true|yes)$/i.test(process.env.TRADEBOT_HALT || '');
    // A coin whose position closes during this run's reconcile becomes a
    // candidate again next run; coins with an untracked exchange position
    // are skipped inside runExchange.
    const candidates = entryCandidates(signals, st.positions, events);
    await exchange.runExchange({ client, st, signals, candidates, events, halt });
  }

  saveState(st);
  printSummary(events, st);
}

async function closeAllOnExchange() {
  if (!ON_EXCHANGE) { console.error('--close-all only applies to TRADEBOT_MODE=demo or testnet'); process.exit(1); }
  const st = loadState();
  const events = [];
  await require('./exchange').closeAll({ client: exchangeClient(), st, events });
  saveState(st);
  printSummary(events, st);
}

function reset() {
  const st = loadState();
  st.account = freshAccount();
  st.positions = {};
  st.flipEntries = {};
  st.scores = {};
  st.closing = {};
  saveState(st); // trade history is kept
  console.log(ON_EXCHANGE
    ? `${MODE} tracking reset to ${P.STARTING_BALANCE} USDT. Nothing was closed on Bybit — use --close-all for that.`
    : `TradeBot reset to ${P.STARTING_BALANCE} USDT — all positions closed, no trades recorded.`);
}

/* ---------------- output ---------------- */

function printSummary(events, st) {
  console.log(`\n=== TradeBot [${MODE}] (${P.STARTING_BALANCE} USDT pool, ${P.LEVERAGE}x, ${P.MARGIN_PCT}% margin/trade, max ${P.MAX_OPEN_POSITIONS}) @ ${new Date().toISOString()} ===\n`);
  for (const ev of events) {
    if (ev.type === 'enter') {
      console.log(`[${ev.symbol}] ENTER ${ev.bias === 1 ? 'LONG' : 'SHORT'} @ ${fmt(ev.entry)} | score ${ev.score} | SL ${fmt(ev.stop)} T1 ${fmt(ev.t1)} T2 ${fmt(ev.t2)} T3 ${fmt(ev.t3)} | qty ${ev.qty} margin $${fmt(ev.margin)} risk $${fmt(ev.riskAmt)}`);
    } else if (ev.type === 'partial' || ev.type === 'exit') {
      console.log(`[${ev.symbol}] ${ev.type === 'exit' ? 'EXIT — ' : ''}${ev.reason} | pnl ${money(ev.pnl)}${ev.price ? ' @ ' + fmt(ev.price) : ''}`);
    } else {
      console.log(`[${ev.symbol}] ${ev.type} — ${ev.reason}${ev.score != null ? ` (score ${ev.score})` : ''}`);
    }
  }
  const open = Object.values(st.positions);
  console.log(`\nbalance $${fmt(st.account.balance)} (started $${fmt(st.account.startingBalance)}) · ${open.length}/${P.MAX_OPEN_POSITIONS} open · margin used $${fmt(usedMargin(st.positions))}`);
  for (const p of open) console.log(`  ${p.symbol.padEnd(9)} ${p.bias === 1 ? 'long ' : 'short'} @ ${fmt(p.entry)}  SL ${fmt(p.stop)}  margin $${fmt(p.margin)}`);
}
function fmt(x) { return (Math.round(x * 100) / 100).toLocaleString('en-US'); }
function money(x) { return `${x < 0 ? '-' : '+'}$${fmt(Math.abs(x))}`; }

if (process.argv.includes('--reset')) {
  reset();
} else if (process.argv.includes('--close-all')) {
  closeAllOnExchange().catch((err) => { console.error(err); process.exit(1); });
} else {
  run().catch((err) => { console.error(err); process.exit(1); });
}
