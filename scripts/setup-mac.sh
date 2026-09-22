#!/usr/bin/env bash
# One-time setup on the Mac that runs the Bybit demo bot:
#   - git identity + saved GitHub token so runs can push state/demo/
#   - first upload of state/demo/ so the dashboard's Bybit demo tab fills
#   - cron: full run hourly at :06, quick sync every 5 minutes
# Safe to run again: it replaces its own cron lines and leaves others alone.
#
#   cd ~/TradeBot && bash scripts/setup-mac.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_DIR="$(pwd)"
MODE="${1:-demo}"
USER_NAME="alicetin1905-ux"

echo "TradeBot setup in $REPO_DIR (mode: $MODE)"

if [ ! -f .env ]; then
  echo "No .env here — create it first (cp .env.example .env, then add your Bybit key)." >&2
  exit 1
fi

git pull -q --rebase --autostash || true
chmod +x scripts/exchange-run.sh

git config user.name "$USER_NAME"
git config user.email "$USER_NAME@users.noreply.github.com"
git config credential.helper store

# Only ask for a token if none is saved for github.com yet.
if ! grep -q "@github.com" "$HOME/.git-credentials" 2>/dev/null; then
  echo
  echo "Paste your GitHub token (fine-grained, TradeBot only, Contents: Read and write)."
  echo "Nothing is shown while you paste — press Enter afterwards."
  read -r -s TOKEN
  echo
  [ -n "$TOKEN" ] || { echo "No token entered — stopping." >&2; exit 1; }
  umask 077
  printf 'https://%s:%s@github.com\n' "$USER_NAME" "$TOKEN" >> "$HOME/.git-credentials"
  chmod 600 "$HOME/.git-credentials"
  unset TOKEN
fi

# Make sure state exists (does one sync if the bot hasn't run here yet), then upload it.
if [ ! -f "state/$MODE/account.json" ]; then
  TRADEBOT_MODE="$MODE" node src/run.js --sync || true
fi
git add "state/$MODE/" 2>/dev/null || true
if ! git diff --cached --quiet; then
  git commit -q -m "Bybit $MODE state (setup)"
fi
if git push -q; then
  echo "✓ Upload to GitHub works."
else
  echo "✗ git push failed — the token is probably wrong or lacks 'Contents: Read and write' on TradeBot." >&2
  echo "  Remove it with:  sed -i '' '/@github.com/d' ~/.git-credentials   then run this script again." >&2
  exit 1
fi

# Replace any earlier exchange-run.sh cron lines with the two we want.
RUN="$REPO_DIR/scripts/exchange-run.sh"
OTHER_JOBS="$(crontab -l 2>/dev/null | grep -v 'exchange-run.sh' || true)"
{
  [ -n "$OTHER_JOBS" ] && printf '%s\n' "$OTHER_JOBS"
  echo "6 * * * *   PUSH_STATE=1 $RUN $MODE"
  echo "*/5 * * * * PUSH_STATE=1 $RUN $MODE sync"
} | crontab -
echo "✓ Schedule installed:"
crontab -l | grep exchange-run.sh

echo
echo "Done. Dashboard: https://alicetin1905-ux.github.io/TradeBot/?mode=$MODE"
echo "Keep the Mac awake (System Settings → Energy → Prevent automatic sleeping)."
echo "Log: tail -30 $REPO_DIR/logs/$MODE.log"
