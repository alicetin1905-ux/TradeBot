# TradeBot

Auto trading bot — a pooled-balance bot trading BTC, ETH, SOL, XRP, BNB and
DOGE perps on **Bybit Demo Trading** (mainnet prices, demo funds). It uses the same signal stack as
[UltimateTradingBot](https://github.com/alicetin1905-ux/UltimateTradingBot):

- **ATLAS** — primary signal: ~25-indicator weighted score, Chandelier Exit
  stop, flip-triggered entry (`src/indicators.js`, `src/atlasScore.js`).
- **GoldenRatio** — confluence filter: a contradicting Fibonacci impulse
  holds the trade back (`src/fib.js`).
- **CRUCIBLE** — liquidation-cluster model that nudges stops off dense
  clusters and pulls T2 in short of them (`src/liquidity.js`).

## Demo funds only

The bot reads signals from OKX's public market data and places real orders
on a **Bybit Demo Trading** account (`api-demo.bybit.com`) — demo funds, not
real money. There is no real-money mode in this build: the Bybit client only
knows the Demo Trading environment and refuses anything else. Treat every
number as a rehearsal of the strategy, not investment advice.

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
node src/run.js              # one run: sync with Bybit, score, open/close trades
node src/run.js --sync       # sync positions/fills only — no new entries
node src/run.js --close-all  # cancel all orders + close every position on Bybit
bash scripts/reset.sh demo   # close everything and start over from 1000 USDT
npm test                     # offline tests of the order logic
```

Requires Node 18+ (native `fetch`), no dependencies. Keys come from `.env`
(see `.env.example`).

## Automation

The bot runs from a Mac via cron, set up once with `bash scripts/setup-mac.sh`
(see *Setup* below):

- `:06` every hour — full run (`scripts/exchange-run.sh demo`)
- every 5 minutes — sync (`scripts/exchange-run.sh demo sync`)

Each run commits `state/demo/*.json` back to this repo — that is how the bot
remembers its balance and positions, and what the dashboard reads.
(GitHub Actions can't run it: Bybit geo-blocks GitHub's runners.)

`index.html` is the dashboard (GitHub Pages, branch `main`, root); it reads
`state/demo/*.json`.

## How it trades on Bybit

- **Entry:** market order with the **stop attached to the position** in the
  same request, then three reduce-only limit orders for T1/T2/T3
  (40/35/25%). Stops and targets live on Bybit, so they keep working if the
  machine running the bot is off.
- **Levels:** the strategy reads OKX mainnet candles; its stop/targets are
  carried over as % distances from Bybit's actual fill price (Bybit and OKX
  prices differ slightly). Instrument rules and mark prices come from
  Bybit's public mainnet API (`api.bybit.com`, no key sent); orders go to
  `api-demo`.
- **Sizing:** 25% of the bot's **allocation** as margin at 10x. The allocation
  starts at 1000 USDT and moves with realized P&L (from Bybit's closed-P&L
  records, net of fees), so a demo wallet with more USDT still trades like
  a 1000 USDT account. Never more margin than Bybit says is free.
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

Bybit geo-blocks GitHub Actions (and many cloud regions), so demo mode has
to run on your own computer or a small VPS in a region Bybit serves (it
needs both `api-demo.bybit.com` and `api.bybit.com`).

### Setup

1. **Get a key:** log in at <https://www.bybit.com>, switch to **Demo
   Trading** (top-right account menu), top up demo USDT there, then *API
   Management → Create New Key* while still in Demo Trading (a key made there
   only works on `api-demo.bybit.com`). **Unified Trading Account**,
   **one-way** position mode, *System-generated* key, **Read-Write**,
   permissions **Contract → Orders + Positions** only, **no
   withdrawal/transfer**, restricted to your machine's IP.
2. On that machine (Node 18+, git):
   ```
   git clone https://github.com/alicetin1905-ux/TradeBot.git && cd TradeBot
   cp .env.example .env      # set TRADEBOT_MODE=demo + the key
   npm test                  # offline tests of the order logic
   node src/run.js           # one demo run — check the output
   ```
   `.env` is git-ignored. Never commit it or paste the key anywhere else.
3. `bash scripts/setup-mac.sh` — asks once for a GitHub fine-grained token
   (TradeBot only, *Contents: Read and write*) so runs can upload their
   state, uploads the current state, and installs the two cron lines
   above. Safe to run again; it keeps any other cron jobs. Logs go to
   `logs/demo.log`.

To start over: `scripts/reset.sh demo` closes every
position and order on Bybit, resets the bot to 1000 USDT and uploads the
result; add `--clear-history` to also wipe the trade list. It holds the same
lock as the scheduled runs and stops without resetting if anything fails to
close.

`node src/run.js --reset` on its own only resets the bot's own
tracking (allocation back to 1000 USDT); it doesn't touch anything on Bybit.
