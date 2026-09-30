# TradeBot on TradingView

`tradebot_atlas_4h.pine` is the bot's strategy as a TradingView **strategy**
(Pine Script v6), for one coin per chart.

## Use it

1. Open a **4H** chart of a USDT perpetual, e.g. `BYBIT:SOLUSDT.P`, with **normal
   candles** (not Heikin Ashi — those are averaged prices; the strategy refuses
   to trade on them because the score and fills would be wrong and far too good).
2. Pine Editor → paste the whole file → **Add to chart**.
3. Results are in **Strategy Tester** (TradingView's own backtest on that coin).

Settings (gear icon) match the bot: min score 50, signal at ±25, max 1× ATR
from the signal price, Fibonacci check, BTC filter, stop 1.5× ATR (widened to
the Chandelier Exit), targets 1.5/3/4.5R closing 20/30/50%, stop to entry
after T1 and to T1 after T2, close on a signal flip, 3.75% risk, max $400
margin at 10x, Bybit taker fee 0.055%.

On the chart: stop (red) and targets (teal) while in a trade, the signal
price (grey dots), a green/red background when |score| ≥ 50, and a table with
the coin's score, BTC's score and whether price is still in entry range.
Alerts: create an alert on the strategy to get entries on your phone.

## Differences from the live bot

- **Score:** price/volume indicators only. The live bot also uses funding,
  open interest, long/short ratio, order book and taker tape (~20% of the
  weight), which TradingView doesn't provide in a strategy. Expect scores a
  few points apart; this matches the repo's backtest instead.
- **One coin per chart:** no 7 slots, max 4 per direction, max 3 new per
  candle or daily loss limit — those need all coins together.
- Fills at the next 4H candle's open (the bot enters at :01, 1 minute after
  the close). The small liquidation-cluster stop nudge is left out.
- Fibonacci threshold is one input (2% default); the bot uses 1% for ETH and
  3–4% for SOL, XRP, HYPE and SUI.
