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
- Real Web Push: `web_push` adapter (VAPID from vault), `services/push.ts`, `notify()`
  → `push.send`. Device revocation cascades to subscriptions. Root cause of a
  "No adapter for web_push" bug: **only the worker bootstrapped the adapter registry**;
  fix = lazy `ensureAdapters()` before `getAdapter` (AGENTS.md invariant 42).
- Mobile quick actions deep-link into the studio (`/studio?preset=…&start=…`).

## Session 2026-10-30 (later) — WEIN rebrand + realistic avatar (commit 306320f)
- **Product is WEIN; PHIRST2 is the companion only.** App chrome/titles/manifest/auth/logs =
  WEIN; anything the assistant "speaks" (avatar label, chat sheet, "Ask PHIRST2",
  "PHIRST2 settings/memory") stays PHIRST2. Never blind-sed. Identity string in
  `packages/ai/src/phirst.ts`.
- Avatar is **procedural canvas** (no paid service, no assets), lip-sync from
  `apps/web/src/lib/visemes.ts` re-anchored on real speech `boundary` events — text+timing,
  not spectral. Sound identity is Web Audio, gesture-gated (`sound.unlock()`).
- Personalisation is real: `GET/PUT /api/preferences` (`app_settings.ui_preferences`);
  `normalisePreferences` rejects unknown values. Change-password endpoint revokes other
  sessions, keeps the caller's.
- **Restart discipline:** web needs `NODE_ENV=production npx next build` + `next start`
  restart; API runs under `tsx` but still needs a restart for new routes. `EADDRINUSE` =
  already running, not a failure.
- Test shape now **105 tests / 10 files**; smoke **49/49**. Gemini free tier is 429 →
  chat honestly falls back to measured facts (`source:"fallback"`).
