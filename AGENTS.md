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

37. Trading authority is a separate axis from paper/live. `TradeMode` (paper|live) says
    *where* an order goes; `TradingMode` (manual|approval|autonomous) says *how much the bot
    may do alone*. The two must never be collapsed into one setting. In `manual` no
    autonomous order is ever placed; in `approval` the engine records a `trade_proposals`
    row and places nothing until the owner approves it; in `autonomous` it executes inside
    the risk limits. The mode is persisted under `app_settings.tradingMode` and re-read on
    start, so a restart never widens authority on its own.
38. Changing trading authority is refused while the engine is running, so no order is caught
    mid-flight. Leaving `approval` expires every pending proposal with an audit reason, so a
    stale decision can never execute later under a narrower or wider mode.
39. A proposal is claimed exactly once. `claimProposal` flips `pending` to `approved`
    atomically; a second claim returns null, so a double-tap or a retried request cannot
    place two orders. A partial unique index allows at most one pending proposal per symbol
    and side, so the loop cannot bury the owner in duplicates.
40. The independent validator (`packages/core/src/risk/validator.ts`) is a second, pure and
    synchronous opinion layered on top of the risk engine, not a replacement for it. It can
    allow, escalate to a proposal, or block a trade. The risk engine still holds final veto;
    the validator can only narrow what executes, never widen it.
41. The engine never fabricates activity to look busy. In autonomous mode it opens a trade
    only when a real strategy signal, the risk engine and the validator all agree. A flat
    market correctly produces no order.
42. The trading surface is owner-only, enforced at the router, not the client. Every
    `/api/engine/*` route, the account reads (`orders`, `positions`, `equity`, `risk`,
    `strategies`, `reports`, `notifications`, `equity`), and the broker, AI-memory,
    verdict and Telegram control routes carry `ownerOnly`. A member who calls them gets
    `403 Owner permission required`; the client role check only decides what to render and
    is never the enforcement point. A member therefore loads `MemberShell` (community,
    messages, support, own profile) and never receives an engine snapshot, so no member
    screen can show the owner's figures or offer a control it cannot use.
43. Notifications fan out from one choke point. `insertNotification` in
    `packages/core/src/db/repo.ts` is the single place every engine event is persisted, so
    the API registers a sink there (`setNotificationSink`) that forwards to Telegram. A new
    notification is delivered without each call site remembering to forward it, delivery is
    best-effort so a channel failure cannot break the trade path, and only `critical` /
    `warning` / `phirst2` events are forwarded so the chat stays signal rather than noise.
44. The bot token is read from the environment only and never logged, committed or echoed.
    Telegram delivery targets the owner's `TELEGRAM_ALLOWED_CHAT_IDS` plus linked chats that
    hold the `read` permission; a chat must complete the `/start <code>` link before it can
    receive or command anything.

45. A Telegram link code is bound to the authenticated owner's real `users.id`. A
    placeholder such as the literal string `"owner"` satisfies nothing: `telegram_links`
    has a foreign key to `users(id)`, so the link insert fails and the chat stays
    unlinked. The `/start` handler catches that failure, records it and tells the chat,
    rather than leaving the member to guess why `/start` did not work.

46. The emergency stop is sticky. It is cleared only by `resetEmergency()`. `start()`,
    `resume()`, `pause()`, `stop()` and `setMode()` all refuse while the engine is in the
    `emergency` state, so no ordinary control can silently re-arm trading after a stop.
    Telegram `/pause` and `/stop` report the engine's actual reply, not a fixed "done".
47. Open exposure counts open fixed-expiry contracts, which live in `orders`, not the
    `positions` table (empty for these contracts). `currentExposure` takes the larger of
    the open-order total and the position total — never their sum, which would double-count
    a mirrored position and order. A position-only figure would leave `maxExposure` inert.
48. `consecutiveLossLimit` is enforced. `settleExpired` re-checks the streak after any
    settlement and pauses when it reaches the limit. The risk engine separately de-risks
    each trade after a loss; this is the hard stop, and it never resumes on its own.
49. The voice accent is validated against `ALLOWED_ACCENTS` in `@phirst/ai`, the same list
    the client offers, so a hand-crafted request cannot persist an accent the app cannot speak.
50. Provider back-pressure is never masked by a cache. When a market-data provider has spent
    its budget or returns 429, `TwelveDataProvider` throws `ProviderBackpressureError` and the
    cache fallback is skipped, so a stale quote can never be presented as live. The service
    matches this condition by type (`instanceof`), not by message text.
51. The LLM client fails over on transient provider faults as well as retired models. A 404
    (retired model), 429 (quota) or 5xx (capacity) moves to the next model in the chain;
    400/403 stops, because every model would reject the same request or credential. The
    provider's raw error body is logged but never surfaced in a user-facing error string.
52. The floating PHIRST2 avatar sits above the tab bar (bottom offset), because it is a
    fixed element at `z-50` and would otherwise intercept taps meant for the rightmost tab.
53. The procedural avatar draws its figure in a 360-unit space centred on (180,180) and the
    draw loop recentres by `-R/2` after scaling, so the head is centred and head sway pivots
    about the middle. Omitting the recentre pushes the whole figure into the canvas corner.
54. Deriv OAuth 2.0 (one-tap connect) is Authorization Code with PKCE (S256). The
    `code_verifier` never leaves the server: it is encrypted into `oauth_states` before the
    browser is redirected, and the token exchange happens only in the API process. The
    browser receives a redirect carrying a short status word, never a token.
55. An OAuth `state` is single-use. `consumeOAuthState` marks it consumed in the same
    `UPDATE ... RETURNING` that reads it, so two concurrent callbacks cannot both exchange
    the same authorization code. Unknown, replayed and expired states are refused identically.
56. OAuth access tokens are sent without the `Deriv-App-ID` header; that header is for
    Personal Access Tokens only. An OAuth 401 means the token expired, which is a
    reconnect condition, not a bad-credential one, so it is not retried.
57. Deriv issues no refresh token. The access token's `expires_in` is recorded at connect
    time and a passed expiry is reported as `expired` before any API call fails, rather than
    discovering it on the next order.
58. Connecting a broker never silently replaces the active trading account. Selection only
    claims the active slot when it is empty, and a manual switch while open orders or pending
    proposals exist requires an explicit confirmation (`409` with `requiresConfirmation`).
59. `credentials_enc` never leaves the server. Responses use `toPublicBroker`, so even the
    ciphertext is absent from broker, health and diagnostic payloads.
60. A connection is recorded as `connected` only after `verifyConnection` succeeds against
    the provider. A token that fails verification is stored but marked `error`, and the UI
    says so instead of showing a false success.

61. The header balance is the figure the broker reported for the *selected* account, in that
    account's own currency. A missing selection, a failed fetch and a genuine zero are three
    distinct states — the first two render as "—"/an error string, never as `0.00`, so a
    failed fetch can never be mistaken for an empty account.
62. Price alerts are evaluated against a live quote and fire exactly once; firing records the
    crossing price in the notification feed and sets `triggeredAt`. An alert is never marked
    fired from a cached or invented price, and a symbol the provider cannot quote leaves the
    alert armed rather than firing it.
63. Switching the active account while open orders or pending proposals exist requires an
    explicit confirmation (`409 requiresConfirmation`), mirroring the broker-connect rule
    (invariant 58). The confirmation is enforced server-side; the sheet's "Confirm" button
    only re-sends the same request with `confirm: true`.
64. The chart renders only candles the API returned. When the feed is disconnected it draws
    axes and a connection notice and no price series — it never synthesises candles to keep
    the panel looking alive.
65. Deriv serialises every money field (balance, fill price, payout, profit) as a decimal
    *string*. The adapter coerces through `toNumber` and never falls back to `0` for a
    missing value, so a settled loss and an unknown result stay distinguishable.
66. The authenticated trading socket comes from the OTP endpoint's `data.url`
    (`resolveTradingWsUrl`), not `ws_url`/`wsUrl`. Reading the wrong field left the socket
    closed and silently blocked every live order.
67. A Deriv order names the instrument `underlying_symbol`; `symbol` is rejected outright.
68. Deriv offers tick expiries only up to 10 ticks, and intraday expiries from 15s. The
    adapter measures each symbol's real tick interval from Deriv's own tick history and
    sends ticks inside the ceiling or a seconds contract beyond it. The expiry the provider
    actually accepted is written back to the order (`ExecutionResult.effectiveDurationSec`),
    so the UI never shows a duration that was not placed.
69. The paper simulator's market feed is the public Deriv socket and needs no app id; the
    adapter is built without one rather than falling back to a placeholder id.
