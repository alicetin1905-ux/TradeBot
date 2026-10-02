# iOS home-screen widget

Shows equity, open positions with live P&L (T1/T2 status), and the coins at
score +50 or higher / −50 or lower that aren't open yet, plus the BTC filter.
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
