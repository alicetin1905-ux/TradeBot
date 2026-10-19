# Funding-rate filter (live setup)

```
Funding-rate filter (live setup) · 21 coins · 2020-10-10 → 2026-10-19 · 4H, live rules otherwise

Per year: fresh 2000 USDT, $100 fixed risk — net $ (worst drop). Compound: 2000 USDT, 2.5% risk, whole period.

Funding from Hyperliquid (a stand-in for Bybit; 8h-equivalent rate, average of the last 24h before the signal close), mid 2023 onward, 18 of 21 coins (no EGLD, ZIL, CHZ: never blocked). "With the trade" > 0 = the trade is on the crowded side (a long while longs pay, a short while shorts pay). Years before 2023 are identical by construction.

Live trades with funding data, by funding at entry ($100 fixed risk):
funding with the trade (% per 8h)
bucket            all: n  win    PF    net$ | to 2024: n win PF net$ | 2025-26: n win PF net$
-1 to -0.01          80   49%   1.74     2454 |   52   48%   1.21      464 |   28   50%   2.79     1990
-0.01 to 0          251   45%   1.35     4070 |   52   52%   1.88     1819 |  199   44%   1.23     2251
0 to 0.01           149   43%   1.42     3035 |   38   45%   1.46      875 |  111   42%   1.40     2159
0.01 to 0.02        159   47%   1.47     3549 |   53   53%   2.30     2459 |  106   43%   1.19     1090
0.02 to 0.05         66   42%   1.15      488 |   41   46%   1.49      944 |   25   36%   0.66     -455
>= 0.05              52   44%   1.17      434 |   47   40%   0.92     -206 |    5   80%  32.66      641

funding z-score vs the coin's last 90 days, with the trade
bucket            all: n  win    PF    net$ | to 2024: n win PF net$ | 2025-26: n win PF net$
-10 to -1            22   50%   1.74      671 |   10   40%   0.50     -236 |   12   58%   3.05      907
-1 to 0             261   46%   1.40     4810 |   87   46%   1.50     1977 |  174   46%   1.35     2833
0 to 1              385   43%   1.33     6176 |  133   50%   1.60     3274 |  252   40%   1.22     2903
1 to 2               62   45%   1.25      758 |   36   42%   1.17      341 |   26   50%   1.41      417
>= 2                 27   63%   2.69     1615 |   17   59%   2.53      999 |   10   70%   3.02      616

variant                                             2020          2021          2022          2023          2024          2025          2026   20-23   24-26  yrs+  | compound end $ / PF / worst drop / trades
A  live: no funding filter                    1344 (19%)    5674 (63%)    7831 (42%)    4263 (68%)    5939 (78%)    6140 (44%)    5255 (41%)   19112   17334   7/7  | 77,647 / 1.49 / 29.2% / 1778
skip if funding with the trade > 0.02%        1344 (19%)    5674 (63%)    7831 (42%)    5579 (68%)    6258 (46%)    5650 (45%)    4429 (51%)   20427   16337   7/7  | 77,403 / 1.52 / 29.2% / 1705
skip if funding with the trade > 0.05%        1344 (19%)    5674 (63%)    7831 (42%)    5363 (68%)    6621 (55%)    5591 (46%)    5224 (41%)   20212   17436   7/7  | 78,019 / 1.51 / 29.2% / 1740
skip if z with the trade > 1 (crowded)        1344 (19%)    5674 (63%)    7831 (42%)    5422 (68%)    5354 (65%)    5750 (44%)    4502 (44%)   20270   15606   7/7  | 72,482 / 1.47 / 29.2% / 1730
skip if z with the trade > 2 (very crowded)    1344 (19%)    5674 (63%)    7831 (42%)    4753 (68%)    5506 (78%)    5823 (44%)    5359 (40%)   19602   16688   7/7  | 75,204 / 1.47 / 29.2% / 1768
only if z with the trade < 0 (against the crowd)    1344 (19%)    5674 (63%)    7831 (42%)    4816 (68%)    5467 (52%)    5477 (38%)    2783 (42%)   19664   13727   7/7  | 68,035 / 1.55 / 29.2% / 1447
skip if z with the trade < -1 (contrarian check)    1344 (19%)    5674 (63%)    7831 (42%)    4346 (68%)    6717 (64%)    6333 (41%)    5120 (41%)   19195   18170   7/7  | 78,916 / 1.50 / 29.2% / 1769
-- first half of the coins --
live, first half                                712 (7%)    2231 (32%)    5425 (32%)    3021 (61%)    5553 (52%)    5146 (28%)    3347 (42%)   11388   14046   7/7  | 50,976 / 1.49 / 38.0% / 1151
z > 1 skip, first half                          712 (7%)    2231 (32%)    5425 (32%)    3232 (61%)    4786 (40%)    4901 (28%)    2299 (42%)   11600   11986   7/7  | 43,436 / 1.43 / 38.0% / 1098
> 0.02% skip, first half                        712 (7%)    2231 (32%)    5425 (32%)    3020 (61%)    4122 (35%)    5262 (29%)    3421 (42%)   11387   12805   7/7  | 45,914 / 1.48 / 38.0% / 1079
-- second half of the coins --
live, second half                              632 (19%)    3854 (42%)    3446 (37%)    3460 (52%)    4067 (47%)    4856 (46%)    2413 (51%)   11392   11335   7/7  | 40,796 / 1.51 / 25.1% / 1028
z > 1 skip, second half                        632 (19%)    3854 (42%)    3446 (37%)    3648 (52%)    3360 (42%)    5362 (44%)    2358 (51%)   11580   11080   7/7  | 40,012 / 1.52 / 25.1% / 999
> 0.02% skip, second half                      632 (19%)    3854 (42%)    3446 (37%)    3960 (52%)    4669 (33%)    4665 (44%)    2275 (49%)   11893   11609   7/7  | 42,394 / 1.58 / 25.1% / 984
```
