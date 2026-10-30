# PHIRST2 final report

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
- **AI companion.** PHIRST2 avatar with lip-sync, push-to-talk and text chat, voice settings,
  proactive alerts, secure editable/deletable memory.
- **Reporting.** Performance report, trade history, equity curve, per-strategy P&L.
- **Controls.** Start, pause, resume, stop, emergency stop (persistent), strategy selection,
  Telegram remote control with permission checks.

## Verification performed

| Check | Result |
| --- | --- |
| `npm run verify` (typecheck + unit) | 91 tests, 8 files, all pass |
| `npm run smoke` against the running API | 43 checks, all pass |
| Database integration tests | 3 pass against a real PostgreSQL (`TEST_DATABASE_URL`) |
| Settlement end to end | Order placed, expired, settled, realised P&L booked, equity updated |
| Engine end to end | 133 signals observed, exactly one order placed (no stacking), live Deriv feed |
| Leader lock | A second engine instance is refused; it cannot place a duplicate order |

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
