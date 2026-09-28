# Exit lab: trailing stop, time stop, regime filter

```
Exit lab · live portfolio (15 coins, TP 1.5/3/4.5R, 30/30/40%) · 2025-10-03 → 2026-09-28 · start 1000 USDT, $50 risk
train = first 2/3 (to 2026-05-31), test = last 1/3 — the walk-forward pick uses train only.

                         trades   win   net $   maxDD    PF     1/3     2/3     3/3   train    test
baseline (live now)         563   47%    6716   52.9%  1.55    2144    1555    2997    3785    2590

Trailing stop (replaces fixed T3)
  after T2, 2 ATR           557   46%    5868   52.9%  1.48    1484    2385    1979    3954    1583
  after T2, 3 ATR           537   47%    5655   52.9%  1.49    1242    1964    2428    3291    2060
  after T2, 4 ATR           509   47%    5509   52.9%  1.49    1230    1947    2178    3260    1904
  after T1, 2 ATR           635   47%    6226   52.9%  1.45    1634    2830    1764    4504    1544
  after T1, 3 ATR           552   47%    5483   52.9%  1.46    1275    1996    2214    3402    1937
  after T1, 4 ATR           511   47%    5468   52.9%  1.48    1243    2009    2062    3335    1853
  walk-forward: train pick "after T1, 2 ATR" (train 4504 vs baseline 3785) → test 1544 vs baseline 2590 (does NOT hold up)

Time stop (no T1 within N hours)
  24h                       239   42%   -1011  101.1%  0.78   -1011       0       0   -1011    1359
  36h                       880   49%    5334   48.7%  1.34    1839    1011    2464    2933    2072
  48h                       801   49%    6268   54.4%  1.40    2194    1674    2379    3953    2290
  72h                       691   47%    5121   58.9%  1.34    1934    1250    1916    3269    1609
  96h                       630   47%    6216   58.4%  1.45    2229    1729    2237    4044    1981
  walk-forward: train pick "96h" (train 4044 vs baseline 3785) → test 1981 vs baseline 2590 (does NOT hold up)

Regime filter (ADX on 4H)
  coin ADX >= 15            557   44%    5164   52.4%  1.40    1366    1451    2327    2902    1960
  coin ADX >= 20            106   28%    -981   98.8%  0.70    -981       0       0    -981    1676
  coin ADX >= 25            309   43%    1845   94.5%  1.24     -89     853    1058     852     665
  BTC ADX >= 15             537   46%    6619   52.9%  1.57    2095    1509    2995    3689    2588
  BTC ADX >= 20             477   44%    5206   52.9%  1.48    1516     887    2780    2466    2416
  BTC ADX >= 25             288   41%    2134   91.4%  1.30    -848     343    2618    -419    2239
  walk-forward: train pick "BTC ADX >= 15" (train 3689 vs baseline 3785) → nothing beat the baseline on train

```
