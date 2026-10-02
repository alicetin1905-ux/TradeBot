# iOS home-screen widget

Shows:

- equity, open profit, realized P&L today (and 7 days / total on large)
- open positions with a stop→T3 progress bar (red tick = stop, white = entry,
  grey = T1/T2/T3, dot = price) and, on large, distance to the stop and the
  next target
- money at risk: what the book is worth if every stop fills now (negative =
  at risk, positive = profit locked in), and free slots
- coins at score +50 / −50 that aren't open, each with why it can or can't
  enter: READY, next 4H close (with countdown), signal used, ran too far,
  Fib check, BTC blocks, or long/short limit reached
- BTC filter and the countdown to the next 4H close (the entry check)

Read-only: it only reads the public `state/demo/*.json` files the dashboard
uses. No keys, can't place or change trades.

## Setup (2 minutes)

1. Install **Scriptable** (free) from the App Store.
2. Open Scriptable, tap **+**, and paste the whole of `ios/TradeBotWidget.js`.
   Name it `TradeBot`. Tap ▶ to preview.
3. Long-press the home screen, **+**, **Scriptable**, pick small / medium / large,
   add it, then long-press the widget, **Edit Widget**, Script: `TradeBot`.
   (A Lock Screen or StandBy widget works the same way.)

Tapping the widget opens the dashboard. iOS decides how often a widget
refreshes (roughly every 5–15 minutes); the data itself updates with each
5-minute sync from the Mac.
