# TradeBot

Auto trading bot — a pooled-balance paper-trading bot for BTC, ETH, SOL, XRP,
BNB and DOGE perps. It uses the same signal stack as
[UltimateTradingBot](https://github.com/alicetin1905-ux/UltimateTradingBot):

- **ATLAS** — primary signal: ~25-indicator weighted score, Chandelier Exit
  stop, flip-triggered entry (`src/indicators.js`, `src/atlasScore.js`).
- **GoldenRatio** — confluence filter: a contradicting Fibonacci impulse
  holds the trade back (`src/fib.js`).
- **CRUCIBLE** — liquidation-cluster model that nudges stops off dense
  clusters and pulls T2 in short of them (`src/liquidity.js`).

## This is paper trading only

**No API keys, no exchange account, no real orders.** The bot reads OKX's
public market-data endpoints, decides what it *would* do, and tracks the
result in `state/*.json` against a simulated balance. Treat every number as
a research read on the strategy, not investment advice.

## Rules (`config.js` → `PORTFOLIO`)

- **One shared 1000 USDT balance** for all six coins.
- **25% of the current balance as margin per trade**, at **10x leverage**:
  on 1000 USDT each trade is 250 USDT margin = 2500 USDT position value.
  The strategy's own stop/targets decide the exit, so the loss at the stop
  is 2500 x the stop distance (e.g. a 1.5% stop loses ~37.5 USDT).
- **Max 4 open positions** (4 x 25% = the whole balance). If more coins
  qualify than there are free slots, the strongest |score| gets the slot. A
  trade never uses more margin than is still free.
- Entries decided on closed 1H candles only — nothing repaints intrabar.
- Scaled exit: 40% off at T1 (1R), 35% at T2 (2R), 25% at T3 (3R), with the
  stop moved to breakeven the moment T1 fills. A firm score flip against an
  open position closes it.

## Running it

```
node src/run.js           # one run
node src/run.js --reset   # back to 1000 USDT, all positions closed
```

Requires Node 18+ (native `fetch`), no dependencies.

## Automation

`.github/workflows/bot.yml` runs `node src/run.js` every hour at :05 and
commits the changed `state/*.json` back to this repo — that commit is how
the bot remembers balances and open positions between runs. The
"Reset account" workflow (`reset.yml`) resets it. No secrets are needed.

`index.html` is the dashboard; it reads `state/*.json` from this repo's
`main` branch, so it works from GitHub Pages (Settings → Pages → deploy
from branch `main`, root).
