# BTC cool-down after a strong BTC score (entry score 65)

```
BTC cool-down after a strong BTC score (entry score 65) · 21 coins · 2020-09-23 → 2026-10-02 · 4H, live rules otherwise

Per year: fresh 2000 USDT, $100 fixed risk — net $ (worst drop). Compound: 2000 USDT, 2.5% risk, whole period.

Cool-down: once BTC's 4H score reaches +hi, no new longs until it drops below +lo (shorts mirrored at -hi / -lo). Open trades are untouched.

variant                                             2020          2021          2022          2023          2024          2025          2026   20-23   24-26  yrs+  | compound end $ / PF / worst drop / trades
A  live: score 65, BTC filter                  950 (25%)    5818 (66%)    9999 (41%)    1882 (88%)    6164 (54%)    3154 (82%)    7208 (70%)   18649   16526   7/7  | 70,922 / 1.34 / 36.8% / 2136
BTC >= +65: no longs until BTC < +25 (mirror shorts)     332 (29%)    2279 (48%)    8837 (39%)   -1936 (97%)    5171 (62%)    4383 (53%)    3354 (47%)    9512   12909   6/7  | 38,426 / 1.28 / 36.1% / 1517
same, but no trades at all until it cools      332 (29%)    2279 (48%)    8837 (39%)   -1936 (97%)    5171 (62%)    4383 (53%)    3354 (47%)    9512   12909   6/7  | 38,426 / 1.28 / 36.1% / 1517
BTC >= +75 -> wait under +25                   266 (29%)    2314 (58%)    7997 (39%)    1720 (56%)    5148 (57%)    4444 (56%)    3544 (49%)   12298   13137   7/7  | 43,670 / 1.30 / 33.9% / 1646
BTC >= +65 -> wait under +40                   245 (30%)    2401 (46%)    8505 (42%)      82 (84%)    6100 (51%)    4143 (53%)    3403 (47%)   11234   13646   7/7  | 41,708 / 1.29 / 29.2% / 1612
BTC >= +55 -> wait under +25                   332 (29%)    2870 (50%)    8361 (45%)   -1981 (99%)    4271 (65%)    3157 (53%)    2406 (36%)    9582    9834   6/7  | 33,067 / 1.25 / 38.0% / 1407
-- reference --
score 50 (old live)                            903 (62%)    8179 (70%)    8799 (40%)    3931 (64%)    6692 (56%)    4887 (86%)    7904 (35%)   21813   19483   7/7  | 75,212 / 1.27 / 31.3% / 2817
score 50 + BTC >= +65 -> under +25              74 (52%)    6192 (42%)    9504 (47%)     661 (70%)    4786 (70%)    6359 (75%)    5460 (39%)   16431   16605   7/7  | 55,170 / 1.26 / 32.9% / 2206
```
