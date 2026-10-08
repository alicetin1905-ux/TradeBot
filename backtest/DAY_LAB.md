# Daily trend filter (live setup)

```
Daily trend filter (live setup) · 21 coins · 2020-09-29 → 2026-10-08 · 4H, live rules otherwise

Per year: fresh 2000 USDT, $100 fixed risk — net $ (worst drop). Compound: 2000 USDT, 2.5% risk, whole period.

Live setup (score 65, limit 0.3 ATR 4h, BE +0.2%, 21 coins). Filters use the last closed daily candle (UTC day): "agree" = the 1D ATLAS score is past +/-25 in the trade direction; "not against" = it is not past +/-25 the other way; EMA = the daily close is above (long) / below (short) its EMA.

variant                                             2020          2021          2022          2023          2024          2025          2026   20-23   24-26  yrs+  | compound end $ / PF / worst drop / trades
A  live: no daily filter                      1498 (18%)    4920 (65%)    7600 (44%)    2881 (79%)    5803 (78%)    6026 (44%)    4506 (41%)   16900   16335   7/7  | 71,463 / 1.44 / 29.9% / 1815
1D ATLAS signal must agree                        0 (0%)    2198 (24%)    3636 (55%)    4221 (49%)    6479 (37%)    2131 (74%)    1071 (54%)   10055    9681   6/7  | 37,437 / 1.40 / 35.6% / 1104
1D ATLAS signal not against (soft)            1498 (18%)    4778 (65%)    7451 (47%)    2744 (72%)    3380 (82%)    6624 (43%)    3309 (42%)   16472   13313   7/7  | 68,192 / 1.43 / 29.9% / 1755
daily close vs EMA20                          1290 (22%)    4753 (45%)    6057 (52%)    1977 (93%)    5249 (81%)    6387 (35%)    2724 (54%)   14077   14360   7/7  | 60,163 / 1.39 / 33.0% / 1684
daily close vs EMA50                           546 (24%)    5355 (35%)    3654 (56%)    4410 (65%)    6440 (60%)    5112 (43%)     904 (59%)   13965   12456   7/7  | 53,414 / 1.39 / 32.6% / 1497
daily close vs EMA200                          876 (14%)    2249 (45%)    3819 (61%)    3728 (55%)    4855 (57%)    4196 (53%)    2140 (44%)   10672   11190   7/7  | 39,442 / 1.39 / 38.0% / 1244
-- first half of the coins --
live, first half                                610 (8%)    2290 (33%)    5378 (35%)    1646 (78%)    5014 (56%)    5093 (28%)    3159 (52%)    9925   13266   7/7  | 46,438 / 1.42 / 38.0% / 1187
1D not against, first half                      610 (8%)    2424 (33%)    4872 (35%)    1061 (78%)    4865 (49%)    6194 (25%)    2821 (52%)    8967   13879   7/7  | 46,632 / 1.45 / 39.1% / 1136
EMA50, first half                             -185 (10%)    2869 (27%)    2571 (36%)    1780 (93%)    5162 (46%)    3812 (32%)    2581 (39%)    7036   11555   6/7  | 35,091 / 1.44 / 46.5% / 973
-- second half of the coins --
live, second half                              888 (17%)    3690 (42%)    3418 (37%)    3257 (52%)    3760 (47%)    4825 (46%)    2986 (46%)   11254   11571   7/7  | 40,780 / 1.49 / 25.1% / 1051
1D not against, second half                    888 (17%)    3067 (42%)    3361 (34%)    3825 (40%)    3024 (39%)    4494 (50%)    2051 (47%)   11142    9569   7/7  | 37,103 / 1.47 / 22.9% / 1006
EMA50, second half                             731 (17%)    2960 (23%)    1620 (44%)    3532 (42%)    4348 (54%)    4645 (49%)    1281 (54%)    8844   10274   7/7  | 34,685 / 1.54 / 29.0% / 843
```
