# Stricter BTC filter (entry score 65)

```
Stricter BTC filter (entry score 65) · 21 coins · 2020-09-24 → 2026-10-03 · 4H, live rules otherwise

Per year: fresh 2000 USDT, $100 fixed risk — net $ (worst drop). Compound: 2000 USDT, 2.5% risk, whole period.

Live filter: no trade against BTC when BTC's 4H score is beyond +/-25 (neutral BTC allows both). Variants add a line BTC must be on.

variant                                             2020          2021          2022          2023          2024          2025          2026   20-23   24-26  yrs+  | compound end $ / PF / worst drop / trades
A  live: blocks only when BTC points against (|BTC| >= 25)     950 (25%)    5818 (66%)    9999 (41%)    1882 (88%)    6164 (54%)    3154 (82%)    7208 (70%)   18649   16526   7/7  | 70,922 / 1.34 / 36.8% / 2136
shorts only when BTC < 0 (longs as live)       723 (24%)    5538 (66%)    9980 (46%)     544 (97%)    5941 (60%)    4483 (79%)    6846 (72%)   16785   17270   7/7  | 69,433 / 1.35 / 36.8% / 2069
shorts only when BTC <= -25 (longs as live)     706 (25%)    4045 (64%)    8960 (36%)    1052 (91%)    4864 (55%)    3126 (84%)    4454 (70%)   14763   12445   7/7  | 60,114 / 1.32 / 36.5% / 1947
shorts BTC < 0, longs BTC > 0                  826 (24%)    4964 (67%)    9006 (42%)    1824 (87%)    5725 (58%)    4651 (73%)    5685 (72%)   16621   16062   7/7  | 63,785 / 1.33 / 34.3% / 2029
BTC must agree: shorts <= -25, longs >= +25     672 (24%)    3790 (80%)    8593 (33%)    2271 (87%)    4263 (53%)    3237 (71%)    3087 (64%)   15326   10587   7/7  | 53,692 / 1.32 / 36.4% / 1806
shorts BTC < +10, longs BTC > -10              679 (25%)    4805 (67%)    9404 (42%)    1290 (91%)    5369 (58%)    4168 (78%)    6072 (72%)   16178   15610   7/7  | 62,214 / 1.31 / 35.0% / 2083
-- reference --
BTC filter off                                 912 (29%)    5288 (62%)    9517 (39%)     566 (96%)    7375 (51%)    4875 (66%)    6803 (64%)   16283   19053   7/7  | 75,494 / 1.34 / 32.4% / 2265
```
