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

## Modes

| `TRADEBOT_MODE` | What it does | State |
|---|---|---|
| `paper` (default) | Simulated fills. This is what the hourly GitHub Actions workflow runs. | `state/*.json` |
| `testnet` | **Real orders on Bybit's testnet** (test funds, not real money). | `state/testnet/*.json` |

There is no live/real-money mode in this build: the Bybit client only talks to
`api-testnet.bybit.com` and refuses any other host.

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

## Bybit testnet mode

Same signals and rules as paper, but executed on a Bybit testnet account:

- **Entry:** market order with the **stop attached to the position** in the
  same request, then three reduce-only limit orders for T1/T2/T3
  (40/35/25%). Stops and targets live on Bybit, so they keep working if the
  machine running the bot is off.
- **Levels:** the strategy reads OKX mainnet candles; its stop/targets are
  carried over as % distances from Bybit's actual fill price, because
  testnet prices can drift from mainnet.
- **Sizing:** 25% of the bot's **allocation** as margin at 10x. The allocation
  starts at 1000 USDT and moves with realized P&L (from Bybit's closed-P&L
  records, net of fees), so a testnet wallet with 50,000 test USDT still
  trades like a 1000 USDT account. Never more margin than Bybit says is free.
- **Each hourly run:** books fills, moves the stop to breakeven on Bybit once
  T1 fills, closes at market on a firm score flip, cancels leftover target
  orders after a close, then fills free slots (max 4). Any open USDT-perp
  position on the account, including ones the bot didn't open, counts as a
  used slot; the bot leaves positions it didn't open alone. Best to give the
  bot its own (sub-)account.
- **Safety:**
  - `TRADEBOT_HALT=1` stops new entries (open positions keep their stops/targets).
  - Daily loss limit: no new entries for the rest of the UTC day once
    today's realized loss reaches 20% of the day's starting balance
    (`config.js` → `EXECUTION.DAILY_LOSS_LIMIT_PCT`).
  - `node src/run.js --close-all` cancels all orders and market-closes every
    position on the six coins.

### Where it can run

Bybit geo-blocks GitHub Actions (and many cloud regions) — testnet mode has
to run on your own computer or a small VPS in a region Bybit serves. The
paper workflow on GitHub Actions is unaffected.

### Setup

1. Create a testnet account at <https://testnet.bybit.com>, use a
   **Unified Trading Account** in **one-way** position mode, and request test
   USDT from the testnet faucet/assets page.
2. Create an API key there: *System-generated*, **Read-Write**, permissions
   **Contract → Orders + Positions** only. **No withdrawal/transfer
   permissions.** Restrict it to your machine's IP.
3. On that machine (Node 18+, git):
   ```
   git clone https://github.com/alicetin1905-ux/TradeBot.git && cd TradeBot
   cp .env.example .env      # then fill in BYBIT_API_KEY / BYBIT_API_SECRET
   npm test                  # offline tests of the order logic
   TRADEBOT_MODE=testnet node src/run.js   # one run — check the output
   ```
   `.env` is git-ignored. Never commit it or paste the key anywhere else.
4. Run it hourly with cron, a few minutes after the candle close:
   ```
   6 * * * * /path/to/TradeBot/scripts/testnet-run.sh
   ```
   Output goes to `logs/testnet.log`.
5. Optional — dashboard: run with `PUSH_STATE=1` (e.g.
   `6 * * * * PUSH_STATE=1 /path/to/TradeBot/scripts/testnet-run.sh`) so it
   commits `state/testnet/` back to GitHub; that machine then needs push
   access to this repo (a fine-grained token or deploy key limited to
   TradeBot). The dashboard's **Bybit testnet** tab
   (`index.html?mode=testnet`) shows it.

`node src/run.js --reset` in testnet mode only resets the bot's own tracking
(allocation back to 1000 USDT); it doesn't touch anything on Bybit.

