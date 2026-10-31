#!/usr/bin/env bash
# Keep the API and web server alive. These processes are nohup'd inside the sandbox;
# nothing else restarts them if they die, so this loop does. Idempotent: it only starts
# a service that is not already answering on its port.
cd "$(dirname "$0")/.." || exit 1
LOG=.run/supervise.log
mkdir -p .run
# Load .env here so a restarted service always sees the current file. The sandbox injects
# the env only at shell start, so without this a change to .env is ignored until the pod
# resets and the supervisor is restarted by hand.
if [ -f .env ]; then set -a; . ./.env; set +a; fi
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$1" >>"$LOG"; }
up() { curl -s -m 3 -o /dev/null "http://localhost:$1$2"; }
while true; do
  if ! up 12001 /api/health; then
    log "api down; restarting"
    nohup npm run start:api >.run/api.log 2>&1 &
    sleep 8
  fi
  if ! up 12000 /; then
    log "web down; restarting"
    ( cd apps/web && nohup npm run start >../../.run/web.log 2>&1 & )
    sleep 8
  fi
  sleep 15
done
