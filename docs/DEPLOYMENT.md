# PHIRST2 deployment

Two processes, one database. The backend owns the trading engine; the frontend holds no
trading state and cannot place an order on its own.

| Process | Unit | Listens on | Responsibility |
| --- | --- | --- | --- |
| Backend | `phirst-api.service` | `PHIRST_API_PORT` (12001) | REST API, market-data stream, trading engine, Telegram bot |
| Frontend | `phirst-web.service` | 12000 | Next.js UI, proxies to the backend |

The engine runs inside the backend process so exactly one writer places orders. A PostgreSQL
advisory lock (`acquireLeaderLock`) makes a duplicate engine refuse to trade even if a second
instance is started by mistake.

## Prerequisites

- Debian/Ubuntu VPS, Node.js 20+, npm.
- PostgreSQL 14+ reachable from the host.
- A reverse proxy (Caddy or nginx) terminating TLS in front of port 12000, and forwarding
  `/api/*` and `/ws` to port 12001.

## 1. Install

```bash
sudo useradd -r -m -d /opt/phirst2 phirst
sudo -u phirst git clone <repo-url> /opt/phirst2
cd /opt/phirst2
sudo -u phirst npm ci
```

## 2. Configure

```bash
sudo -u phirst cp .env.example .env
# Generate the two secrets. The master key MUST decode to exactly 32 bytes.
echo "PHIRST_MASTER_KEY=$(openssl rand -base64 32)" >> /tmp/secrets
echo "PHIRST_SESSION_SECRET=$(openssl rand -base64 32)" >> /tmp/secrets
sudo -u phirst editor /opt/phirst2/.env
chmod 600 /opt/phirst2/.env
```

Fill in `DATABASE_URL`, the two secrets, and `PHIRST_WEB_ORIGIN`. Leave `GEMINI_API_KEY` and
`TELEGRAM_BOT_TOKEN` empty to run without those integrations.

## 3. Database

```bash
sudo -u postgres psql -c "CREATE USER phirst WITH PASSWORD '...';"
sudo -u postgres psql -c "CREATE DATABASE phirst OWNER phirst;"
sudo -u phirst -H -s -- npm run migrate
```

## 4. Build and start

```bash
sudo -u phirst env NODE_ENV=production npm run build -w @phirst/web
sudo cp infra/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now phirst-api phirst-web
```

## 5. Verify

```bash
curl -fsS http://127.0.0.1:12001/api/health | jq
# ok:true and every check green. database/broker/engine/llm are reported independently.
sudo -u phirst npm run smoke          # 43 end-to-end checks against the running API
```

## Operations

```bash
sudo journalctl -u phirst-api -f            # structured JSON logs
sudo systemctl restart phirst-api           # engine returns paused; it never auto-resumes trading
sudo systemctl stop phirst-api              # release the leader lock and close broker sockets
```

Backups: `pg_dump` the `phirst` database on a schedule; the audit log and order history are the
records that matter. Nothing else on the host is stateful.

## Recovery model

- The API exits non-zero if the database is unreachable at boot; systemd restarts it.
- On restart the engine reads persisted state. A `running` engine is restored as `paused`, so a
  crash can never silently resume trading.
- After any connectivity loss the engine reconciles against real broker positions before it
  resumes opening trades, and never resubmits an order whose outcome was uncertain.
