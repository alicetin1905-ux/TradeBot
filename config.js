// Central knobs for the whole bot. Everything else reads from here.
module.exports = {
  // The six coins ATLAS / GoldenRatio / CRUCIBLE / BTCLiveBoard track, plus HYPE and SUI.
  SYMBOLS: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT', 'HYPEUSDT', 'SUIUSDT'],

  // ATLAS's own default read timeframe for its trade plan / BTCLiveBoard's
  // "ATLAS 1H score" — entries are decided on closed 1H candles only.
  ENTRY_TF: '60',

  // Multi-timeframe alignment check, same set ATLAS's own panel uses.
  MTF_TFS: ['30', '60', '240', 'D'],

  // ATLAS's bias threshold: |score| below this is "stand aside".
  SCORE_THRESHOLD: 25,

  // GoldenRatio's own per-coin impulse thresholds (%) — set earlier on the
  // FIBO page itself, reused here so the confluence check agrees with what
  // that page would actually flag as an impulse for each coin.
  // HYPE / SUI weren't on the FIBO page: set from their own 1H volatility
  // (HYPE moves like SOL/XRP, SUI a bit more — median 12h move ~1.7% / ~1.9%).
  FIB_THRESHOLD: { BTCUSDT: 2, ETHUSDT: 1, SOLUSDT: 3, XRPUSDT: 3, BNBUSDT: 2, DOGEUSDT: 2, HYPEUSDT: 3, SUIUSDT: 4 },
  FIB_WINDOW: 12,
  // A contradicting impulse only blocks while it's fresh (ended within this
  // many closed 1H candles) AND price hasn't won back this share of it yet —
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

  // Money rules: all coins trade out of ONE shared balance.
  PORTFOLIO: {
    STARTING_BALANCE: 1000,  // USDT
    MARGIN_PCT: 10,          // % of the current shared balance put up as margin per trade
    LEVERAGE: 10,            // position value = margin x leverage (100 USDT -> 1000 USDT)
    MAX_OPEN_POSITIONS: 8,   // 8 x 10% = at most 80% of the balance in use
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
    // Hourly status push after every hourly run: open trades with live P&L,
    // equity, free slots. Sent at low priority (quiet). false turns it off.
    HOURLY_STATUS: true,
    // Watchdog (GitHub Actions, scripts/watchdog.js): alert when the bot's
    // last hourly run is older than this, repeat every REPEAT_H while it stays down.
    WATCHDOG_MAX_AGE_MIN: 130,
    WATCHDOG_REPEAT_H: 6,
  },
};
