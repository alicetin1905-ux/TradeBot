# Backtest 2026-05-27 → 2026-09-24

120 days · 8 coins · start 1000 USDT · generated 2026-09-24 08:25 UTC

Approximation: price/volume signals only (no funding, OI, long/short, book, tape), fills at candle close, stop checked first when a candle touches stop and target, Bybit fees included.

| Variant | Trades | Win % | Net $ | Return % | Max DD % | Profit factor | Avg win | Avg loss |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Live rules now | 329 | 45 | -812 | -81.2 | 90.1 | 0.85 | 31.0 | -30.2 |
| Live rules, if trading were free | 566 | 48 | 333 | 33.3 | 62.2 | 1.04 | 30.7 | -26.9 |
| Breakeven after T2 (not T1) | 291 | 37 | -807 | -80.7 | 89.3 | 0.84 | 39.0 | -27.1 |
| BE after T1, stop to T1 after T2 | 340 | 46 | -812 | -81.2 | 90.9 | 0.86 | 31.3 | -30.6 |
| No Fibonacci check | 346 | 45 | -806 | -80.6 | 90.8 | 0.86 | 31.2 | -29.6 |
| Entry score 25 (old) | 343 | 46 | -806 | -80.6 | 88.6 | 0.86 | 32.5 | -31.8 |
| Entry score 65 | 277 | 49 | -815 | -81.5 | 89.4 | 0.82 | 27.3 | -31.7 |
| Size by risk: $25 per full stop | 433 | 47 | -758 | -75.8 | 92.2 | 0.84 | 20.1 | -20.9 |
| BTC direction filter for alts | 273 | 46 | -809 | -80.9 | 89.6 | 0.83 | 31.0 | -31.6 |
| $100 margin, 8 slots, no direction cap | 685 | 47 | -764 | -76.4 | 93.5 | 0.86 | 14.2 | -14.9 |

## Live rules — per coin

| Coin | Trades | Win % | Net $ |
|---|---:|---:|---:|
| XRP | 37 | 54 | 194 |
| SUI | 42 | 50 | -50 |
| HYPE | 46 | 46 | -54 |
| BTC | 41 | 44 | -130 |
| SOL | 37 | 41 | -148 |
| BNB | 38 | 39 | -180 |
| DOGE | 44 | 48 | -185 |
| ETH | 44 | 41 | -259 |

## Live rules — by final exit

| Exit | Trades | Net $ |
|---|---:|---:|
| stop | 135 | -4341 |
| signal flip | 71 | -86 |
| T3 | 41 | 2470 |
| breakeven stop | 82 | 1145 |
