# Backtest 2025-09-29 → 2026-09-24

360 days · 8 coins · start 1000 USDT · $200 margin ×10 · max 5 positions, 3 per direction · entry score ≥ 50 · generated 2026-09-24 18:24 UTC

Approximation: price/volume signals only (no funding, OI, long/short, book, tape); exits replayed on 1H candles, stop first when a candle touches stop and target; Bybit fees (0.055% taker, 0.02% maker). Limit entries: 0.25×ATR better than the signal close, valid 3 hours, skipped if not filled.

| Variant | Trades | Win % | Net $ | Return % | Max DD % | Profit factor | Avg win | Avg loss | Limits missed |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1H · market · 1/2/3R (old live) | 209 | 44 | -809 | -80.9 | 88.9 | 0.83 | 41.7 | -39.7 |  |
| 1H · market · 1/2/3R · no fees | 234 | 43 | -818 | -81.8 | 90.3 | 0.84 | 42.0 | -38.1 |  |
| 1H · limit entry · 1/2/3R | 179 | 40 | -813 | -81.3 | 85.2 | 0.79 | 43.6 | -36.2 | 51 |
| 1H · market · 1.5/3/4.5R | 121 | 32 | -832 | -83.2 | 91.0 | 0.75 | 64.4 | -40.8 |  |
| 1H · limit · 1.5/3/4.5R | 129 | 31 | -810 | -81.0 | 87.7 | 0.75 | 62.1 | -37.0 | 31 |
| 4H · market · 1/2/3R | 70 | 43 | -911 | -91.1 | 93.3 | 0.74 | 85.5 | -86.9 |  |
| 4H · limit entry · 1/2/3R | 35 | 40 | -815 | -81.5 | 87.3 | 0.60 | 86.1 | -96.2 | 15 |
| 4H · market · 1.5/3/4.5R | 66 | 33 | -815 | -81.5 | 87.8 | 0.78 | 130.3 | -83.7 |  |
| 4H · limit · 1.5/3/4.5R | 47 | 32 | -880 | -88.0 | 91.8 | 0.70 | 137.2 | -91.8 | 28 |
| 4H · limit · 2/4/6R | 87 | 31 | -842 | -84.2 | 90.8 | 0.82 | 141.0 | -77.5 | 60 |
| 4H · limit · 1.5/3/4.5R · BE after T2 | 46 | 35 | -811 | -81.1 | 87.2 | 0.71 | 122.7 | -92.5 | 30 |
| 4H · market · 1.5/3/4.5R · $30 risk | 346 | 42 | 1734 | 173.4 | 31.0 | 1.35 | 45.4 | -24.8 |  |
| 4H · market · 1.5/3/4.5R · $50 risk (live now) | 346 | 42 | 2560 | 256.0 | 45.6 | 1.33 | 69.8 | -38.7 |  |
| 1H · 1.5/3/4.5R · $50 risk | 151 | 33 | -969 | -96.9 | 97.9 | 0.73 | 51.2 | -34.9 |  |
|   + volume ≥ 1.2x avg | 171 | 33 | -999 | -99.9 | 99.9 | 0.75 | 51.7 | -34.6 |  |
|   + volume ≥ 1.5x avg | 238 | 35 | -993 | -99.3 | 99.7 | 0.81 | 51.8 | -34.1 |  |
|   + 1H Supertrend agrees | 158 | 34 | -985 | -98.5 | 98.8 | 0.73 | 50.2 | -34.7 |  |
|   + 4H Supertrend agrees | 188 | 32 | -999 | -99.9 | 99.9 | 0.77 | 55.5 | -34.5 |  |
|   + 4H Supertrend + volume ≥ 1.2x | 200 | 34 | -979 | -97.9 | 98.9 | 0.79 | 53.6 | -34.3 |  |
|   + 1H & 4H Supertrend + volume ≥ 1.2x | 170 | 34 | -980 | -98.0 | 99.0 | 0.76 | 52.2 | -35.8 |  |
| 4H live + volume ≥ 1.2x | 282 | 39 | 674 | 67.4 | 48.6 | 1.10 | 67.1 | -38.4 |  |
| 4H live + volume ≥ 1.5x | 182 | 31 | -908 | -90.8 | 95.1 | 0.82 | 73.5 | -39.9 |  |
| 4H live + Supertrend agrees | 331 | 38 | 602 | 60.2 | 76.3 | 1.07 | 69.8 | -39.5 |  |
|   + Liq: T2 at cluster | 346 | 42 | 2523 | 252.3 | 47.1 | 1.33 | 69.6 | -38.7 |  |
|   + Liq: T3 at cluster | 346 | 42 | 2563 | 256.3 | 45.6 | 1.33 | 69.8 | -38.7 |  |
|   + Liq: T2 + T3 at clusters | 346 | 42 | 2526 | 252.6 | 47.1 | 1.33 | 69.6 | -38.7 |  |
|   + Liq: skip if magnet against | 272 | 43 | 691 | 69.1 | 40.6 | 1.10 | 60.7 | -40.9 |  |
| 4H · market · 2/3/4R · $50 risk | 338 | 36 | 2458 | 245.8 | 56.9 | 1.30 | 85.6 | -37.5 |  |
| 4H · market · 2/3/4.5R · $50 risk | 336 | 36 | 2449 | 244.9 | 57.2 | 1.30 | 86.0 | -37.6 |  |
| 4H · market · 1.5/3/4.5R · $20 risk | 346 | 42 | 1166 | 116.6 | 22.5 | 1.35 | 30.4 | -16.6 |  |
| 4H · market · 1.5/3/4.5R · $40 risk | 346 | 42 | 2181 | 218.1 | 40.0 | 1.34 | 58.7 | -32.4 |  |
| 4H · market · 1/2/3R · $30 risk | 414 | 50 | 790 | 79.0 | 50.0 | 1.14 | 30.5 | -26.7 |  |
| 4H · market · 2/4/6R · $30 risk | 319 | 36 | 1908 | 190.8 | 41.5 | 1.39 | 58.7 | -24.1 |  |
| 4H · limit · 1.5/3/4.5R · $30 risk | 299 | 43 | 1152 | 115.2 | 36.5 | 1.27 | 42.7 | -25.2 | 197 |
| 4H · limit · 1.5/3/4.5R · no fees | 74 | 34 | -849 | -84.9 | 89.8 | 0.78 | 123.7 | -80.4 | 51 |

## Candidate: 4H · market · 1.5/3/4.5R · $50 risk (live now) — per coin

| Coin | Trades | Win % | Net $ |
|---|---:|---:|---:|
| HYPE | 49 | 45 | 615 |
| SUI | 40 | 45 | 604 |
| DOGE | 48 | 46 | 488 |
| BNB | 47 | 40 | 427 |
| XRP | 39 | 44 | 415 |
| SOL | 40 | 38 | 89 |
| ETH | 40 | 40 | -1 |
| BTC | 43 | 42 | -77 |

## Candidate: 4H · market · 1.5/3/4.5R · $50 risk (live now) — by final exit

| Exit | Trades | Net $ |
|---|---:|---:|
| stop | 114 | -5446 |
| signal flip | 139 | 1000 |
| T3 | 46 | 5693 |
| breakeven stop | 47 | 1313 |
