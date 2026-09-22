// Central knobs for the whole bot. Everything else reads from here.
module.exports = {
  // Same six coins ATLAS / GoldenRatio / CRUCIBLE / BTCLiveBoard already track.
  SYMBOLS: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT'],

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
  FIB_THRESHOLD: { BTCUSDT: 2, ETHUSDT: 1, SOLUSDT: 3, XRPUSDT: 3, BNBUSDT: 2, DOGEUSDT: 2 },
  FIB_WINDOW: 12,

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

  // Money rules: all six coins trade out of ONE shared balance.
  PORTFOLIO: {
    STARTING_BALANCE: 1000,  // USDT
    MARGIN_PCT: 25,          // % of the current shared balance put up as margin per trade
    LEVERAGE: 10,            // position value = margin x leverage (250 USDT -> 2500 USDT)
    MAX_OPEN_POSITIONS: 4,   // 4 x 25% = the whole balance
  },
};
