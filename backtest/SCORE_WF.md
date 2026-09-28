# Entry-score walk-forward check

```
Walk-forward entry-score check · live rules · train 2025-10-03 → 2026-05-31 · test 2026-05-31 → 2026-09-28

Per coin, traded alone. "train pick" = score chosen on the train window only (best average of it and its two
neighbouring scores, >= 10 trades; falls back to 50 if nothing makes money). Test columns: net $ on the unseen last third.

coin        live  train  test@50  test@live  test@train  full-year best
BTC           50     50      -89        -89         -89         80 (24)
ETH           75     30     -337         19        -672        75 (104)
SOL           50     40       -6         -6           9        40 (326)
XRP           50     50      113        113         113        50 (744)
BNB           65     50       56          2          56        65 (133)
DOGE          50     30     -133       -133        -206        35 (587)
HYPE          50     70      201        201         131        75 (500)
SUI           35     35       65        322         322       35 (1236)
ENA           50     55      226        226          55       50 (1597)
WLD           40     45      435        486         469       40 (1597)
DYDX          55     50      399        424         399        55 (985)
LDO           30     30      379        653         653       30 (1048)
GALA          45     40      166        335         317       45 (1125)
KAITO         35     40      -17        390          61       35 (1267)
FARTCOIN      30     40      -70         93         173        30 (746)
TOTAL                       1388       3035        1790

Portfolio (all coins together, live slots and BTC filter):

                                   trades   win   net $   maxDD    PF
Test window only (never seen by the train pick):
  flat 50                             193   47%    2590   31.3%  1.65
  live per-coin map                   205   45%    2316   39.5%  1.51
  walk-forward map                    205   45%    2495   28.1%  1.57
Whole period:
  flat 50                             563   47%    6716   52.9%  1.55
  live per-coin map (in-sample)       586   44%    6442   51.9%  1.48

Walk-forward map: BTC 50, ETH 30, SOL 40, XRP 50, BNB 50, DOGE 30, HYPE 70, SUI 35, ENA 55, WLD 45, DYDX 50, LDO 30, GALA 40, KAITO 40, FARTCOIN 40
```
