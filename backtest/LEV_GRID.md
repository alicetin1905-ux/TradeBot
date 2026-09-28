# Leverage grid

```
Leverage grid · planned setup ($100 risk, 7 slots, max 4/direction) · 15 coins · start 2000 USDT · 2025-10-03 → 2026-09-28
"capped" = trades whose size was cut because the position cap was below $100 / stop distance.
"stop > liq" = trades whose stop sat beyond the isolated-margin liquidation price (1/lev - 0.5%).

Max margin fixed at $400 (position cap = $400 x lev)
setup                              trades   net $    ret   maxDD    PF  avg mgn  peak mgn  capped  stop>liq    1/3    2/3    3/3
5x · cap $400 margin                  485    8872   444%   53.3%  1.52     $364     $2800     291         1   2273   3398   3160
6x · cap $400 margin                  485   10135   507%   44.5%  1.55     $341     $2800     230         3   3221   3599   3274
7x · cap $400 margin                  485   10605   530%   46.4%  1.54     $317     $2793     172         4   3508   3657   3400
8x · cap $400 margin                  485   10865   543%   45.3%  1.54     $294     $2721     134         8   3637   3662   3526
9x · cap $400 margin                  485   11050   552%   45.3%  1.53     $272     $2641      98        16   3654   3707   3648
10x · cap $400 margin                 485   11247   562%   45.3%  1.53     $253     $2547      82        24   3670   3742   3795

Max position fixed at $4000 (margin cap = $4000 / lev)
setup                              trades   net $    ret   maxDD    PF  avg mgn  peak mgn  capped  stop>liq    1/3    2/3    3/3
5x · cap $800 margin                  465    8955   448%   62.3%  1.43     $495     $5093      71         2   1185   3935   3795
6x · cap $667 margin                  486   10684   534%   49.5%  1.50     $419     $4244      80         3   3107   3742   3795
7x · cap $571 margin                  485   11247   562%   46.0%  1.53     $360     $3638      81         4   3669   3742   3795
8x · cap $500 margin                  485   11247   562%   45.3%  1.53     $316     $3183      82         8   3670   3742   3795
9x · cap $444 margin                  485   11247   562%   45.3%  1.53     $281     $2830      82        16   3670   3742   3795
10x · cap $400 margin                 485   11247   562%   45.3%  1.53     $253     $2547      82        24   3670   3742   3795

```
