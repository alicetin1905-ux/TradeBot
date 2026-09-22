#!/usr/bin/env bash
# One testnet run, for cron on the machine that holds .env (see README).
# Pulls the latest code, runs the bot against Bybit testnet, and — if
# PUSH_STATE=1 — commits state/testnet/ back to GitHub so the dashboard's
# Testnet view shows it. Logs append to logs/testnet.log.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs

{
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  git pull --rebase --autostash -q || echo "git pull failed — running current checkout"
  TRADEBOT_MODE=testnet node src/run.js

  if [ "${PUSH_STATE:-0}" = "1" ]; then
    git add state/testnet/
    if ! git diff --cached --quiet; then
      git commit -q -m "Testnet run $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      git push -q || { git pull --rebase -q && git push -q; }
    fi
  fi
} >> logs/testnet.log 2>&1
