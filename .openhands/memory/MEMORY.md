# Project memory — WEIN (PHIRST2 engine)

Concise index of durable facts. Detail lives in the daily logs.

## Identity
- Product is **WEIN**. The AI companion is **PHIRST2** (name fixed in
  `packages/ai/src/phirst.ts`). Never reintroduce "PHIRST2" as the product name.
- Owner account is **BAELAY**. Registration is invite-only; `/api/auth/setup` creates the
  owner once and then refuses (unique partial index guarantees a single owner).

## Where the truth lives
- `AGENTS.md` — canonical engineering notes, invariants numbered 1..36. Read first. Add a
  numbered invariant for any safety-relevant change; that is the established habit.
- `README.md` — product overview, getting started, paper/live procedures, how to verify.
- `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`, `docs/FINAL_REPORT.md`.

## Layout
- `packages/core` config, types, indicators, vault, DB repos, risk engine, strategies.
- `packages/brokers` adapter framework; `packages/ai` Gemini + 8 agents + PHIRST2 + moderation.
- `packages/engine` trading loop; `apps/api` HTTP/WS + sessions/roles; `apps/web` Next.js UI.
- `db/migrations` forward-only SQL (0001 base, 0002 platform).

## Build & verify
- `npm run verify` = typecheck all workspaces + `vitest run` (currently 204 tests / 17 files).
- The DB-integration file is skipped without `TEST_DATABASE_URL`; to run it, first
  `DATABASE_URL=$TEST_DATABASE_URL npm run migrate` (the test DB must be at the same schema).
- `NODE_ENV=production npm run build -w @phirst/web` — the sandbox's global
  `NODE_ENV=development` breaks `next build`. The web app **inlines `@phirst/core`**, so a core
  change needs a core+web rebuild and a `next start` restart or you get stale-bundle bugs.
- `scripts/wein-smoke.sh` — 25 end-to-end checks. `SMOKE_RESET=1` truncates platform tables
  first (via `sudo docker exec phirst-pg psql -U phirst -d phirst`) so it is repeatable.

## Sandbox environment (expensive to rediscover)
- Postgres runs in container **`phirst-pg`** (user `phirst`, db `phirst`); Docker socket is
  root-owned, so use `sudo docker ...`.
- Env lives in the repo-root `.env` (gitignored); `apps/web` has no `.env.local`. `next.config`
  proxies `/api/*` to `PHIRST_API_INTERNAL ?? http://localhost:12001`.
- Start: `npm run start:api` (root, tsx) and `npm run start -w @phirst/web` from `apps/web`.
  Logs go to `.run/` (gitignored). Web is served on the exposed `work-1` host (port 12000).
- `PHIRST_MASTER_KEY` must decode to exactly 32 bytes (`openssl rand -base64 32`).
- Login sets a `Secure` `aegis`-style session cookie; over plain HTTP curl must use a cookie jar.

## Correctness habits that bit us
- bash `case` globs do **not** support `\|` alternation — a smoke assertion using it silently
  never matches. Use a plain substring.
- `Chart.tsx` must never fabricate candles: when the feed is down it draws axes plus a
  connection notice and no candles.
- Broker capability reporting must stay honest: `implemented` reflects real adapter code only.

## Session 2026-10-30 (see 2026-10-30.md)
- Rebranded to WEIN; added the platform layer (invite-only auth, roles, community, messaging,
  owner dashboard) and native-style navigation. Commits `21cbe8e`→`14c11db` on `main`.
- Verified live paper trading end-to-end on `R_100`: order → open → settled fill, profit,
  equity update, performance report. Real market data, no simulation of results.
- Invariants 31–36 cover the new safety surface.

## Authorization model (owner vs member)
- The trading surface is owner-only, enforced by `router.owner.*` (`ownerOnly` guard) in
  `apps/api/src/http.ts` — see AGENTS.md invariant 42. Client role checks decide rendering
  only. A member loads `MemberShell`; the owner loads `TradingShell`.
- When adding a member-visible screen, grep its `/api/...` calls against the owner-gated set,
  or the member sees empty panels. Commit `24b7b4f`.

## Session 2026-10-30 (later) — audit found 4 real bugs, all fixed (see log)
- Audit found no dead buttons and honest capability reporting, but four correctness bugs:
- **Emergency stop was not sticky**: `start()` (and pause/stop/setMode) cleared it, so the
  UI Start/Resume silently re-armed trading after an emergency stop. Only `resetEmergency()`
  clears it now; controls refuse during `emergency`. AGENTS.md 46.
- **`maxExposure` was inert**: open fixed-expiry contracts live in `orders`, not `positions`,
  so exposure read 0. Now `currentExposure()` = max(sum orders, sum positions). Invariant 47.
- **`consecutiveLossLimit` was never enforced**: now checked in `settleExpired` via
  `lossStreakBreached()`. Invariant 48.
- **Voice accent unvalidated**: now checked against `ALLOWED_ACCENTS`. Invariant 49.
- Verify: 152 tests green, web prod build clean, `wein-smoke.sh` 58/58, fixes confirmed live.

## Session 2026-10-31 — hardening + dead-button sweep (see 2026-10-31.md)
- **The procedural avatar was invisible since the WEIN rebrand**: the draw loop scaled but
  never recentred the 360-unit figure space, pushing the whole head into the canvas corner.
  Only the halo rendered. Fixed with `translate(-R/2,-R/2)` before `drawFigure`.
- **Floating avatar (z-50) swallowed the "More" tab tap** on every viewport; moved to
  `bottom-[92px]` to clear the 67px tab bar.
- **Gemini failover** now covers 429/5xx (was 404 only) and no longer leaks the raw provider
  body into the UI error.
- Playwright is the way to verify canvas UI here: reuse the `phirst_session` cookie, then
  `canvas.toDataURL` + PIL grid sampling. See the recipe in the daily log.
- Full paper lifecycle proven end to end (order → open → settled → engine P&L).
- Suite now 172 tests / 15 files. AGENTS.md invariants 50–53 added.

## Session 2026-10-31 (later) — Deriv OAuth 2.0 one-tap connect (see log)
- "Connect Deriv" now uses Authorization Code + PKCE, not manual PAT entry.
  `packages/brokers/src/deriv-oauth.ts`; state stored single-use in `oauth_states`; the
  `code_verifier` is encrypted server-side and never reaches the browser.
- Deriv issues **no refresh token**; expiry is tracked from `expires_in` and surfaced as
  `expired`. OAuth tokens omit the `Deriv-App-ID` header (that is PAT-only).
- Connecting never silently replaces the active account; it claims an empty slot, prefers
  demo, and requires confirmation (`409`) to switch while exposure is open.
- Fixed a `credentials_enc` leak: broker responses now go through `toPublicBroker`.
- Suite 204 tests / 17 files. AGENTS.md invariants 54–60.
- Awaiting `DERIV_OAUTH_CLIENT_ID` + `DERIV_OAUTH_REDIRECT_URI` in the Deriv dashboard; the
  button reports "setup needed" until then rather than pretending to work.
