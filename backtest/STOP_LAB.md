# Stop width, neutral-score exit, losing-streak pause (live setup)

```
Stop width, neutral-score exit, losing-streak pause (live setup) · 21 coins · 2020-09-24 → 2026-10-03 · 4H, live rules otherwise

Per year: fresh 2000 USDT, $100 fixed risk — net $ (worst drop). Compound: 2000 USDT, 2.5% risk, whole period.

Same dollar risk per trade in every row: a wider stop means a smaller position. Targets stay at 1.5/2.5/3.5 x the (new) stop distance.

variant                                             2020          2021          2022          2023          2024          2025          2026   20-23   24-26  yrs+  | compound end $ / PF / worst drop / trades
A  live now (stop 1.5 ATR)                    1260 (15%)    4415 (60%)    7685 (44%)    2637 (80%)    5269 (80%)    5754 (46%)    3541 (56%)   15997   14565   7/7  | 64,976 / 1.40 / 28.6% / 1742
-- 1. stop width (x ATR, or the Chandelier stop if wider) --
stop 1.5 ATR (same rule, re-sized: check)     1254 (15%)    4415 (60%)    7659 (44%)    2618 (80%)    5269 (80%)    5748 (46%)    3646 (56%)   15946   14663   7/7  | 65,113 / 1.40 / 28.6% / 1742
stop 1.25 ATR                                  838 (16%)    3116 (63%)    7097 (44%)    1979 (95%)    3872 (80%)    5863 (41%)    4034 (60%)   13030   13769   7/7  | 55,343 / 1.35 / 30.6% / 1817
stop 2 ATR                                    1442 (13%)    3624 (54%)    6344 (44%)      99 (97%)    5026 (56%)    2729 (56%)    3661 (48%)   11509   11415   7/7  | 58,774 / 1.37 / 27.1% / 1592
stop 2.5 ATR                                  1073 (12%)    3251 (48%)    5364 (36%)    4134 (52%)    4415 (56%)    2436 (58%)    2256 (61%)   13822    9106   7/7  | 56,029 / 1.36 / 28.6% / 1508
-- 2. close when the score falls back inside +/-25 --
neutral score closes the trade                 967 (13%)    4064 (36%)    6336 (43%)   -1956 (99%)    7665 (59%)    7048 (36%)    3286 (58%)    9411   17999   6/7  | 57,732 / 1.40 / 41.9% / 2166
neutral score closes it only before T1        1062 (13%)    3791 (36%)    6253 (42%)   -1979 (99%)    7144 (61%)    6668 (38%)    3667 (54%)    9127   17479   6/7  | 55,716 / 1.40 / 42.4% / 2121
-- 3. pause after losing streaks --
3 losses in a row -> 24h pause                1086 (15%)    4106 (53%)    5991 (52%)    1802 (85%)    6721 (60%)    4146 (52%)    4304 (39%)   12985   15171   7/7  | 54,479 / 1.36 / 31.6% / 1629
4 losses in a row -> 24h pause                1260 (15%)    4672 (53%)    7319 (47%)    3148 (71%)    5004 (73%)    4658 (40%)    4092 (49%)   16398   13755   7/7  | 60,041 / 1.38 / 28.8% / 1672
5 losses in a row -> 48h pause                1260 (15%)    4866 (44%)    7709 (44%)    2264 (83%)    5544 (53%)    6268 (38%)    3531 (45%)   16098   15344   7/7  | 65,547 / 1.43 / 27.4% / 1646
-- each half of the coin list (live / stop 2 ATR) --
live, first half                                610 (8%)    2290 (33%)    5378 (35%)    1646 (78%)    5014 (56%)    5093 (28%)    3398 (52%)    9925   13505   7/7  | 46,949 / 1.43 / 38.0% / 1184
stop 2 ATR, first half                         654 (10%)    2357 (27%)    5164 (36%)    2790 (64%)    6063 (40%)    2957 (44%)    3092 (57%)   10964   12113   7/7  | 49,185 / 1.45 / 36.1% / 1115
live, second half                              650 (15%)    2733 (38%)    3343 (36%)    2624 (69%)    3157 (38%)    3511 (54%)    1721 (49%)    9350    8389   7/7  | 32,268 / 1.42 / 28.7% / 921
stop 2 ATR, second half                        788 (12%)    1990 (37%)    3412 (31%)    2023 (72%)    1944 (56%)    2693 (62%)     565 (68%)    8214    5202   7/7  | 24,691 / 1.32 / 36.0% / 889
```
