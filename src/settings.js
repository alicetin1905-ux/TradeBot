// Adjustable settings: control/settings.json (committed to this repo, pulled
// by the Mac before every run) overrides a whitelisted set of config.js
// values, e.g.
//   { "RISK_USDT": 40, "LEVERAGE": 5, "TARGETS_R": [1.5, 3, 4.5] }
// Only keys listed in FIELDS are accepted, each checked against hard limits;
// a missing, unknown or out-of-range value keeps the config.js default and is
// reported in config.SETTINGS_ERRORS (shown on the dashboard). Changes apply
// to new trades; open positions keep the stop/targets they were opened with.
// TRADEBOT_SETTINGS=off skips the file (tests, backtest).
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'control', 'settings.json');

const num = (min, max, { int = false, nullable = false } = {}) => (v) => {
  if (v === null && nullable) return { value: null };
  if (typeof v !== 'number' || !Number.isFinite(v)) return { error: 'must be a number' + (nullable ? ' or null' : '') };
  if (int && !Number.isInteger(v)) return { error: 'must be a whole number' };
  if (v < min || v > max) return { error: `must be between ${min} and ${max}` };
  return { value: v };
};
const oneOf = (...opts) => (v) => (opts.includes(v) ? { value: v } : { error: `must be one of ${opts.map(o => JSON.stringify(o)).join(', ')}` });
const bool = (v) => (typeof v === 'boolean' ? { value: v } : { error: 'must be true or false' });

// Each field: where it lives in config, how it's checked, and a label.
const FIELDS = {
  // Money
  RISK_USDT: { at: ['PORTFOLIO', 'RISK_USDT'], check: num(1, 500, { nullable: true }), label: 'Loss at the stop per trade (USDT, null = always full margin)' },
  MARGIN_USDT: { at: ['PORTFOLIO', 'MARGIN_USDT'], check: num(10, 1000), label: 'Max margin per trade (USDT)' },
  LEVERAGE: { at: ['PORTFOLIO', 'LEVERAGE'], check: num(1, 25, { int: true }), label: 'Leverage' },
  MAX_OPEN_POSITIONS: { at: ['PORTFOLIO', 'MAX_OPEN_POSITIONS'], check: num(1, 8, { int: true }), label: 'Max open positions' },
  MAX_SAME_DIRECTION: { at: ['PORTFOLIO', 'MAX_SAME_DIRECTION'], check: num(1, 8, { int: true, nullable: true }), label: 'Max positions in one direction (null = no limit)' },
  DAILY_LOSS_LIMIT_PCT: { at: ['EXECUTION', 'DAILY_LOSS_LIMIT_PCT'], check: num(1, 100), label: 'Daily loss limit (% of balance)' },
  // Exits
  TARGETS_R: { at: ['TARGETS_R'], check: targets, label: 'T1 / T2 / T3 in R (multiples of the stop distance)' },
  TARGET_SPLIT: { at: ['TARGET_SPLIT'], check: split, label: 'Share closed at T1 / T2 / T3 (sums to 1)' },
  STOP_ATR: { at: ['STOP_ATR'], check: num(0.5, 5), label: 'Stop distance (x ATR, before the Chandelier Exit check)' },
  BREAKEVEN_AFTER: { at: ['BREAKEVEN_AFTER'], check: oneOf('t1', 't2', 'off'), label: 'Move the stop to entry after ("t1", "t2" or "off")' },
  FLIP_EXIT: { at: ['FLIP_EXIT'], check: bool, label: 'Close when the score flips against the trade' },
  // Strategy
  ENTRY_TF: { at: ['ENTRY_TF'], check: oneOf('60', '240'), label: 'Signal timeframe ("60" = 1H, "240" = 4H)' },
  ENTRY_MIN_SCORE: { at: ['ENTRY_MIN_SCORE'], check: num(25, 100, { int: true }), label: 'Min |score| to enter' },
  USE_FIB: { at: ['USE_FIB'], check: bool, label: 'Fibonacci check on' },
  BTC_FILTER: { at: ['BTC_FILTER'], check: bool, label: 'No altcoin trades against BTC\'s signal' },
  MAX_CHASE_ATR: { at: ['MAX_CHASE_ATR'], check: num(0.1, 5), label: 'Max distance from the flip entry (x ATR)' },
  ENTRY_FRESH_MIN: { at: ['ENTRY_FRESH_MIN'], check: num(5, 240, { int: true, nullable: true }), label: 'Enter only within this many minutes of a candle close (null = any time)' },
  SYMBOLS: { at: ['SYMBOLS'], check: null, label: 'Coins to trade' }, // checked against ALL_SYMBOLS below
  // Alerts
  STATUS_EVERY_H: { at: ['NOTIFY', 'STATUS_EVERY_H'], check: num(1, 24, { int: true }), label: 'Status push every N hours' },
};

function targets(v) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(x => typeof x === 'number' && x >= 0.25 && x <= 20)) {
    return { error: 'must be 3 numbers between 0.25 and 20' };
  }
  if (!(v[0] < v[1] && v[1] < v[2])) return { error: 'must be increasing (T1 < T2 < T3)' };
  return { value: v.slice() };
}

function split(v) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(x => typeof x === 'number' && x >= 0 && x <= 1)) {
    return { error: 'must be 3 numbers between 0 and 1' };
  }
  if (Math.abs(v[0] + v[1] + v[2] - 1) > 0.001) return { error: 'must add up to 1' };
  if (v[2] <= 0) return { error: 'T3 share must be above 0' };
  return { value: v.slice() };
}

const get = (cfg, at) => at.reduce((o, k) => o[k], cfg);
function set(cfg, at, value) {
  const parent = at.slice(0, -1).reduce((o, k) => o[k], cfg);
  parent[at[at.length - 1]] = value; // mutate in place: modules hold references to PORTFOLIO etc.
}
const clone = (v) => (Array.isArray(v) ? v.slice() : v);

function current(cfg) {
  return Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, clone(get(cfg, f.at))]));
}

// Applies overrides to cfg; returns { applied, errors, defaults }.
function apply(cfg, overrides) {
  const defaults = current(cfg);
  const applied = {};
  const errors = [];
  if (overrides == null) return { applied, errors, defaults };
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    return { applied, errors: ['settings.json must be a JSON object'], defaults };
  }
  for (const [key, raw] of Object.entries(overrides)) {
    if (key.startsWith('_')) continue; // comments
    const f = FIELDS[key];
    if (!f) { errors.push(`${key}: unknown setting (ignored)`); continue; }
    let res;
    if (key === 'SYMBOLS') {
      const all = cfg.ALL_SYMBOLS;
      res = Array.isArray(raw) && raw.length && raw.every(s => all.includes(s)) && new Set(raw).size === raw.length
        ? { value: all.filter(s => raw.includes(s)) }
        : { error: `must be a list of coins from ${all.join(', ')}` };
    } else {
      res = f.check(raw);
    }
    if (res.error) { errors.push(`${key}: ${res.error} — kept ${JSON.stringify(get(cfg, f.at))}`); continue; }
    set(cfg, f.at, res.value);
    applied[key] = clone(res.value);
  }
  return { applied, errors, defaults };
}

// Reads control/settings.json and applies it. Never throws: a broken file
// keeps every default and says why.
function load(cfg, file = FILE) {
  if (/^(off|0|false)$/i.test(process.env.TRADEBOT_SETTINGS || '')) return apply(cfg, null);
  let overrides = null;
  try {
    if (fs.existsSync(file)) overrides = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    const r = apply(cfg, null);
    r.errors.push(`control/settings.json is not valid JSON (${err.message}) — using config.js defaults`);
    return r;
  }
  return apply(cfg, overrides);
}

module.exports = { FIELDS, apply, load, current };
