#!/usr/bin/env bash
# One Bybit run, for cron on the machine that holds .env (see README).
#   scripts/exchange-run.sh demo      Bybit Demo Trading (default)
#   scripts/exchange-run.sh testnet   Bybit testnet
# Pulls the latest code, runs the bot, and — if PUSH_STATE=1 — commits
# state/<mode>/ back to GitHub so the dashboard's tab for that mode shows it.
# Logs append to logs/<mode>.log.
set -euo pipefail
MODE="${1:-demo}"
case "$MODE" in demo|testnet) ;; *) echo "usage: $0 [demo|testnet]" >&2; exit 1 ;; esac
cd "$(dirname "$0")/.."
mkdir -p logs

{
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  git pull --rebase --autostash -q || echo "git pull failed — running current checkout"
  TRADEBOT_MODE="$MODE" node src/run.js

  if [ "${PUSH_STATE:-0}" = "1" ]; then
    git add "state/$MODE/"
    if ! git diff --cached --quiet; then
      git commit -q -m "Bybit $MODE run $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      git push -q || { git pull --rebase -q && git push -q; }
    fi
  fi
} >> "logs/$MODE.log" 2>&1
