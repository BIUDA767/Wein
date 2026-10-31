import type { BrokerAccount, Candle, Instrument, OrderStatus, Quote, TradeIntent } from "@phirst/core";
import { WsClient } from "../ws-client.ts";
import {
  BrokerError,
  type BrokerAdapter,
  type BrokerCapabilities,
  type BrokerCredentials,
  type BrokerPosition,
  type ConnectionCheck,
  type ExecutionResult,
} from "../types.ts";

const REST_BASE = "https://api.derivws.com";
const PUBLIC_WS = "wss://api.derivws.com/trading/v1/options/ws/public";

interface DerivAccount {
  account_id?: string;
  account_type?: string;
  type?: string;
  currency?: string;
  /** Deriv returns this as a decimal string (e.g. "10000.00"), not a JSON number. */
  balance?: number | string;
  loginid?: string;
  is_virtual?: boolean | number;
  status?: string;
}

/** Deriv serialises money as a string; coerce without inventing a value for a missing one. */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Deriv's OTP endpoint returns the ready-to-use authenticated socket as `data.url`. The other
 * spellings are accepted defensively, and a bare `otp` is assembled into a URL as a last
 * resort. Reading only `ws_url`/`wsUrl` silently broke every live order, so this is extracted
 * so it can be covered by a test rather than rediscovered in production.
 */
export function resolveTradingWsUrl(
  payload: { data?: unknown } & Record<string, unknown>,
  accountType: "demo" | "real",
): string | null {
  const data = (payload.data ?? payload) as { url?: string; ws_url?: string; wsUrl?: string; otp?: string };
  const direct = data.url ?? data.ws_url ?? data.wsUrl;
  if (direct) return direct;
  if (data.otp) {
    return `wss://api.derivws.com/trading/v1/options/ws/${accountType}?otp=${encodeURIComponent(data.otp)}`;
  }
  return null;
}

function classifyAccount(a: DerivAccount): "demo" | "real" {
  if (typeof a.is_virtual === "boolean") return a.is_virtual ? "demo" : "real";
  if (typeof a.is_virtual === "number") return a.is_virtual ? "demo" : "real";
  const t = (a.account_type ?? a.type ?? "").toLowerCase();
  if (t.includes("demo") || t.includes("virtual")) return "demo";
  if (t.includes("real")) return "real";
  const login = a.loginid ?? a.account_id ?? "";
  if (/^(VRTC|VRT|DEMO)/i.test(login)) return "demo";
  return "real";
}

/**
 * Deriv adapter.
 *
 * Market data uses the public WebSocket, which requires no authentication and is
 * therefore always available. Trading uses an authenticated WebSocket whose URL is
 * obtained from the REST OTP endpoint. That endpoint requires a Personal Access Token
 * AND a Deriv-App-ID that has been registered on the Deriv dashboard; without a
 * registered app id the API returns 401 "Invalid application". The adapter surfaces
 * that exact provider error instead of pretending to be connected.
 */
export class DerivAdapter implements BrokerAdapter {
  readonly provider = "deriv";
  readonly displayName = "Deriv (Options)";

  private publicWs: WsClient;
  private tradingWs: WsClient | null = null;
  private accounts: BrokerAccount[] = [];
  private instrumentsCache: Instrument[] | null = null;
  private activeAccountId: string | null = null;
  /** Measured tick interval per symbol, in seconds. Deriv offers tick contracts only. */
  private tickIntervalCache = new Map<string, number>();

  /**
   * Deriv's tick expiry is capped at 10 ticks, so any duration longer than ten ticks must be
   * placed as an intraday contract in seconds (minimum 15s). This fallback is used only if
   * the tick interval cannot be measured, and 2s matches the observed rate for the standard
   * volatility indices.
   */
  private static readonly DEFAULT_TICK_SEC = 2;
  private static readonly MAX_TICK_DURATION = 10;
  private static readonly MIN_INTRADAY_SEC = 15;

  constructor(
    private readonly creds: BrokerCredentials,
    private readonly log: (msg: string, fields?: Record<string, unknown>) => void = () => {},
  ) {
    this.publicWs = new WsClient(() => PUBLIC_WS, "deriv-public", log);
    this.activeAccountId = creds.accountId ?? null;
  }

  capabilities(): BrokerCapabilities {
    return {
      marketData: true,
      marketOrders: false,
      fixedExpiry: true,
      minExpirySec: 5,
      supportsFiveSecond: true,
      positions: true,
      orderCancel: false,
      streaming: true,
      demoAccounts: true,
      liveAccounts: true,
      notes: [
        "Market data is served from Deriv's public WebSocket and needs no authentication.",
        "Trading requires a PAT plus a Deriv-App-ID registered on the Deriv dashboard.",
        "Tick contracts are capped at 10 ticks; longer expiries use intraday contracts with a 15s minimum.",
        "The effective expiry is measured per symbol from Deriv's own tick history, not assumed.",
        "Deriv Options sells fixed-expiry contracts, not conventional market orders.",
        "Contract cancellation is only available for specific contract types via the sell endpoint.",
      ],
    };
  }

  private get appId(): string {
    const id = this.creds.appId;
    if (!id) throw new BrokerError("A Deriv-App-ID is required for authenticated requests", "auth");
    return id;
  }

  /**
   * Deriv requires a `Deriv-App-ID` header for Personal Access Token requests only. An
   * OAuth access token already identifies the application, and sending the header is
   * unnecessary. Omitting it also means an OAuth connection does not depend on a
   * registered app id being configured.
   */
  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.creds.token}`,
      "Content-Type": "application/json",
    };
    if (this.creds.authMethod !== "oauth") headers["Deriv-App-ID"] = this.appId;
    return headers;
  }

  /** A 401 from an OAuth token means the token expired; the owner must reconnect. */
  private static isExpiredOAuth(status: number, authMethod: string | undefined): boolean {
    return status === 401 && authMethod === "oauth";
  }

  /**
   * The symbol's real tick interval in seconds, measured from Deriv's own tick history.
   * Never assumed: if it cannot be measured the standard-index fallback is used, and the
   * caller still clamps the duration to the provider's documented tick ceiling.
   */
  private async tickIntervalSec(symbol: string): Promise<number> {
    const cached = this.tickIntervalCache.get(symbol);
    if (cached) return cached;
    try {
      const res = await this.publicWs.request({ ticks_history: symbol, count: 3, end: "latest", style: "ticks" });
      const times = (res.history as { times?: number[] } | undefined)?.times ?? [];
      if (times.length >= 2) {
        const delta = times[times.length - 1] - times[times.length - 2];
        if (Number.isFinite(delta) && delta > 0) {
          this.tickIntervalCache.set(symbol, delta);
          return delta;
        }
      }
    } catch {
      // Measurement is best-effort; the fallback below keeps the order placeable.
    }
    return DerivAdapter.DEFAULT_TICK_SEC;
  }

  /**
   * Choose the duration unit Deriv actually accepts for the requested number of seconds.
   * Tick contracts are used only when the request fits inside the 10-tick ceiling; anything
   * longer is sent as an intraday contract, and the effective expiry is reported back so the
   * UI never shows a duration the provider did not honour.
   */
  private async resolveDuration(symbol: string, requestedSec: number): Promise<{ unit: "t" | "s"; value: number; effectiveSec: number }> {
    const tickSec = await this.tickIntervalSec(symbol);
    const ticks = Math.round(requestedSec / tickSec);
    if (ticks >= 1 && ticks <= DerivAdapter.MAX_TICK_DURATION) {
      return { unit: "t", value: ticks, effectiveSec: ticks * tickSec };
    }
    return { unit: "s", value: Math.max(DerivAdapter.MIN_INTRADAY_SEC, Math.round(requestedSec)), effectiveSec: Math.max(DerivAdapter.MIN_INTRADAY_SEC, Math.round(requestedSec)) };
  }

  /** Deriv returns HTTP 200 with an `error` object for many failures; surface it loudly. */
  private ensureNoError(res: Record<string, unknown>, context: string): void {
    const err = res.error as { code?: string; message?: string } | undefined;
    if (!err) return;
    const message = `${context} failed: ${err.message ?? err.code ?? "unknown error"}`;
    const code = err.code ?? "";
    const auth = /Authorization|token|Unauthorized|InvalidToken|Invalid application/i.test(`${code} ${err.message ?? ""}`);
    throw new BrokerError(message, auth ? "auth" : /RateLimit/i.test(code) ? "rate_limit" : "rejected");
  }

  private async rest(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const token = this.creds.token;
    if (!token) throw new BrokerError("A Deriv API token is required", "auth");
    const res = await fetch(`${REST_BASE}${path}`, {
      ...init,
      headers: {
        ...this.authHeaders(),
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = { raw: text };
    }
    if (!res.ok) {
      const errs = body.errors as Array<{ code?: string; message?: string }> | undefined;
      const message = errs?.[0]?.message ?? (typeof body.raw === "string" ? body.raw : `HTTP ${res.status}`);
      const code = errs?.[0]?.code ?? "";
      const isAuth = res.status === 401 || res.status === 403 || /Unauthorized|Invalid application/i.test(message);
      // An OAuth token that returns 401 has expired, which is a reauthorise condition, not
      // a bad-credential one. Retrying is pointless; the owner must reconnect.
      const expired = DerivAdapter.isExpiredOAuth(res.status, this.creds.authMethod);
      throw new BrokerError(
        expired
          ? "Deriv authorization has expired. Reconnect the account to continue."
          : `Deriv ${path} failed (${res.status}${code ? " " + code : ""}): ${message}`,
        isAuth ? "auth" : res.status === 429 ? "rate_limit" : "unknown",
        expired ? false : res.status >= 500 || res.status === 429,
      );
    }
    return body;
  }

  async verifyConnection(): Promise<ConnectionCheck> {
    if (!this.creds.token) {
      return {
        ok: false,
        authenticated: false,
        accounts: [],
        message:
          this.creds.authMethod === "oauth"
            ? "This Deriv connection has no access token. Reconnect the account."
            : "No API token configured. Add a Deriv Personal Access Token and a registered Deriv-App-ID.",
      };
    }
    try {
      const accounts = await this.listAccounts();
      return { ok: true, authenticated: true, accounts, message: `Authenticated. ${accounts.length} account(s) available.` };
    } catch (err) {
      const e = err as BrokerError;
      return {
        ok: false,
        authenticated: false,
        accounts: [],
        message:
          this.creds.authMethod === "oauth"
            ? e.message
            : e.code === "auth"
              ? `${e.message} — trading needs a Deriv-App-ID registered on the Deriv dashboard for this token.`
              : e.message,
      };
    }
  }

  async listAccounts(): Promise<BrokerAccount[]> {
    const body = await this.rest("/trading/v1/options/accounts");
    const raw = (body.data ?? body.accounts ?? body) as unknown;
    const list = Array.isArray(raw) ? (raw as DerivAccount[]) : ((raw as { accounts?: DerivAccount[] }).accounts ?? []);
    const accounts: BrokerAccount[] = list.map((a) => ({
      id: String(a.account_id ?? a.loginid ?? ""),
      type: classifyAccount(a),
      currency: a.currency ?? "USD",
      balance: toNumber(a.balance),
      loginid: a.loginid,
      status: a.status ?? null,
      label: `${classifyAccount(a) === "demo" ? "Demo" : "Real"} ${a.currency ?? ""}`.trim(),
    }));
    this.accounts = accounts;
    return accounts;
  }

  async getBalance(accountId: string): Promise<number | null> {
    const accounts = this.accounts.length ? this.accounts : await this.listAccounts();
    const acct = accounts.find((a) => a.id === accountId);
    if (acct && typeof acct.balance === "number") return acct.balance;
    return null;
  }

  async listInstruments(): Promise<Instrument[]> {
    if (this.instrumentsCache) return this.instrumentsCache;
    const res = await this.publicWs.request({ active_symbols: "brief" });
    this.ensureNoError(res, "active_symbols");
    const symbols = (res.active_symbols ?? []) as Array<Record<string, unknown>>;
    const instruments: Instrument[] = symbols.map((s) => {
      const market = String(s.market ?? "");
      const assetClass =
        market === "synthetic_index"
          ? "synthetic"
          : market === "forex"
            ? "forex"
            : market === "cryptocurrency"
              ? "crypto"
              : market === "indices"
                ? "indices"
                : market === "commodities"
                  ? "commodities"
                  : "indices";
      return {
        symbol: String(s.underlying_symbol ?? ""),
        name: String(s.underlying_symbol_name ?? s.underlying_symbol ?? ""),
        assetClass,
        market,
        pipSize: typeof s.pip_size === "number" ? s.pip_size : undefined,
        minDurationSec: 5,
        maxDurationSec: undefined,
        tradeable: Number(s.exchange_is_open ?? 0) === 1 && Number(s.is_trading_suspended ?? 0) === 0,
      };
    });
    this.instrumentsCache = instruments.filter((i) => i.symbol);
    return this.instrumentsCache;
  }

  async getQuote(symbol: string): Promise<Quote> {
    const res = await this.publicWs.request({ ticks: symbol });
    this.ensureNoError(res, `ticks ${symbol}`);
    const tick = res.tick as { ask?: number; bid?: number; quote?: number; epoch?: number } | undefined;
    if (!tick) throw new BrokerError(`No tick returned for ${symbol}`, "unknown");
    const bid = Number(tick.bid ?? tick.quote ?? 0);
    const ask = Number(tick.ask ?? tick.quote ?? 0);
    return { symbol, bid, ask, mid: (bid + ask) / 2, epochMs: Number(tick.epoch ?? Date.now() / 1000) * 1000 };
  }

  /** Stream ticks. Returns an unsubscribe function. */
  async subscribeTicks(symbol: string, handler: (q: Quote) => void): Promise<() => void> {
    const key = `ticks:${symbol}`;
    await this.publicWs.subscribe(key, { ticks: symbol, subscribe: 1 }, (msg) => {
      const tick = msg.tick as { ask?: number; bid?: number; quote?: number; epoch?: number } | undefined;
      if (!tick) return;
      const bid = Number(tick.bid ?? tick.quote ?? 0);
      const ask = Number(tick.ask ?? tick.quote ?? 0);
      handler({ symbol, bid, ask, mid: (bid + ask) / 2, epochMs: Number(tick.epoch ?? Date.now() / 1000) * 1000 });
    });
    return () => {
      void this.publicWs.unsubscribe(key, { forget: symbol });
    };
  }

  async getCandles(symbol: string, granularitySec: number, count: number): Promise<Candle[]> {
    const res = await this.publicWs.request({
      ticks_history: symbol,
      adjust_start_time: 1,
      count,
      end: "latest",
      start: 1,
      style: "candles",
      granularity: granularitySec,
    });
    this.ensureNoError(res, `ticks_history ${symbol}`);
    const candles = (res.candles ?? []) as Array<{ epoch: number; open: number; high: number; low: number; close: number }>;
    return candles.map((c) => ({ epoch: c.epoch, open: c.open, high: c.high, low: c.low, close: c.close }));
  }

  /** The minimum contract duration, in ticks, that the provider currently offers. */
  async contractsFor(symbol: string): Promise<Array<Record<string, unknown>>> {
    const res = await this.publicWs.request({ contracts_for: symbol });
    this.ensureNoError(res, `contracts_for ${symbol}`);
    const cf = res.contracts_for as { available?: Array<Record<string, unknown>> } | undefined;
    return cf?.available ?? [];
  }

  // --- Authenticated trading --------------------------------------------------

  private async ensureTradingWs(): Promise<WsClient> {
    if (this.tradingWs?.isOpen()) return this.tradingWs;
    const accountId = this.activeAccountId ?? this.creds.accountId;
    if (!accountId) throw new BrokerError("No Deriv account selected for trading", "auth");
    const otp = await this.rest(`/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`, { method: "POST" });
    const acct = this.accounts.find((a) => a.id === accountId);
    const wsUrl = resolveTradingWsUrl(otp, acct?.type === "real" ? "real" : "demo");
    if (!wsUrl) throw new BrokerError("OTP endpoint did not return a WebSocket URL", "unknown");
    const client = new WsClient(() => wsUrl, "deriv-trading", this.log);
    await client.connect();
    this.tradingWs = client;
    return client;
  }

  setActiveAccount(accountId: string): void {
    this.activeAccountId = accountId;
    void this.tradingWs?.close();
    this.tradingWs = null;
  }

  async placeOrder(intent: TradeIntent): Promise<ExecutionResult> {
    const ws = await this.ensureTradingWs();
    const requestedSec = intent.durationSec ?? 300;
    const contractType = this.mapContractType(intent.side, intent.orderType);
    const duration = await this.resolveDuration(intent.symbol, requestedSec);
    const proposalRes = await ws.request({
      proposal: 1,
      amount: intent.amount,
      basis: "stake",
      contract_type: contractType,
      currency: this.accounts.find((a) => a.id === this.activeAccountId)?.currency ?? "USD",
      duration: duration.value,
      duration_unit: duration.unit,
      // The options trading API names this `underlying_symbol`; a `symbol` field is
      // rejected with "Input validation failed: symbol".
      underlying_symbol: intent.symbol,
    });
    if (proposalRes.error) {
      const e = proposalRes.error as { message?: string; code?: string };
      throw new BrokerError(`Deriv proposal rejected: ${e.message ?? e.code}`, "rejected");
    }
    const proposal = proposalRes.proposal as { id?: string; ask_price?: number; payout?: number } | undefined;
    if (!proposal?.id) throw new BrokerError("Deriv did not return a proposal id", "unknown");
    const buyRes = await ws.request({ buy: proposal.id, price: proposal.ask_price });
    if (buyRes.error) {
      const e = buyRes.error as { message?: string; code?: string };
      throw new BrokerError(`Deriv buy rejected: ${e.message ?? e.code}`, "rejected");
    }
    const buy = buyRes.buy as { contract_id?: number; buy_price?: number; payout?: number } | undefined;
    if (!buy?.contract_id) {
      // The buy response is ambiguous: reconcile rather than resubmit.
      throw new BrokerError("Deriv buy response did not contain a contract id; reconcile before retrying", "unknown");
    }
    return {
      brokerOrderId: String(buy.contract_id),
      status: "open",
      fillPrice: toNumber(buy.buy_price),
      payout: toNumber(buy.payout),
      // The expiry the provider actually accepted, which may differ from the request when a
      // sub-15s duration is widened to Deriv's intraday minimum.
      effectiveDurationSec: duration.effectiveSec,
      raw: buyRes,
    };
  }

  private mapContractType(side: "buy" | "sell", orderType: string): string {
    // Rise/Fall contracts. Duration is expressed in ticks.
    if (orderType === "market") return side === "buy" ? "CALL" : "PUT";
    return side === "buy" ? "CALL" : "PUT";
  }

  async getOrder(brokerOrderId: string): Promise<{ status: OrderStatus; profit: number | null; fillPrice: number | null; payout: number | null } | null> {
    const ws = await this.ensureTradingWs();
    const res = await ws.request({ proposal_open_contract: 1, contract_id: Number(brokerOrderId) });
    const poc = res.proposal_open_contract as
      | { is_sold?: number | boolean; profit?: unknown; entry_spot?: unknown; payout?: unknown; status?: string }
      | undefined;
    if (!poc) return null;
    const sold = poc.is_sold === 1 || poc.is_sold === true;
    return {
      status: sold ? "settled" : "open",
      profit: toNumber(poc.profit),
      fillPrice: toNumber(poc.entry_spot),
      payout: toNumber(poc.payout),
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const ws = await this.ensureTradingWs();
    const res = await ws.request({ portfolio: 1 });
    if (res.error) return [];
    const contracts = (res.portfolio as { contracts?: Array<Record<string, unknown>> } | undefined)?.contracts ?? [];
    return contracts.map((c) => ({
      brokerPositionId: String(c.contract_id ?? ""),
      symbol: String(c.symbol ?? c.underlying_symbol ?? ""),
      side: String(c.contract_type ?? "").toUpperCase() === "PUT" ? "sell" : "buy",
      size: toNumber(c.buy_price) ?? 0,
      entryPrice: toNumber(c.entry_spot),
      currentPrice: toNumber(c.current_spot),
      unrealizedPnl: toNumber(c.profit),
    }));
  }

  async close(): Promise<void> {
    await this.publicWs.close();
    await this.tradingWs?.close();
    this.tradingWs = null;
  }
}
