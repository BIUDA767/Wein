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
- `npm run verify` = typecheck all workspaces + `vitest run` (currently 114 tests / 11 files).
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
