# Project memory — BICC / aegis-trade

Index of durable facts. Detail lives in daily logs.

## Where the truth lives
- `AGENTS.md` is the canonical repo-notes file (invariants numbered 1..33). Read it first.
  Add a numbered invariant there for any safety-relevant change; that is the established habit.
- `docs/connectors.md` and `docs/ARCHITECTURE.md` document connector/execution-environment
  behavior. Keep them in step with code.

## Session 2026-10-27 — live-vs-simulated execution environment (see log)
- Fixed a fail-open: live-execution authorization was keyed on the caller-asserted
  `TradeIntent.environment`, so `environment:'paper'` against a real-money connector skipped
  the `live_auto_disabled` gate.
- Second, deeper fail-open: `DerivConnector.authorize()` fell back to `auth.loginid` when no
  virtual account matched, while the worker hardcodes `demo:true` — a "demo" order could
  settle on a real account.
- Fix commits: `7d74f43` (connector-keyed authorization + `executionEnvironment`) and
  `029a1c8` (refuse real-account authorize when demo requested).

## Environment quirks learned (expensive)
- This sandbox had **no Postgres and no running Docker daemon**. `sudo dockerd &` brings the
  daemon up; the socket is root-owned so use `sudo docker ...`. Postgres 16 runs in a
  container: `sudo docker run -d --name aegis-pg -e POSTGRES_USER=aegis
  -e POSTGRES_PASSWORD=aegis_test_pw -e POSTGRES_DB=aegis -p 5432:5432 postgres:16-alpine`.
- `AEGIS_MASTER_KEY` must decode to **exactly 32 bytes**. `openssl rand -base64 48` gives 48
  and the app 500s at request time with "must decode to exactly 32 bytes". Use
  `openssl rand -base64 32`.
- Web app boots with `npx next dev -p 12000 -H 0.0.0.0` from `apps/web`, with a gitignored
  `apps/web/.env.local` holding `DATABASE_URL` + `AEGIS_MASTER_KEY`. Port 12000 is the exposed
  `work-1` host.
- Owner account is created once via `POST /api/auth/setup` (refuses if an owner exists);
  password min 12 chars. Login sets the `Secure` `aegis_session` cookie — over plain HTTP curl
  must manage the cookie jar explicitly.
- `npm run migrate` builds and runs `dist/migrate.mjs` (needs `pg`; it is external to the bundle).
- `npx tsx` is not installed; use `npm run migrate`.
- **The web app inlines `@qweek/core`.** After any core change you must rebuild
  core *and* web (`NODE_ENV=production npm run build -w @qweek/web`) and restart
  `next start`, or you get stale-bundle bugs. Build web with `NODE_ENV=production`
  — the sandbox's global `NODE_ENV=development` breaks `next build`.

## Test-run shape (this sandbox)
- `npm run verify` = typecheck (all workspaces) + `vitest run`. 121 tests / 7 files.
- Without `TEST_DATABASE_URL`, the DB-integration files skip; that skip is the
  honest "no database" skip, not a failure.

## Session 2026-10-29 (later) — mobile push notifications (see log)
- Real Web Push shipped: `web_push` adapter (VAPID from vault), `0004_push.sql`,
  `services/push.ts`, `notify()` → `push.send` job. Delivery verified against FCM
  (HTTP 201). Device revocation cascades to push subscriptions.
- Root cause of a "No adapter for web_push" bug: **only the worker bootstraps the
  adapter registry; the web process never did.** Fix = lazy `ensureAdapters()`
  before `getAdapter` in `services/providers.ts` (AGENTS.md invariant 42).
- Mobile quick actions deep-link into the studio with a preset
  (`/studio?preset=…&start=…`); PWA shortcuts match.

## Session 2026-10-29 — QWEEK creator-platform upgrade pass (see 2026-10-29.md)
- Verified `0003_creator_platform.sql` (credit reserve/settle/release, publish
  approval state machine, capability registry, repurposing, Video Studio,
  assistant, rate limiting) and exercised every new surface live.
- Credit model proven: failed/unconfigured runs release their hold and net to
  zero; entitlement gating refuses premium features on the free plan.
- Made the theme preference real: dark/light/system CSS tokens, `ThemeScript`
  pre-paint, `data-reduced-motion`, Appearance control in Settings.
- **Build with `NODE_ENV=production npm run build`** — the sandbox sets
  `NODE_ENV=development` globally and the static export fails otherwise.
- Test suite now 97 tests / 5 files. AGENTS.md invariants 38–40 added.

## Session 2026-10-30 — single-writer engine lock + packaging (see log)
- **Postgres advisory locks are per session.** The engine's leader lock
  (`packages/core/src/db/pool.ts`: `acquireLeaderLock(key)` → token|null,
  `holdsLeaderLock(token)`, `releaseLeaderLock(token)`) must give each acquire its
  OWN connection. Caching one client and short-circuiting lets two engines in one
  process both "hold" it. Enforced in both `tick()` and `manualOrder()`.
- `TradingEngine.init()` re-runs on broker changes; guard re-acquisition with
  `if (this.leader === null)` or it nulls a lock it already holds.
- `TEST_DATABASE_URL` (→ `phirst_test`) must be created and migrated or DB tests
  fail with `relation "orders" does not exist`. `scripts/test-db-setup.sh` does it.
- Suite: 91 tests / 8 files (`npm run verify`); smoke 43/43. Engine runs inside
  `apps/api` deliberately (single writer); `apps/engine` does not exist.
- Added `.env.example`, `infra/systemd/*.service`, `docs/DEPLOYMENT.md`,
  `docs/FINAL_REPORT.md`.
