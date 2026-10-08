# Signal-flip exit only before T1 (live setup)

```
Signal-flip exit only before T1 (live setup) · 21 coins · 2020-09-29 → 2026-10-08 · 4H, live rules otherwise

Per year: fresh 2000 USDT, $100 fixed risk — net $ (worst drop). Compound: 2000 USDT, 2.5% risk, whole period.

Live setup (score 65, limit 0.3 ATR 4h, BE +0.2%, 21 coins). "Only before T1": once T1 is hit, an opposite signal no longer closes the trade; the breakeven stop and the T1 lock after T2 manage the rest.

variant                                             2020          2021          2022          2023          2024          2025          2026   20-23   24-26  yrs+  | compound end $ / PF / worst drop / trades
A  live: flip exit always                     1498 (18%)    4920 (65%)    7600 (44%)    2881 (79%)    5803 (78%)    6026 (44%)    4506 (41%)   16900   16335   7/7  | 71,463 / 1.44 / 29.9% / 1815
flip exit only before T1                      1454 (18%)    4062 (65%)    7433 (48%)    1757 (84%)   -1954 (98%)    6472 (40%)    3977 (38%)   14705    8495   6/7  | 65,951 / 1.42 / 30.3% / 1744
no flip exit (reference)                      1524 (23%)    1242 (71%)    7273 (51%)    3603 (56%)  -2001 (100%)    4695 (38%)    4389 (35%)   13641    7083   6/7  | 48,984 / 1.32 / 34.4% / 1504
-- first half of the coins --
live, first half                                610 (8%)    2290 (33%)    5378 (35%)    1646 (78%)    5014 (56%)    5093 (28%)    3159 (52%)    9925   13266   7/7  | 46,438 / 1.42 / 38.0% / 1187
before T1, first half                           610 (8%)    2483 (33%)    5217 (35%)    1615 (82%)    5036 (55%)    5339 (26%)    2793 (52%)    9925   13168   7/7  | 45,791 / 1.43 / 37.2% / 1151
-- second half of the coins --
live, second half                              888 (17%)    3690 (42%)    3418 (37%)    3257 (52%)    3760 (47%)    4825 (46%)    2986 (46%)   11254   11571   7/7  | 40,780 / 1.49 / 25.1% / 1051
before T1, second half                         844 (17%)    3008 (42%)    3195 (40%)    3229 (57%)    3555 (47%)    4662 (44%)    2828 (48%)   10276   11045   7/7  | 36,661 / 1.46 / 27.0% / 1026
```
