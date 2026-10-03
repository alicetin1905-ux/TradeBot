# PF lab: pullback entry, volatility filter, time filter (entry score 65)

```
PF lab: pullback entry, volatility filter, time filter (entry score 65) · 21 coins · 2020-09-24 → 2026-10-03 · 4H, live rules otherwise

Per year: fresh 2000 USDT, $100 fixed risk — net $ (worst drop). Compound: 2000 USDT, 2.5% risk, whole period.

Limit entries fill at the limit price with maker fee; unfilled ones expire. Volatility = the coin's 4H ATR% against its own average of the previous 50 signal candles. Time filters use the signal candle's close in UTC (your time = UTC+2).

variant                                             2020          2021          2022          2023          2024          2025          2026   20-23   24-26  yrs+  | compound end $ / PF / worst drop / trades
A  live: market entry, no filters              950 (25%)    5818 (66%)    9999 (41%)    1882 (88%)    6164 (54%)    3154 (82%)    7244 (70%)   18649   16562   7/7  | 71,027 / 1.34 / 36.8% / 2136
-- 1. pullback limit entry --
limit 0.25 ATR better, valid 4h               1487 (15%)    4555 (62%)    7862 (40%)    2017 (93%)    5902 (69%)    5355 (49%)    5414 (49%)   15921   16671   7/7  | 68,773 / 1.39 / 36.0% / 1831
limit 0.5 ATR better, valid 4h                1045 (12%)    2159 (44%)    4828 (52%)    2184 (82%)    2516 (64%)    6218 (30%)    3800 (50%)   10217   12533   7/7  | 41,723 / 1.38 / 35.1% / 1281
limit 0.5 ATR better, valid 12h               1209 (15%)    3195 (37%)    8788 (39%)     -44 (96%)   -1943 (97%)    3872 (43%)    5537 (41%)   13148    7467   5/7  | 52,856 / 1.34 / 30.9% / 1683
limit 1 ATR better, valid 12h                  203 (11%)    1673 (35%)    4222 (26%)    4083 (32%)    3125 (53%)    3804 (29%)     701 (85%)   10180    7630   7/7  | 30,396 / 1.38 / 22.4% / 1029
-- 2. volatility (ATR% vs coin's 50-candle average) --
skip when ATR > 1.5x normal                    676 (25%)    5720 (65%)    9516 (42%)    2164 (88%)    7309 (52%)    3642 (78%)    6944 (73%)   18076   17895   7/7  | 70,810 / 1.35 / 36.4% / 2121
skip when ATR > 2x normal                      950 (25%)    6080 (65%)   10153 (41%)    1167 (90%)    6164 (54%)    3236 (82%)    7244 (70%)   18350   16645   7/7  | 70,880 / 1.34 / 36.7% / 2133
skip when ATR < 0.7x normal                    884 (25%)    6209 (56%)    9157 (38%)    1256 (89%)    6528 (50%)    3260 (82%)    7097 (70%)   17505   16884   7/7  | 70,077 / 1.34 / 31.2% / 2094
only 0.7x - 1.5x normal                        609 (25%)    6111 (56%)    8500 (39%)    2262 (88%)    7424 (52%)    3749 (78%)    6796 (73%)   17483   17969   7/7  | 68,674 / 1.34 / 32.1% / 2079
-- 3. time --
no weekend entries (Sat/Sun UTC)               974 (25%)    7332 (42%)   10326 (35%)    1248 (96%)    4804 (78%)   -1945 (99%)    5347 (71%)   19880    8206   6/7  | 66,766 / 1.34 / 27.0% / 1929
skip 00 + 04 UTC closes (night)               1019 (29%)    4195 (63%)   10042 (30%)    2749 (57%)    6493 (69%)    4554 (60%)    5695 (61%)   18004   16742   7/7  | 66,213 / 1.35 / 29.9% / 1979
skip 20 + 00 UTC closes (US evening)           933 (20%)    3792 (56%)    8594 (34%)    2273 (72%)   -1970 (98%)    5216 (41%)    6115 (72%)   15593    9361   6/7  | 54,883 / 1.29 / 33.7% / 1964
```
