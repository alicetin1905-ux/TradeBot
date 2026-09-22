#!/usr/bin/env bash
# Start an account over from 1000 USDT, then upload it for the dashboard.
#   scripts/reset.sh demo              close everything on Bybit Demo + reset the bot
#   scripts/reset.sh demo --clear-history   ...and also wipe the trade history
#   scripts/reset.sh paper [--clear-history]   the paper account
# Holds the same lock as the scheduled runs, so none of them can run mid-reset.
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
MODE="${1:-}"
case "$MODE" in demo|paper) ;; *) echo "usage: $0 demo|paper [--clear-history]" >&2; exit 1 ;; esac
CLEAR="${2:-}"
cd "$(dirname "$0")/.."
mkdir -p logs

LOCK="logs/.run.lock"
for i in $(seq 1 90); do
  mkdir "$LOCK" 2>/dev/null && break
  [ "$i" = 90 ] && { echo "Another bot run is still busy — try again in a few minutes." >&2; exit 1; }
  sleep 2
done
trap 'rm -rf "$LOCK"' EXIT

git pull -q --rebase --autostash || echo "git pull failed — resetting the current checkout"

if [ "$MODE" = paper ]; then DIR=state; else DIR="state/$MODE"; fi

if [ "$MODE" != paper ]; then
  echo "Closing all positions and cancelling all orders on Bybit $MODE…"
  TRADEBOT_MODE="$MODE" node src/run.js --close-all
fi
TRADEBOT_MODE="$MODE" node src/run.js --reset
if [ "$CLEAR" = "--clear-history" ]; then
  echo '[]' > "$DIR/trades.json"
  echo "Trade history cleared."
fi

if [ "$MODE" = paper ]; then git add state/*.json; else git add "$DIR/"; fi
if ! git diff --cached --quiet; then
  git commit -q -m "Reset $MODE account"
  git push -q || { git pull --rebase -q && git push -q; }
  echo "✓ Uploaded — the dashboard shows the reset within a minute."
else
  echo "Nothing changed."
fi
