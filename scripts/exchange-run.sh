#!/usr/bin/env bash
# Bot runs for cron on the Mac (see README / scripts/setup-mac.sh).
#   scripts/exchange-run.sh demo            full hourly run on Bybit Demo Trading
#   scripts/exchange-run.sh demo sync       quick sync of positions/fills only
#   scripts/exchange-run.sh paper           the paper account (state/*.json)
# Pulls the latest code, runs the bot, and — if PUSH_STATE=1 — commits that
# mode's state back to GitHub for the dashboard. Logs: logs/<mode>.log.
set -euo pipefail
# cron starts with a bare PATH; add where Node/git usually live (nodejs.org
# installer, Homebrew on Apple Silicon and Intel, nvm-less Linux).
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
MODE="${1:-demo}"
case "$MODE" in demo|paper) ;; *) echo "usage: $0 [demo|paper] [sync]" >&2; exit 1 ;; esac
ARGS=()
if [ "${2:-}" = "sync" ]; then
  [ "$MODE" = "paper" ] && { echo "sync is for demo only" >&2; exit 1; }
  ARGS=(--sync)
fi
cd "$(dirname "$0")/.."
mkdir -p logs

# One run at a time across all modes (they share the git checkout). A sync
# skips if anything else is running; a full run waits up to 3 minutes.
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

if [ "$MODE" = "paper" ]; then STATE_PATHS=(state/*.json); else STATE_PATHS=("state/$MODE/"); fi

{
  if [ ${#ARGS[@]} -eq 0 ]; then echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="; fi
  git pull --rebase --autostash -q || echo "git pull failed — running current checkout"
  TRADEBOT_MODE="$MODE" node src/run.js ${ARGS[@]+"${ARGS[@]}"}

  if [ "${PUSH_STATE:-0}" = "1" ]; then
    git add "${STATE_PATHS[@]}"
    if ! git diff --cached --quiet; then
      git commit -q -m "$([ "$MODE" = paper ] && echo "Bot run" || echo "Bybit $MODE ${ARGS[*]:-run}") $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      git push -q || { git pull --rebase -q && git push -q; }
    fi
  fi
} >> "logs/$MODE.log" 2>&1
