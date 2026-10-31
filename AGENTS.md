# AGENTS.md - PHIRST2

PHIRST2 is a real, multi-broker autonomous trading platform. Owner account: BAELAY.

This file is the canonical engineering-notes file. Add a numbered invariant for every
safety-relevant change. Invariants are load-bearing: do not remove one without replacing
the behaviour it protects.

## Layout

- `packages/core` - config, logger, domain types, indicators, crypto vault, DB pool + repos,
  risk engine, strategy registry. Pure logic lives here so it is unit-testable.
- `packages/brokers` - adapter framework and provider adapters. One adapter per provider.
- `packages/ai` - Gemini client, the eight analysis agents, PHIRST2 persona and memory.
- `packages/engine` - the trading engine loop: risk veto, execution, reconciliation.
- `apps/api` - HTTP + WebSocket API, session auth, market data proxy, Telegram.
- `apps/web` - Next.js luxury iPhone trading UI.
- `db/migrations` - forward-only SQL migrations.
- `infra` - systemd units, backup and health scripts.

## Build & test

- `npm run migrate` - apply `db/migrations/*.sql` in order.
- `npm run verify` - typecheck (all workspaces) + `vitest run`.
- `npm run test` - unit/integration tests. DB tests skip when `TEST_DATABASE_URL` is unset.
- `npx esbuild <file> --outfile=/dev/null` - fast per-file syntax gate while iterating.

## Invariants

1. Secrets never appear in source. Everything sensitive is read from the environment
   and broker credentials are stored only as AES-256-GCM ciphertext.
2. `PHIRST_MASTER_KEY` must decode to exactly 32 bytes. Generate with `openssl rand -base64 32`.
3. Every broker adapter reports real capabilities. Never claim a feature (for example
   5-second expiry) unless the provider API genuinely supports it.
4. The risk engine has final veto authority over every order, manual or automatic.
5. Size is never increased to recover losses. There is no martingale anywhere in the codebase.
6. The engine never switches from paper to live on its own. Live trading requires an explicit
   user action and a confirmation phrase.
7. After an uncertain execution response the engine reconciles with the broker; it never
   blindly resubmits an order.
8. The emergency stop is persistent and is checked before every order.
9. The frontend never fabricates prices, balances, trades or AI activity. Every number is
   sourced from the database or a live provider stream.
10. LLM-generated content is labelled as opinion; measured facts are labelled separately.
11. Broker secrets are never written to AI memory.
12. Database rows are mapped to domain types at the repository boundary. PostgreSQL returns
    snake_case columns and numeric values as strings; a raw row must never be cast to a
    camelCase interface (see `mapOrderRow`). A silent `undefined` here once made order
    settlement impossible, because `brokerOrderId` never matched.
13. A stopped or paused engine still reports the real account balance. Account state is
    refreshed on a slow heartbeat, so the UI and the companion never repeat a stale zero.
14. Provider rate limits are expected conditions, not faults. Market-data reads back off,
    serve cached candles, and never count toward the consecutive-failure pause.
15. The engine never stacks a second position in the same direction while an equivalent
    one is open.
16. The configured LLM model name is treated as a hint, not a guarantee. A retired model
    falls through an ordered fallback chain, and if none answer the companion reports
    measured facts only rather than inventing analysis.
17. Exactly one process may place orders. The engine takes a PostgreSQL advisory lock
    (`acquireLeaderLock`) before trading and releases it on shutdown. Both the autonomous
    tick and manual orders check `holdsLeaderLock(token)`. PostgreSQL advisory locks are
    per session, so each acquisition must use its own connection; a cached client would
    let two engines in one process both appear to hold the lock.
18. `TradingEngine.init()` also runs when the broker set changes, so leader-lock
    acquisition is guarded by `if (this.leader === null)`. Re-acquiring against a lock the
    process already holds fails and would null a live lock.
19. Integration tests run against a dedicated database (`TEST_DATABASE_URL`, `phirst_test`)
    and skip honestly when it is unset. `scripts/test-db-setup.sh` creates and migrates it.
20. The engine re-verifies broker connectivity on a throttled interval while running. A lost
    connection blocks new orders and raises a critical alert, but settlement continues so open
    contracts still resolve. On recovery the engine reconciles positions and pending orders
    before resuming; it never resubmits an order with an uncertain outcome.
21. Backups are written to a temporary name and renamed only after `pg_dump` exits cleanly, then
    verified with `gzip -t`. A partial dump must never be mistaken for a good one. A backup that
    has not been restored is not a backup; verify a restore before trusting one.
22. Paper-trading state is durable. The simulator holds balance and open contracts in memory
    only, so `BrokerManager` rebuilds it from the database on every adapter construction
    (`paperRestoreState`): realized profit from settled orders, open contracts from open
    orders. The live balance is starting balance + realized profit - stake still tied up in
    open contracts. Without this a restart reset the balance and orphaned open contracts,
    which could then never settle.
23. An unknown contract is not a settled contract. `getOrder` returns `null` for a contract
    the simulator does not know, so callers treat it as unresolved rather than a silent win.
24. Settlement runs on the heartbeat as well as the tick, because a manual order can be placed
    while the engine is stopped and an expired contract must still resolve.
25. The product is branded WEIN. PHIRST2 is the name of the AI companion only. Do not
    reintroduce PHIRST2 as the application name in titles, headers, the manifest or the
    sign-in screen; the identity string lives in `packages/ai/src/phirst.ts`.
26. The avatar is drawn procedurally on a canvas, not loaded as an image or video. Lip-sync
    is driven by the viseme timeline in `apps/web/src/lib/visemes.ts`, which is re-anchored
    on the speech engine's real `boundary` events. Browsers expose no raw audio for
    synthesised speech, so synchronisation is text-and-timing based; do not describe it as
    spectral or phoneme-accurate.
27. The sound identity is synthesised with the Web Audio API and has no asset files. Audio
    can only start inside a user gesture, so `sound.unlock()` runs on the first pointer or
    key event and every cue is a no-op until then. Never autoplay on load.
28. User interface preferences are real settings stored under the `app_settings` key
    `ui_preferences`. `normalisePreferences` rejects unknown values rather than substituting
    defaults, and the client applies saved preferences optimistically, reverting on a
    server refusal. A preference that does not change behaviour is a bug, not a decoration.
29. Five-second expiry is offered only when the active broker's capabilities report
    `supportsFiveSecond`. The order sheet reads capabilities from `/api/brokers`; it must
    never present a duration the adapter cannot honour.
30. Password changes require the current password and revoke every other session
    (`deleteOtherSessions`), keeping the session that made the change. A session alone must
    not be enough to lock the owner out.

31. Registration is invite-only. `/api/auth/setup` creates the owner once and refuses
    afterwards; every other account is created only by `/api/auth/register` with a valid,
    unused, unrevoked, unexpired invite. The unique partial index
    `users_single_owner_idx ON users(role) WHERE role='owner'` makes a second owner
    impossible at the database level, so ownership cannot be reassigned through any route.
32. Role authorisation is enforced in the router, not the handler. `ownerOnly` and
    `moderatorOnly` are checked in `Router.dispatch` before the handler runs, so a new
    route cannot forget its role check. The client only decides what to render; it never
    decides what it is allowed to do.
33. Live trading has two independent gates. Per account: the engine requires the exact
    confirmation phrase and the broker to report a real-money capability. Platform wide:
    the owner's `liveTradingEnabled` flag. The engine refuses a live order when either
    gate is closed, checked again at order time in `tick` and `manualOrder`, not only at
    mode change.
34. PHIRST2 automated moderation is deterministic and local, never an LLM call, so a
    moderation decision cannot be skipped when the model is unreachable. It returns the
    matched phrases as evidence, the caller records the action in `moderation_actions`,
    and every automated action is reversible by the owner. A blocked post is never stored.
35. Community and messaging responses expose only username, display name, avatar seed,
    role and the content the member chose to publish. Balances, broker identifiers,
    credentials and private positions never appear in a community payload.
36. A suspended member is treated as unauthenticated. `Router.authenticate` returns null
    for a suspended account, so every authenticated route refuses it without each handler
    repeating the check.
