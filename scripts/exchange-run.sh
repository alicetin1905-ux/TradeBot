#!/usr/bin/env bash
# Bot runs for cron on the Mac (see README / scripts/setup-mac.sh).
#   scripts/exchange-run.sh demo            full hourly run on Bybit Demo Trading
#   scripts/exchange-run.sh demo sync       quick sync of positions/fills only
# Pulls the latest code, runs the bot, and — if PUSH_STATE=1 — commits
# state/demo/ back to GitHub for the dashboard. Logs: logs/demo.log.
set -euo pipefail
# cron starts with a bare PATH; add where Node/git usually live (nodejs.org
# installer, Homebrew on Apple Silicon and Intel, nvm-less Linux).
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
MODE="${1:-demo}"
case "$MODE" in demo) ;; *) echo "usage: $0 [demo] [sync]" >&2; exit 1 ;; esac
ARGS=()
[ "${2:-}" = "sync" ] && ARGS=(--sync)
cd "$(dirname "$0")/.."
mkdir -p logs

# One run at a time (they share the git checkout). A sync skips if another
# run is busy; a full run waits up to 3 minutes.
LOCK="logs/.run.lock"
TRIES=$([ ${#ARGS[@]} -gt 0 ] && echo 1 || echo 90)
got_lock=0
for _ in $(seq 1 "$TRIES"); do
  if mkdir "$LOCK" 2>/dev/null; then got_lock=1; break; fi
  # Stale lock from a crashed run (older than 15 min): take it over.
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +15 2>/dev/null)" ]; then rm -rf "$LOCK"; continue; fi
  [ "$TRIES" -gt 1 ] && sleep 2
done
[ "$got_lock" = 1 ] || exit 0
trap 'rm -rf "$LOCK"' EXIT

{
  if [ ${#ARGS[@]} -eq 0 ]; then echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="; fi
  git pull --rebase --autostash -q || echo "git pull failed — running current checkout"
  TRADEBOT_MODE="$MODE" node src/run.js ${ARGS[@]+"${ARGS[@]}"}

  if [ "${PUSH_STATE:-0}" = "1" ]; then
    git add "state/$MODE/"
    if ! git diff --cached --quiet; then
      git commit -q -m "Bybit $MODE ${ARGS[*]:-run} $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      git push -q || { git pull --rebase -q && git push -q; }
    fi
  fi
} >> "logs/$MODE.log" 2>&1
