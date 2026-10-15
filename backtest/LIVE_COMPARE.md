# Live vs backtest, same period

Live setup (score 65, limit 0.3 ATR 4h, BE +0.2%, ADX < 40, 21 coins, 2.5% risk) simulated from 2026-09-30 to 2026-10-15T22:19 UTC.

| opened (UTC) | coin | side | P&L $ | exits |
|---|---|---|---:|---|
| 2026-09-30T13:00 | SAND | long | -50.78 | stop |
| 2026-10-02T01:00 | SAND | long | 133.55 | T1 > T2 > T3 |
| 2026-10-02T01:00 | 1000PEPE | long | 19.19 | T1 > breakeven stop |
| 2026-09-30T12:00 | GALA | long | 137.14 | T1 > T2 > T3 |
| 2026-10-01T07:00 | EGLD | long | -49.41 | stop |
| 2026-10-03T10:00 | KAITO | short | -55.34 | stop |
| 2026-10-03T10:00 | ATOM | short | -55.55 | stop |
| 2026-10-02T08:00 | AXS | long | 92.25 | T1 > T2 > T1-lock stop |
| 2026-10-05T08:00 | EGLD | long | -40.14 | signal flip |
| 2026-10-05T12:00 | ENA | long | -55.42 | stop |
| 2026-10-05T08:00 | SUI | long | -55.46 | stop |
| 2026-10-02T21:00 | WLD | long | 21.10 | T1 > breakeven stop |
| 2026-10-06T05:00 | KAITO | short | 93.54 | T1 > T2 > T1-lock stop |
| 2026-10-07T13:00 | DYDX | short | -48.28 | signal flip |
| 2026-10-07T15:00 | CHZ | short | 20.23 | T1 > breakeven stop |
| 2026-10-11T03:00 | NEAR | long | 91.66 | T1 > T2 > T1-lock stop |
| 2026-10-11T16:00 | GALA | long | -53.84 | stop |
| 2026-10-11T17:00 | XLM | long | -54.27 | stop |
| 2026-10-11T16:00 | 1000PEPE | long | -54.14 | stop |
| 2026-10-13T05:00 | DOGE | short | 88.16 | T1 > T2 > T1-lock stop |

Backtest, this period: 20 closed trades, 9 won / 11 lost, net $163.11, PF 1.22.

Over 2020-2026 (1779 trades), 15.1% of all runs of 18 trades in a row lost 3.8R or more, and 10.8% had a PF of 0.52 or lower.
