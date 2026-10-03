# Time stop: close when T1 not reached after N hours (entry score 65)

```
Time stop: close when T1 not reached after N hours (entry score 65) · 21 coins · 2020-09-24 → 2026-10-03 · 4H, live rules otherwise

Per year: fresh 2000 USDT, $100 fixed risk — net $ (worst drop). Compound: 2000 USDT, 2.5% risk, whole period.

Time stop: a trade still short of T1 after N hours is closed at market (taker fee). Checked hourly, like the live bot.

variant                                             2020          2021          2022          2023          2024          2025          2026   20-23   24-26  yrs+  | compound end $ / PF / worst drop / trades
A  live: no time stop                          950 (25%)    5818 (66%)    9999 (41%)    1882 (88%)    6164 (54%)    3154 (82%)    7244 (70%)   18649   16562   7/7  | 71,027 / 1.34 / 36.8% / 2136
close after 12h without T1                     512 (12%)    1007 (34%)    3968 (25%)   -1957 (98%)    3678 (59%)    5096 (41%)    1224 (50%)    3530    9998   6/7  | 18,976 / 1.15 / 71.0% / 3848
close after 24h without T1                    1089 (20%)    2320 (51%)    8339 (38%)   -1936 (98%)    5818 (61%)    6545 (47%)    4909 (74%)    9812   17271   6/7  | 39,998 / 1.20 / 65.7% / 3403
close after 36h without T1                    1008 (19%)    2821 (49%)    8922 (44%)   -1945 (98%)    7355 (55%)    6464 (48%)    4147 (61%)   10806   17966   6/7  | 44,271 / 1.21 / 51.7% / 3080
close after 48h without T1                    1211 (24%)    3274 (57%)    9797 (41%)  -2027 (101%)    6784 (66%)    5886 (49%)    6380 (60%)   12254   19051   6/7  | 45,640 / 1.21 / 61.5% / 2850
close after 72h without T1                    1009 (27%)    4565 (63%)   10443 (44%)   -1088 (97%)    6559 (53%)    4146 (66%)    5691 (69%)   14928   16395   6/7  | 56,798 / 1.25 / 37.9% / 2552
-- only when the trade is in loss --
24h without T1 and in loss                    1100 (22%)    1564 (48%)    9398 (35%)   -1956 (99%)    6109 (66%)    5686 (53%)    4637 (72%)   10106   16432   6/7  | 35,834 / 1.19 / 66.4% / 2949
48h without T1 and in loss                    1205 (26%)    3114 (67%)    9958 (44%)     128 (93%)    6816 (55%)    4899 (60%)    5832 (62%)   14405   17546   7/7  | 50,916 / 1.25 / 43.7% / 2518
```
