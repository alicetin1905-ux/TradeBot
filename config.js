// Central knobs for the whole bot. Everything else reads from here.
// control/settings.json can override the adjustable ones (src/settings.js)
// without touching this file — these are the defaults.
const config = module.exports = {
  // The six coins ATLAS / GoldenRatio / CRUCIBLE / BTCLiveBoard track, plus HYPE and SUI.
  SYMBOLS: ['SOLUSDT', 'DOGEUSDT', 'SUIUSDT', 'ENAUSDT', 'WLDUSDT', 'DYDXUSDT', 'GALAUSDT', 'EGLDUSDT', 'NEARUSDT', 'XLMUSDT', 'BLURUSDT', 'SANDUSDT', 'AXSUSDT', 'ZILUSDT', 'CHZUSDT', 'POPCATUSDT', 'PIUSDT', 'GRAMUSDT', 'AEROUSDT', '1000PEPEUSDT'],
  // Every coin the bot knows (SYMBOLS can be narrowed to a subset of these;
  // close-all always covers all of them).
  ALL_SYMBOLS: ['BTCUSDT', 'SOLUSDT', 'DOGEUSDT', 'SUIUSDT', 'ENAUSDT', 'WLDUSDT', 'DYDXUSDT', 'GALAUSDT', 'EGLDUSDT', 'NEARUSDT', 'XLMUSDT', 'BLURUSDT', 'SANDUSDT', 'AXSUSDT', 'ZILUSDT', 'CHZUSDT', 'POPCATUSDT', 'PIUSDT', 'GRAMUSDT', 'AEROUSDT', '1000PEPEUSDT'],

  // Signal timeframe: entries, flips and levels are decided on closed 4H
  // candles (OKX "4H", UTC-aligned). The 1H version didn't cover its fees in
  // the backtest (backtest/REPORT.md); 4H with wider targets did.
  ENTRY_TF: '240',
  // New entries only on the run right after a signal candle closes (within
  // this many minutes of the close), like the backtest; a signal that's still
  // standing an hour or more later isn't chased. null = any time.
  ENTRY_FRESH_MIN: 60,

  // Where the score's candles and flow data come from: 'bybit' (the exchange
  // the bot trades on, OKX as fallback) or 'okx'. Liquidation tracking and the
  // backtest always use OKX.
  MARKET_DATA: 'bybit',

  // Multi-timeframe alignment check, same set ATLAS's own panel uses.
  MTF_TFS: ['30', '60', '240', 'D'],

  // How the score is computed (src/atlasScore.js): 'classic' (flat sum of
  // -1/0/+1 votes) or 'graded' (ATLAS's newer strength-weighted group blend);
  // MTF_TRIM shrinks it up to 35% when higher timeframes disagree. The 2020-26
  // score lab (backtest/SCORE_LAB.md) found neither better than classic.
  SCORE_MODE: 'classic',
  MTF_TRIM: false,

  // ATLAS's bias threshold: |score| below this is "stand aside".
  SCORE_THRESHOLD: 25,
  // A new trade needs a stronger score than that: |score| of at least this.
  // (SCORE_THRESHOLD still decides when a signal counts as flipped — which
  // closes an open trade — and when a used signal has reset.)
  ENTRY_MIN_SCORE: 50,
  // Per-coin override of ENTRY_MIN_SCORE, e.g. { SUIUSDT: 35 }. Empty: the
  // walk-forward check (backtest/SCORE_WF.md) found per-coin scores don't
  // beat a flat 50 once coins share the slots.
  ENTRY_MIN_SCORE_BY_SYMBOL: {},

  // GoldenRatio's own per-coin impulse thresholds (%) — set earlier on the
  // FIBO page itself, reused here so the confluence check agrees with what
  // that page would actually flag as an impulse for each coin.
  // HYPE / SUI weren't on the FIBO page: set from their own 1H volatility
  // (HYPE moves like SOL/XRP, SUI a bit more — median 12h move ~1.7% / ~1.9%).
  FIB_THRESHOLD: { BTCUSDT: 2, ETHUSDT: 1, SOLUSDT: 3, XRPUSDT: 3, BNBUSDT: 2, DOGEUSDT: 2, HYPEUSDT: 3, SUIUSDT: 4, ENAUSDT: 2, WLDUSDT: 2, DYDXUSDT: 2, LDOUSDT: 2, GALAUSDT: 2, KAITOUSDT: 2 }, // newer coins: the 2% default they were backtested with
  FIB_WINDOW: 12,
  // A contradicting impulse only blocks while it's fresh (ended within this
  // many closed signal candles — 4H now, so 24h) AND price hasn't won back this share of it yet —
  // i.e. "don't buy right into a fresh dump", not "never buy after a dump".
  FIB_MAX_AGE_H: 6,
  FIB_RECOVERY: 0.618,

  // CRUCIBLE's own leverage-tier mix, used to estimate where clustered
  // liquidations sit above/below price.
  LEV_TIERS: [{ lev: 10, w: 35 }, { lev: 25, w: 30 }, { lev: 50, w: 22 }, { lev: 100, w: 13 }],
  LIQ_MMR: 0.005,

  // Don't chase a flip that's drifted too far from the current price before
  // this run got to it — matches "a trade plan whose entry keeps sliding
  // isn't a plan" from ATLAS's own flip-entry comment, capped at 1x ATR.
  MAX_CHASE_ATR: 1,

  // Scaled exit ladder — close part of the position at each target instead
  // of all-or-nothing, and move the stop to breakeven once T1 fills so a
  // full round-trip back to entry can't turn a winner into a loser.
  TARGET_SPLIT: [0.40, 0.35, 0.25], // T1 / T2 / T3 shares, must sum to 1
  // T1 / T2 / T3 at these multiples of the stop distance (R) from entry.
  // null = the strategy's own levels (1R / 2R / 3R, T2 liquidity-refined).
  TARGETS_R: [1.5, 2.5, 3.5],
  // Stop = entry -/+ this many ATRs, widened to the Chandelier Exit stop when that's further.
  STOP_ATR: 1.5,
  // Move the stop to entry once this target fills: 't1', 't2' or 'off'.
  BREAKEVEN_AFTER: 't1',
  // After T2 fills, move the stop up to T1 (locks T1's profit on the rest).
  LOCK_T1_AFTER_T2: true,
  // Close at market when the score flips firmly against an open trade.
  FLIP_EXIT: true,
  // GoldenRatio Fibonacci confluence check on entries.
  USE_FIB: true,
  // No altcoin entry while BTC's own signal points the other way.
  BTC_FILTER: true,

  // Money rules: all coins trade out of ONE shared balance.
  PORTFOLIO: {
    STARTING_BALANCE: 2000,  // USDT
    RISK_PCT: 2.5,           // risk this % of the balance per trade (overrides RISK_USDT); null = use RISK_USDT
                             // backtest/RISK_STARTS.md: about the profit of a fixed $100 with smaller drops
    RISK_USDT: 100,          // max loss at the stop per trade: the position is sized so a stop costs this much
                             // (capped at MARGIN_USDT x LEVERAGE, so tight stops don't blow up the size); null = always full MARGIN_USDT
    MARGIN_USDT: 400,        // max margin per trade in USDT (fixed margin when RISK_USDT is null); null = use MARGIN_PCT
    MARGIN_PCT: 10,          // % of the current shared balance put up as margin per trade (when MARGIN_USDT is null)
    LEVERAGE: 10,            // position value = margin x leverage (100 USDT -> 1000 USDT)
    MAX_OPEN_POSITIONS: 5,
    MAX_NEW_PER_CANDLE: 3,   // at most this many new trades per 4H signal candle (null = no limit)
    MAX_SAME_DIRECTION: 4,   // at most this many longs (and this many shorts) open at once
  },

  // Bybit execution safety limits.
  EXECUTION: {
    // No new entries for the rest of the UTC day once today's realized loss
    // reaches this % of the day's starting balance. Open positions keep
    // their exchange-side stops/targets either way.
    DAILY_LOSS_LIMIT_PCT: 20,
  },

  // Phone alerts through the ntfy app (src/notify.js). Subscribe to this
  // topic in ntfy; NTFY_TOPIC in .env overrides it, NTFY_TOPIC=off disables.
  NOTIFY: {
    SERVER: 'https://ntfy.sh/',
    NTFY_TOPIC: 'tradebot-i50rjyd7igft',
    CLICK_URL: 'https://alicetin1905-ux.github.io/TradeBot/',
    // Daily summary: sent by the first hourly run at/after this hour, in the
    // running Mac's local time.
    DAILY_SUMMARY_HOUR: 8,
    // Status push (open trades with live P&L, equity, free slots), sent at
    // low priority (quiet). false turns it off.
    HOURLY_STATUS: true,
    // ...only on the run right after every Nth UTC hour — 4 = after each 4H
    // close (00/04/08/12/16/20 UTC), in step with the 4H signals. 1 = hourly.
    STATUS_EVERY_H: 4,
    // Watchdog (GitHub Actions, scripts/watchdog.js): alert when the bot's
    // last hourly run is older than this, repeat every REPEAT_H while it stays down.
    WATCHDOG_MAX_AGE_MIN: 130,
    WATCHDOG_REPEAT_H: 6,
  },
};

// control/settings.json overrides (validated; see src/settings.js).
const settings = require('./src/settings').load(config);
config.SETTINGS_APPLIED = settings.applied;
config.SETTINGS_ERRORS = settings.errors;
config.SETTINGS_DEFAULTS = settings.defaults;
