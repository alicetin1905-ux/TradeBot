# Backtest 2025-09-29 → 2026-09-24

360 days · 8 coins · start 1000 USDT · $200 margin ×10 · max 5 positions, 3 per direction · entry score ≥ 50 · generated 2026-09-24 08:55 UTC

Approximation: price/volume signals only (no funding, OI, long/short, book, tape); exits replayed on 1H candles, stop first when a candle touches stop and target; Bybit fees (0.055% taker, 0.02% maker). Limit entries: 0.25×ATR better than the signal close, valid 3 hours, skipped if not filled.

| Variant | Trades | Win % | Net $ | Return % | Max DD % | Profit factor | Avg win | Avg loss | Limits missed |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1H · market · 1/2/3R (live now) | 190 | 44 | -864 | -86.4 | 91.3 | 0.80 | 41.9 | -40.6 |  |
| 1H · market · 1/2/3R · no fees | 223 | 41 | -807 | -80.7 | 89.2 | 0.83 | 43.3 | -36.6 |  |
| 1H · limit entry · 1/2/3R | 184 | 40 | -824 | -82.4 | 86.7 | 0.79 | 42.4 | -36.0 | 49 |
| 1H · market · 1.5/3/4.5R | 117 | 32 | -815 | -81.5 | 88.4 | 0.75 | 65.0 | -41.6 |  |
| 1H · limit · 1.5/3/4.5R | 132 | 31 | -811 | -81.1 | 88.2 | 0.76 | 61.5 | -36.6 | 29 |
| 4H · market · 1/2/3R | 65 | 43 | -881 | -88.1 | 91.0 | 0.73 | 85.8 | -88.8 |  |
| 4H · limit entry · 1/2/3R | 35 | 40 | -838 | -83.8 | 88.8 | 0.59 | 85.6 | -96.9 | 16 |
| 4H · market · 1.5/3/4.5R | 334 | 43 | 3172 | 317.2 | 73.2 | 1.26 | 100.5 | -59.5 |  |
| 4H · limit · 1.5/3/4.5R | 73 | 34 | -870 | -87.0 | 91.4 | 0.78 | 124.9 | -83.2 | 52 |
| 4H · limit · 2/4/6R | 148 | 34 | -807 | -80.7 | 89.3 | 0.88 | 118.4 | -68.7 | 104 |
| 4H · limit · 1.5/3/4.5R · BE after T2 | 73 | 34 | -874 | -87.4 | 91.6 | 0.78 | 126.7 | -84.2 | 50 |
| 4H · market · 1.5/3/4.5R · $30 risk | 345 | 42 | 1766 | 176.6 | 30.0 | 1.35 | 45.6 | -24.8 |  |
| 4H · market · 1.5/3/4.5R · $20 risk | 345 | 42 | 1187 | 118.7 | 21.9 | 1.35 | 30.5 | -16.6 |  |
| 4H · market · 1.5/3/4.5R · $40 risk | 345 | 42 | 2225 | 222.5 | 38.4 | 1.34 | 58.9 | -32.4 |  |
| 4H · market · 1/2/3R · $30 risk | 414 | 50 | 805 | 80.5 | 49.4 | 1.14 | 30.6 | -26.7 |  |
| 4H · market · 2/4/6R · $30 risk | 317 | 36 | 1947 | 194.7 | 39.4 | 1.40 | 59.1 | -24.1 |  |
| 4H · limit · 1.5/3/4.5R · $30 risk | 298 | 43 | 1182 | 118.2 | 35.2 | 1.26 | 42.8 | -25.2 | 197 |
| 4H · limit · 1.5/3/4.5R · no fees | 75 | 33 | -853 | -85.3 | 90.4 | 0.79 | 125.9 | -80.0 | 55 |

## Candidate: 4H · market · 1.5/3/4.5R · $30 risk — per coin

| Coin | Trades | Win % | Net $ |
|---|---:|---:|---:|
| SUI | 40 | 45 | 369 |
| HYPE | 48 | 44 | 322 |
| XRP | 39 | 44 | 296 |
| BNB | 47 | 40 | 291 |
| DOGE | 48 | 46 | 289 |
| ETH | 39 | 41 | 144 |
| SOL | 41 | 37 | 38 |
| BTC | 43 | 42 | -32 |

## Candidate: 4H · market · 1.5/3/4.5R · $30 risk — by final exit

| Exit | Trades | Net $ |
|---|---:|---:|
| stop | 114 | -3540 |
| T3 | 47 | 3862 |
| signal flip | 137 | 539 |
| breakeven stop | 47 | 856 |
