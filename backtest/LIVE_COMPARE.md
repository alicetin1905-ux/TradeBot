# Live vs backtest, same period

Live setup (score 65, limit 0.3 ATR 4h, BE +0.2%, ADX < 40, 21 coins, 2.5% risk) simulated from 2026-10-08 to 2026-11-26T21:47 UTC.

| opened (UTC) | coin | side | P&L $ | exits |
|---|---|---|---:|---|
| 2026-10-08T23:00 | DYDX | short | -51.20 | stop |
| 2026-10-08T14:00 | CHZ | short | 19.97 | T1 > breakeven stop |
| 2026-10-11T03:00 | NEAR | long | 85.66 | T1 > T2 > T1-lock stop |
| 2026-10-11T16:00 | GALA | long | -50.32 | stop |
| 2026-10-11T17:00 | XLM | long | -50.71 | stop |
| 2026-10-11T16:00 | 1000PEPE | long | -50.60 | stop |
| 2026-10-13T05:00 | DOGE | short | 82.39 | T1 > T2 > T1-lock stop |
| 2026-10-15T12:00 | 1000PEPE | short | -22.13 | signal flip |
| 2026-10-13T02:00 | ENA | short | 38.32 | T1 > signal flip |
| 2026-10-13T16:00 | DYDX | short | 84.56 | T1 > T2 > signal flip |
| 2026-10-20T04:00 | 1000PEPE | long | 140.19 | T1 > T2 > T3 |
| 2026-10-21T10:00 | NEAR | long | -54.53 | stop |
| 2026-10-12T12:00 | GRAM | short | 140.72 | T1 > T2 > T3 |
| 2026-10-23T05:00 | CHZ | short | 94.87 | T1 > T2 > T1-lock stop |
| 2026-10-24T16:00 | 1000BONK | short | -60.52 | stop |
| 2026-10-27T17:00 | ENA | long | -59.68 | stop |
| 2026-10-28T18:00 | CHZ | short | -59.35 | stop |
| 2026-10-29T20:00 | ENA | long | -56.55 | stop |
| 2026-10-23T01:00 | SUI | short | 150.00 | T1 > T2 > T3 |
| 2026-10-29T05:00 | ATOM | short | 97.53 | T1 > T2 > T1-lock stop |
| 2026-10-30T03:00 | SUI | short | -23.95 | signal flip |
| 2026-10-29T09:00 | AXS | short | 64.01 | T1 > signal flip |
| 2026-11-04T12:00 | 1000PEPE | long | -61.57 | stop |
| 2026-10-29T04:00 | CHZ | short | 154.07 | T1 > T2 > T3 |
| 2026-11-09T00:00 | SAND | short | -65.05 | stop |
| 2026-11-12T16:00 | XLM | short | -64.16 | stop |
| 2026-11-05T16:00 | DOGE | short | 168.30 | T1 > T2 > T3 |
| 2026-11-13T05:00 | KAITO | short | 107.32 | T1 > T2 > T1-lock stop |
| 2026-11-17T14:00 | GRAM | short | -69.61 | stop |
| 2026-11-18T17:00 | SUI | short | 185.84 | T1 > T2 > T3 |
| 2026-11-18T21:00 | ATOM | short | 185.69 | T1 > T2 > T3 |
| 2026-10-30T05:00 | GALA | short | 121.38 | T1 > T2 > signal flip |
| 2026-11-05T16:00 | WLD | short | 133.89 | T1 > T2 > signal flip |
| 2026-11-24T18:00 | XLM | short | -82.90 | stop |
| 2026-11-25T08:00 | SOL | short | -82.89 | stop |
| 2026-11-25T08:00 | NEAR | short | -82.25 | stop |
| 2026-11-25T08:00 | SAND | short | -82.83 | stop |

Backtest, this period: 37 closed trades, 18 won / 19 lost, net $923.59, PF 1.82.

Over 2020-2026 (109 trades), 67.5% of all runs of 27 trades in a row lost -9R or more, and 1.2% had a PF of 0.52 or lower.
