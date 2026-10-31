# WEIN repository audit

Date: 2026-10-31. This is the Phase 1 audit required before any change.

## What already exists and works

| Area | State | Notes |
| --- | --- | --- |
| `packages/core` | Working | Config, logger, domain types, indicators, AES-256-GCM vault, DB pool + repositories, risk engine, strategy registry. |
| `packages/brokers` | Working | Adapter framework, `paper` simulator, `deriv` adapter, provider capability catalog. |
| `packages/ai` | Working | Gemini client with model fallback, eight analysis agents, PHIRST2 persona, memory. |
| `packages/engine` | Working | Trading loop, risk veto, execution, reconciliation, leader lock, durable paper state. |
| `apps/api` | Working | HTTP API, session auth, market-data proxy, Telegram bot. 64 routes. |
| `apps/web` | Working | Next.js app shell, canvas chart, procedural avatar, voice, panels, sheets. |
| `db/migrations` | Working | 19 tables. |
| `infra` | Working | systemd units, backup and health scripts. |
| Tests | Working | 105 tests / 10 files; smoke suite 49 checks. |

## Branding

No `QX`, `QuMatix` or `QuMatic` strings exist anywhere in the code, SQL, CSS or config.
The only occurrences were stale notes in `.openhands/memory/MEMORY.md` referring to an
older package name; those have been corrected. The application is branded WEIN and the
companion is PHIRST2 (see `AGENTS.md` invariant 25).

## Demo / fabricated data

The product contains no fabricated financial data. A deliberate search for
`mock|fake|sample|demo|dummy|hardcoded|simulat` found only:

- **Deriv demo accounts** — a real broker feature. `classifyAccount` reads the provider's
  own `is_virtual` flag. This is genuine account data, not fabricated.
- **The `paper` provider** — an internal simulator that is *not* the default, is labelled
  "Paper Trading", and uses **live market data** for fills and settlement. It reports its
  capability notes honestly ("No orders reach a provider").
- **Form `placeholder` attributes** — HTML input hints, not data.
- **`sampleViseme` / `sampleRate`** — audio sampling terminology, unrelated.

The chart renders only candles returned by the API; with no data it draws
"Waiting for market data…". Balances come from the adapter's `getBalance`. Orders are
written from the broker's response. Invariant 9 in `AGENTS.md` already forbids the
frontend from fabricating values.

## Gaps against the master prompt

These are real and are the work of this build:

1. **Single user.** Only one owner account exists (`BAELAY`). No invite-only registration,
   no roles, no per-user broker connections.
2. **No community.** Feed, posts, comments, reactions, private messaging and moderation
   (Phase 5) do not exist.
3. **No owner administration dashboard** and no broker-catalog management for the owner.
4. **Screen set incomplete.** One shell with `trade | positions | history` tabs. Missing:
   Onboarding, Assets, Discover, Community, Messaging, Notifications, Support, Profile,
   owner admin.
5. **Navigation** is a segmented control, not a native bottom tab bar
   (Trade / Positions / Discover / Assets / More).
6. **Chart** lacks: disconnected empty state with visible grid/axes, zoom and pan,
   drawing toolbar, trade entry/exit markers, PHIRST2 signal markers, MACD, Stochastic
   and CCI, and the 30m/1D timeframes.
7. **Top bar** does not yet match the reference: no user avatar, no balance hide/reveal
   eye, no ワイン under the gold logo, no PHIRST2 avatar with waveform.
8. **AI fallback** is Gemini only. The prompt asks for OpenAI then Anthropic as fallbacks.
9. **Execution** supports fixed-expiry contracts only. Spot, futures and forex/CFD order
   types are not implemented.
10. **No mobile packaging** (Capacitor) and no private distribution portal.
11. **Design tokens** differ from the specified palette (the prompt asks for
    `#0A0A0B`/`#1C1C1F`/`#00C853`/`#FF3B30`/`#D4AF37`; the code uses a graphite/emerald set).
12. **No README** beyond the one-line `# Wein`.

## Verified baseline

- `npm run typecheck` — clean.
- `npm test` — 105 passed (10 files) with Postgres running.
- Infrastructure: Postgres 16 in Docker, migrations applied, seed applied.

## Approach

Preserve everything that works. The engine, risk engine, vault, broker adapters and
API are sound and are not rewritten. Work proceeds in the prompt's phase order,
committing a working increment per phase.
