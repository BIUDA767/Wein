# WEIN

**Calm in execution. Precise in judgement. Relentless in discipline.**

WEIN is a real, multi-broker autonomous trading platform with PHIRST2, an integrated AI
trading assistant. It runs on a dedicated backend, trades through broker APIs you connect
yourself, and ships as a native-quality app for iOS, Android and desktop web.

This is not a dashboard mock-up. Every visible control performs its action, every number
has a real source, and no balance, price or trade is ever invented.

---

## What it does

- **Trading.** Live prices and candlestick charts from the active broker, technical
  indicators, drawing tools, market and fixed-expiry orders where the provider supports
  them. Manual buy and sell, plus an autonomous engine.
- **Brokers.** Modular adapters. Deriv (synthetics, forex, crypto, indices, commodities)
  and an internal paper simulator are implemented. OANDA, Binance, Alpaca and Interactive
  Brokers are listed with exactly what each requires; they are not implemented yet and the
  app says so.
- **Intelligence.** Eight analysis agents (market, technical, quantitative, sentiment,
  strategy, risk, execution, performance). The risk engine holds final veto. Cloud AI is
  used for research; time-sensitive decisions use deterministic logic.
- **PHIRST2.** A companion with a procedural 3D avatar, speech synthesis and recognition,
  a full-screen command centre, and a memory you can read, edit and delete. It speaks only
  from measured facts and labels its own opinions as opinions.
- **Community.** An invite-only feed with comments, likes, private messaging and members,
  moderated by PHIRST2 automatically and reviewable by the owner.
- **Owner dashboard.** Invites, member roles, suspension, the broker catalog, moderation
  review and the global live-trading master switch.

## Honest by design

- No hardcoded secrets. Everything sensitive is read from the environment.
- Capability reporting reflects what each provider's API genuinely supports. Nothing is
  claimed that is not implemented.
- When the market feed is unavailable the chart draws its axes and a connection notice and
  **no candles at all**. It never fabricates a price.
- Deposits and withdrawals read zero until a broker actually reports them.
- Live trading needs the owner's platform-wide switch **and** a per-account confirmation
  phrase. The engine never switches from paper to live on its own.

## Architecture

```
packages/core      config, logger, domain types, indicators, crypto vault,
                   DB pool and repositories, risk engine, strategy registry
packages/brokers   adapter framework and one adapter per provider
packages/ai        Gemini client, the eight analysis agents, PHIRST2, moderation
packages/engine    trading loop: risk veto, execution, reconciliation
apps/api           HTTP + WebSocket API, sessions, roles, market proxy, Telegram
apps/web           Next.js app (iOS-style navigation, charts, PHIRST2, community)
db/migrations      forward-only SQL
infra              systemd units, backup and health scripts
```

The trading engine is independent of the frontend. Closing the browser does not stop it;
only its running state and the emergency stop do.

## Getting started

Requirements: Node 20.11+, PostgreSQL 14+.

```bash
cp .env.example .env          # then fill in the values below
npm install
npm run migrate               # apply db/migrations/*.sql
npm run seed                  # register the built-in strategies
npm run dev:api               # API on PHIRST_API_PORT (default 12001)
npm run dev:web               # web on 12000
```

`PHIRST_MASTER_KEY` and `PHIRST_SESSION_SECRET` must each be 32 bytes:

```bash
openssl rand -base64 32
```

The master key must decode to **exactly** 32 bytes or the API refuses to start.

### First run

Open the app and create the owner account. That account is the platform owner; it can be
created once and cannot be recreated. Every other account needs an invite code from the
owner dashboard.

### Paper trading

Paper mode is the default and is always labelled. It routes orders to an internal
simulator that uses live market data for fills and settlement; no order reaches a provider.
Start the engine from the Trade screen and it will trade the active instrument under your
risk limits.

### Going live

1. In the owner dashboard, connect a real-money broker account and verify its permissions.
2. Enable the global live-trading master switch (requires typing the confirmation phrase).
3. Switch the engine to live and type the per-account confirmation phrase.
4. Confirm the emergency stop works and that positions reconcile before you increase size.

## Verifying

```bash
npm run verify                # typecheck all workspaces + unit and integration tests
SMOKE_RESET=1 ./scripts/wein-smoke.sh   # 25 end-to-end checks against a running API
```

`SMOKE_RESET=1` clears platform tables first, so the script is repeatable. Without it the
script only reads and creates, and is safe against an environment you care about.

## Safety

- The risk engine has final veto: risk per trade, daily loss limit, maximum drawdown,
  maximum exposure, maximum concurrent trades, consecutive-loss limits, allowed
  instruments and strategies. It reduces exposure after a losing streak and never
  martingales.
- An uncertain execution response is never retried blindly; the engine reconciles with the
  broker before resuming.
- Broker credentials are encrypted with AES-256-GCM and never returned to the browser, never
  written to AI memory and never logged.
- PHIRST2's memory never stores broker secrets, and you can read, edit and delete it.

## Documentation

- `AGENTS.md` — engineering notes and the numbered load-bearing invariants.
- `docs/ARCHITECTURE.md` — how the services fit together.
- `docs/DEPLOYMENT.md` — VPS deployment, supervision, backups, health checks.
- `docs/FINAL_REPORT.md` — what is implemented, verified, and still awaiting credentials.
