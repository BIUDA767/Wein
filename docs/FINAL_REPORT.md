# WEIN final report

Product: WEIN (formerly PHIRST2). The AI companion is named PHIRST2.

Owner: BAELAY. Status: paper-trading ready, live trading not yet enabled.

This report states what is real, what is verified, and what still needs credentials. It does not
claim profitability and does not hide limitations.

## Architecture

pnpm workspace, TypeScript throughout, one PostgreSQL database.

| Package / app | Role |
| --- | --- |
| `packages/core` | Types, config, AES-256-GCM vault, risk engine, indicators, strategies, DB repositories |
| `packages/brokers` | Broker adapters and the provider catalog |
| `packages/ai` | Gemini client, multi-agent panel, proactive alerts |
| `packages/engine` | Trading engine: market data, execution, settlement, reconciliation |
| `apps/api` | REST + WebSocket API, hosts the engine, Telegram bot |
| `apps/web` | Next.js 15 luxury trading UI |

The engine runs inside the backend process. That is deliberate: a single process owns order
placement, and a PostgreSQL advisory lock refuses a second engine instance. The frontend holds
no trading state and cannot place an order by itself.

## Features implemented and tested

- **Authentication.** Owner account via `POST /api/auth/setup`, session cookies, session purge.
- **Broker connections.** Connect, verify, select active broker and account. Credentials are
  encrypted at rest (AES-256-GCM) and never returned to the client.
- **Market data and charts.** Live price stream, TradingView-style candles, EMA/SMA/BB/RSI.
- **Trading.** Manual buy/sell with duration, fixed-expiry contracts, autonomous strategy
  trading, one-position-per-direction guard.
- **Risk engine.** Risk per trade, daily loss limit, max drawdown, max exposure, max concurrent
  trades, consecutive-loss de-risking, allowed instruments and strategies. Final veto on every
  order. No martingale anywhere.
- **Settlement.** Fixed-expiry contracts settle on expiry, realise P&L, and update equity.
- **Paper durability.** The paper simulator holds its balance and open contracts in memory,
  so it is rebuilt from the database on every start: realized profit from settled orders, open
  contracts from open orders. A restart no longer resets the balance or orphans an open
  contract. Settlement also runs on the heartbeat, so an order placed while the engine is
  stopped still expires and resolves.
- **Connectivity resilience.** While running, the engine re-verifies the broker connection.
  On a loss it blocks new trades and raises a critical alert; open contracts still settle once
  the broker is reachable again. On recovery it reconciles real positions and pending orders
  before resuming, and never resubmits an order whose outcome was uncertain.
- **AI companion.** PHIRST2 avatar with lip-sync, push-to-talk and text chat, voice settings,
  proactive alerts, secure editable/deletable memory.
- **Reporting.** Performance report, trade history, equity curve, per-strategy P&L.
- **Controls.** Start, pause, resume, stop, emergency stop (persistent), strategy selection,
  Telegram remote control with permission checks.

## Verification performed

| Check | Result |
| --- | --- |
| `npm run verify` (typecheck + unit) | 93 tests, 9 files, all pass |
| `npm run smoke` against the running API | 43 checks, all pass |
| Database integration tests | 3 pass against a real PostgreSQL (`TEST_DATABASE_URL`) |
| Settlement end to end | Order placed, expired, settled, realised P&L booked, equity updated |
| Engine end to end | 133 signals observed, exactly one order placed (no stacking), live Deriv feed |
| Leader lock | A second engine instance is refused; it cannot place a duplicate order |
| Connectivity loss and recovery | A simulated broker outage blocks new trades and alerts BAELAY; recovery reconciles before resuming |

Three real production bugs were found and fixed during verification:

1. **Retired LLM model.** `gemini-2.5-flash` returned HTTP 404. Added an ordered fallback chain;
   the default is now `gemini-3.5-flash`.
2. **Stale zero equity.** A stopped engine reported equity 0. Account state now refreshes on a
   slow heartbeat even when stopped.
3. **Settlement never matched.** `listOpenOrders` was typed as a camelCase record but returned raw
   snake_case rows, so `brokerOrderId` was always `undefined` and no contract could settle. Rows
   are now mapped at the repository boundary (`mapOrderRow`). This was the most serious defect:
   it silently made every realised result invisible.

## Broker integrations

| Provider | Asset classes | Status |
| --- | --- | --- |
| Deriv | synthetic, forex, crypto, indices, commodities | **Implemented.** 5-second expiry supported. Needs a PAT + registered app id to trade. |
| Paper | all listed | **Implemented.** Internal simulator on live market data. No order reaches a provider. |
| OANDA | forex, commodities, indices | Catalogued, not implemented. Needs account id + token. |
| Binance | crypto | Catalogued, not implemented. Needs API key + secret. |
| Alpaca | stocks, crypto | Catalogued, not implemented. Needs API key + secret. |
| Interactive Brokers | stocks, forex, commodities, indices | Catalogued, not implemented. Needs a running IB Gateway. |

Catalogued providers are shown in the UI with what they require, and selecting one will not
pretend to work. Only Deriv and Paper have working adapters. Five-second execution is enabled
only where the provider genuinely supports it (Deriv and Paper); it is not claimed for others.

## Awaiting credentials or subscriptions

- **Deriv trading** (as opposed to market data): a Personal Access Token and an app id registered
  on the Deriv dashboard.
- **Gemini**: `GEMINI_API_KEY`. Without it the companion reports measured facts only and does not
  invent analysis.
- **Telegram**: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_CHAT_IDS`.
- **Other brokers**: their adapters are not written; each needs the credentials listed above and
  an implementation pass.

## Known limitations

- Live trading has not been enabled or verified against a real-money account.
- The AI companion runs on Gemini only; no other provider is wired in.
- The avatar is an animated vector figure with speech-synchronised mouth movement, not a photoreal
  rendered human.
- Stocks, ETFs, indices, and commodity adapters beyond Deriv are not implemented.

## Paper-trading instructions

1. Start the backend and frontend (`docs/DEPLOYMENT.md`).
2. `POST /api/auth/setup` once to create the owner account, then sign in.
3. Connect the **Paper** broker. It uses the real public Deriv market-data feed.
4. Set risk limits, choose a strategy, and press Start. The engine trades paper contracts.
5. Watch orders settle in Trade History; realised P&L flows to the performance report.

## Live-trading activation procedure

Live trading is never automatic. To enable it:

1. Connect a real-money broker account and confirm `verifyConnection` passes.
2. Confirm the adapter reports `liveAccounts: true`.
3. `POST /api/engine/mode` with `mode: "live"` **and** the exact confirmation phrase
   `ENABLE LIVE TRADING`.
4. The engine stops on the mode change and stays stopped; start it deliberately.

Before doing so, verify broker permissions, a test order, position reconciliation, risk
enforcement, and the emergency stop against that account. Until then, treat paper mode as the
only verified path.

## Security configuration

- Secrets come only from the environment; nothing is hardcoded.
- Broker credentials are stored as AES-256-GCM ciphertext and never returned to a client.
- The master key must decode to exactly 32 bytes; the app refuses to start otherwise.
- Telegram commands are authenticated and permission-checked per chat.
- Broker secrets are never written to AI memory.
- Every order, mode change, and emergency stop is written to an append-only audit log.

## WEIN interface, companion and personalisation (added this session)

**Rebrand.** The application is WEIN. PHIRST2 is the companion. Titles, the manifest, the
sign-in screen and the header all read WEIN; the companion identity string is unchanged.

**Launch sequence.** A one-time, skippable canvas animation: an ensō brush circle is drawn in
one stroke, the WEIN wordmark resolves from it, and the mark contracts toward the companion's
corner before handing over. It runs once per session and is skipped entirely under
`prefers-reduced-motion`.

**Sound identity.** Synthesised with the Web Audio API — no asset files. A Japanese pentatonic
palette (launch figure, tap, confirm, reject, alert, critical, listen). Audio starts only on a
real user gesture and can be muted or have its volume set in Appearance.

**PHIRST2 avatar.** A Japanese-inspired male digital human drawn procedurally on a canvas every
frame: layered skin shading, jaw and temple volume, iris depth with a limbal ring and
catchlights, eyelids that close on blink, a tapered nose from shading rather than outline, and
a swept hair mass with a champagne ornament. Blinks, saccades, breathing, head sway and a
speaking nod are all functions of elapsed time and real state. The mouth follows a viseme
timeline re-anchored on the speech engine's own word-boundary events.

*Honest limit:* this is a stylised real-time render, not a photoreal capture, and lip-sync is
text-and-timing driven because browsers expose no raw audio for synthesised speech. An
avatar service was ruled out by budget; this is the realistic ceiling without one.

**Personalisation (Appearance panel).** Chart style (candles, hollow, line, area), grid lines,
chart height, indicators shown on load, selectable timeframes, dashboard tiles, trade defaults,
sound on/off and volume, and a reduce-motion toggle. Every control changes real behaviour and
is persisted server-side under `ui_preferences`; invalid values are rejected, not silently
accepted.

**Security.** Added an owner password-change flow (current password required; all other
sessions revoked, the current one kept) with a working form in Security & memory. Added a PWA
manifest and a generated app icon so WEIN installs to the iPhone home screen. Page zoom is no
longer disabled.

**Verification.** 105 unit tests across 10 files pass. Smoke suite now 49/49, covering
preferences load/update/persistence/rejection and password-change validation. Live checks:
preferences round-trip through the public host, and a full password change and revert
(21 stale sessions revoked on the first change).
