# Risk sizing from different start dates

```
Risk sizing from 12 start dates · live setup · 15 coins · start 2000 USDT each time · 120-day windows starting 20 days apart

window                           $50 fixed ret   maxDD      $100 fixed ret   maxDD 2.5% of balance ret   maxDD3.75% of balance ret   maxDD
2025-10-03 → 2026-01-31                    97%   26.7%                184%   45.3%                107%   28.3%                150%   39.8%
2025-10-23 → 2026-02-20                   147%   18.9%                285%   30.3%                243%   24.9%                379%   32.1%
2025-11-12 → 2026-03-12                   120%   18.2%                233%   26.6%                169%   25.0%                268%   32.1%
2025-12-02 → 2026-04-01                   102%   25.1%                217%   44.3%                130%   25.9%                212%   36.9%
2025-12-22 → 2026-04-21                   102%   26.1%                217%   45.4%                136%   25.2%                245%   34.8%
2026-01-11 → 2026-05-11                   120%   15.8%                240%   32.3%                164%   23.4%                261%   30.8%
2026-01-31 → 2026-05-31                   100%   17.0%                193%   24.4%                135%   23.4%                237%   32.1%
2026-02-20 → 2026-06-20                   107%   26.0%                195%   43.7%                147%   26.2%                234%   36.0%
2026-03-12 → 2026-07-10                   124%   16.9%                234%   29.0%                176%   21.6%                261%   28.9%
2026-04-01 → 2026-07-30                    69%   26.3%                101%   58.3%                 69%   32.9%                 98%   38.5%
2026-04-21 → 2026-08-19                   100%   29.1%                176%   38.4%                115%   46.1%                163%   50.6%
2026-05-11 → 2026-09-08                    86%   32.9%                162%   43.9%                 94%   46.8%                139%   56.1%

summary                                      $50 fixed                  $100 fixed             2.5% of balance            3.75% of balance
median return                                     102%                        217%                        136%                        237%
worst return                                       69%                        101%                         69%                         98%
median worst drop                                26.0%                       43.7%                       25.9%                       36.0%
largest worst drop                               32.9%                       58.3%                       46.8%                       56.1%

Margin cap with 2.5% of balance, whole year:
  max margin $400 (position $4000)          732%   28.3%   trades at the cap: 242 of 486
  max margin $600 (position $6000)          803%   35.0%   trades at the cap: 173 of 486
  max margin $800 (position $8000)          844%   40.6%   trades at the cap: 110 of 486
  max margin $1200 (position $12000)        901%   45.4%   trades at the cap: 59 of 486
```
