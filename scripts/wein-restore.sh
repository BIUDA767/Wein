#!/usr/bin/env bash
# Rebuild the whole local stack after a sandbox runtime reset.
#
# The runtime pod is recreated periodically; Docker, Postgres, the services and the
# supervisor all disappear with it. The working tree, .env and git survive. This script
# is idempotent: every step checks whether its target already exists before acting.
#
#   ./scripts/wein-restore.sh
#
set -u
cd "$(dirname "$0")/.." || exit 1
PORT_API="${PHIRST_API_PORT:-12001}"
PG_NAME="${PG_CONTAINER:-phirst-pg}"
PG_USER=phirst
PG_DB=phirst
OWNER_USER="${WEIN_OWNER_USER:-baelay}"
OWNER_PASS="${WEIN_OWNER_PASS:-baelay_secure_pw_2026}"
mkdir -p .run
say() { printf '\n== %s\n' "$1"; }
ok() { printf '   ok: %s\n' "$1"; }

say "1. Docker daemon"
if ! sudo docker info >/dev/null 2>&1; then
  sudo dockerd >/tmp/dockerd.log 2>&1 &
  for _ in $(seq 1 30); do sudo docker info >/dev/null 2>&1 && break; sleep 1; done
fi
sudo docker info >/dev/null 2>&1 && ok "docker up" || { echo "docker failed; see /tmp/dockerd.log"; exit 1; }

say "2. Postgres"
if ! sudo docker ps --format '{{.Names}}' | grep -qx "$PG_NAME"; then
  sudo docker rm -f "$PG_NAME" >/dev/null 2>&1
  sudo docker run -d --name "$PG_NAME" \
    -e POSTGRES_USER="$PG_USER" -e POSTGRES_PASSWORD=phirst_dev_pw -e POSTGRES_DB="$PG_DB" \
    -p 5432:5432 postgres:16-alpine >/dev/null
fi
for _ in $(seq 1 40); do sudo docker exec "$PG_NAME" pg_isready -U "$PG_USER" >/dev/null 2>&1 && break; sleep 1; done
sudo docker exec "$PG_NAME" pg_isready -U "$PG_USER" >/dev/null 2>&1 && ok "postgres ready" || { echo "postgres not ready"; exit 1; }
sudo docker exec "$PG_NAME" psql -U "$PG_USER" -d "$PG_DB" -tc "SELECT 1 FROM pg_database WHERE datname='phirst_test'" | grep -q 1 \
  || sudo docker exec "$PG_NAME" psql -U "$PG_USER" -d "$PG_DB" -c "CREATE DATABASE phirst_test OWNER $PG_USER;" >/dev/null

say "3. Migrations"
npm run migrate 2>&1 | grep -E '"msg":"migrations complete"' || echo "   (migrate output above)"

say "4. API"
if ! curl -s -m 3 -o /dev/null "http://localhost:$PORT_API/api/health"; then
  nohup npm run start:api >.run/api.log 2>&1 &
  for _ in $(seq 1 40); do curl -s -m 3 -o /dev/null "http://localhost:$PORT_API/api/health" && break; sleep 1; done
fi
curl -s -m 5 "http://localhost:$PORT_API/api/health" >/dev/null && ok "api up" || { echo "api failed; see .run/api.log"; exit 1; }

say "5. Web"
if [ ! -d apps/web/.next ]; then
  ( cd apps/web && NODE_ENV=production npm run build ) || { echo "web build failed"; exit 1; }
fi
if ! curl -s -m 3 -o /dev/null http://localhost:12000/; then
  ( cd apps/web && nohup npm run start >../../.run/web.log 2>&1 & )
  for _ in $(seq 1 40); do curl -s -m 3 -o /dev/null http://localhost:12000/ && break; sleep 1; done
fi
curl -s -m 5 -o /dev/null http://localhost:12000/ && ok "web up" || { echo "web failed; see .run/web.log"; exit 1; }

say "6. Owner account"
if curl -s -m 5 "http://localhost:$PORT_API/api/auth/status" | grep -q '"ownerExists":true'; then
  ok "owner exists"
else
  curl -s -m 10 -X POST "http://localhost:$PORT_API/api/auth/setup" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$OWNER_USER\",\"password\":\"$OWNER_PASS\"}" | head -c 200; echo
  ok "owner created"
fi

say "7. Paper broker + engine"
JAR=.run/restore-cookies.txt; rm -f "$JAR"
curl -s -m 10 -c "$JAR" -X POST "http://localhost:$PORT_API/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$OWNER_USER\",\"password\":\"$OWNER_PASS\"}" >/dev/null
if curl -s -m 8 -b "$JAR" "http://localhost:$PORT_API/api/brokers" | grep -q '"provider":"paper"'; then
  ok "paper broker already connected"
else
  BID=$(curl -s -m 10 -b "$JAR" -X POST "http://localhost:$PORT_API/api/brokers" -H 'Content-Type: application/json' \
        -d '{"provider":"paper","label":"Paper simulator"}' | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
  [ -n "$BID" ] && curl -s -m 8 -b "$JAR" -X POST "http://localhost:$PORT_API/api/brokers/$BID/activate" >/dev/null && ok "paper broker activated"
fi
curl -s -m 8 -b "$JAR" -X POST "http://localhost:$PORT_API/api/engine/symbol" -H 'Content-Type: application/json' -d '{"symbol":"R_100"}' >/dev/null
curl -s -m 8 -b "$JAR" -X POST "http://localhost:$PORT_API/api/engine/start" -H 'Content-Type: application/json' -d '{}' >/dev/null
ok "engine started on R_100"

say "8. Supervisor"
pgrep -f wein-supervise.sh >/dev/null || ( setsid nohup ./scripts/wein-supervise.sh >/dev/null 2>&1 & )
sleep 2; pgrep -f wein-supervise.sh >/dev/null && ok "supervisor running"

say "Done"
printf '   web  http://localhost:12000/\n   api  http://localhost:%s/api/health\n' "$PORT_API"
