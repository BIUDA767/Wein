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
  balance?: number;
  loginid?: string;
  is_virtual?: boolean | number;
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
        "Minimum expiry is 5 ticks; on 1-second volatility indices that is 5 seconds.",
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
        Authorization: `Bearer ${token}`,
        "Deriv-App-ID": this.appId,
        "Content-Type": "application/json",
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
      throw new BrokerError(
        `Deriv ${path} failed (${res.status}${code ? " " + code : ""}): ${message}`,
        isAuth ? "auth" : res.status === 429 ? "rate_limit" : "unknown",
        res.status >= 500 || res.status === 429,
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
        message: "No API token configured. Add a Deriv Personal Access Token and a registered Deriv-App-ID.",
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
          e.code === "auth"
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
      balance: typeof a.balance === "number" ? a.balance : null,
      loginid: a.loginid,
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
    const data = (otp.data ?? otp) as { ws_url?: string; wsUrl?: string; otp?: string };
    let wsUrl = data.ws_url ?? data.wsUrl;
    if (!wsUrl && data.otp) {
      const acct = this.accounts.find((a) => a.id === accountId);
      const kind = acct?.type === "real" ? "real" : "demo";
      wsUrl = `wss://api.derivws.com/trading/v1/options/ws/${kind}?otp=${encodeURIComponent(data.otp)}`;
    }
    if (!wsUrl) throw new BrokerError("OTP endpoint did not return a WebSocket URL", "unknown");
    const client = new WsClient(() => wsUrl!, "deriv-trading", this.log);
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
    const durationSec = intent.durationSec ?? 300;
    const durationTicks = Math.max(5, Math.round(durationSec));
    const contractType = this.mapContractType(intent.side, intent.orderType);
    const proposalRes = await ws.request({
      proposal: 1,
      amount: intent.amount,
      basis: "stake",
      contract_type: contractType,
      currency: this.accounts.find((a) => a.id === this.activeAccountId)?.currency ?? "USD",
      duration: durationTicks,
      duration_unit: "t",
      symbol: intent.symbol,
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
      fillPrice: typeof buy.buy_price === "number" ? buy.buy_price : null,
      payout: typeof buy.payout === "number" ? buy.payout : null,
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
      | { is_sold?: number | boolean; profit?: number; entry_spot?: number; payout?: number; status?: string }
      | undefined;
    if (!poc) return null;
    const sold = poc.is_sold === 1 || poc.is_sold === true;
    return {
      status: sold ? "settled" : "open",
      profit: typeof poc.profit === "number" ? poc.profit : null,
      fillPrice: typeof poc.entry_spot === "number" ? poc.entry_spot : null,
      payout: typeof poc.payout === "number" ? poc.payout : null,
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const ws = await this.ensureTradingWs();
    const res = await ws.request({ portfolio: 1 });
    if (res.error) return [];
    const contracts = (res.portfolio as { contracts?: Array<Record<string, unknown>> } | undefined)?.contracts ?? [];
    return contracts.map((c) => ({
      brokerPositionId: String(c.contract_id ?? ""),
      symbol: String(c.symbol ?? ""),
      side: String(c.contract_type ?? "").toUpperCase() === "PUT" ? "sell" : "buy",
      size: Number(c.buy_price ?? 0),
      entryPrice: typeof c.entry_spot === "number" ? c.entry_spot : null,
      currentPrice: typeof c.current_spot === "number" ? c.current_spot : null,
      unrealizedPnl: typeof c.profit === "number" ? c.profit : null,
    }));
  }

  async close(): Promise<void> {
    await this.publicWs.close();
    await this.tradingWs?.close();
    this.tradingWs = null;
  }
}
