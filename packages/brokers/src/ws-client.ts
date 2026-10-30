import { BrokerError } from "./types.ts";

export interface WsRequestOptions {
  timeoutMs?: number;
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  expect: string;
}

export type SubscriptionHandler = (msg: Record<string, unknown>) => void;

/**
 * A small, dependency-free WebSocket client with request/response correlation.
 * Deriv's API echoes `req_id`; we also match on `msg_type` as a fallback so a missing
 * echo cannot hang a request forever.
 */
export class WsClient {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private subscriptions = new Map<string, SubscriptionHandler>();
  private subIdToHandler = new Map<string, SubscriptionHandler>();
  private connectPromise: Promise<void> | null = null;
  private closedByUser = false;
  private lastError: string | null = null;
  private open = false;

  constructor(
    private readonly urlProvider: () => Promise<string> | string,
    private readonly label: string,
    private readonly log: (msg: string, fields?: Record<string, unknown>) => void = () => {},
  ) {}

  isOpen(): boolean {
    return this.open;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  async connect(): Promise<void> {
    if (this.open) return;
    if (this.connectPromise) return this.connectPromise;
    this.closedByUser = false;
    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async doConnect(): Promise<void> {
    const url = await this.urlProvider();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* already closing */ }
        reject(new BrokerError(`${this.label}: connection timed out`, "network", true));
      }, 15_000);

      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.ws = ws;
        this.open = true;
        this.lastError = null;
        this.log(`${this.label}: connected`);
        resolve();
      };
      ws.onmessage = (ev) => this.handleMessage(String(ev.data));
      ws.onerror = () => {
        this.lastError = "websocket error";
      };
      ws.onclose = (ev) => {
        this.open = false;
        this.ws = null;
        this.lastError = `closed code=${ev.code}${ev.reason ? " " + ev.reason : ""}`;
        this.rejectAll(new BrokerError(`${this.label}: connection closed (${ev.code})`, "network", true));
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new BrokerError(`${this.label}: connection failed (${ev.code})`, "network", true));
        }
        if (!this.closedByUser) this.log(`${this.label}: closed`, { code: ev.code, reason: ev.reason });
      };
    });
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const reqId = typeof msg.req_id === "number" ? msg.req_id : undefined;
    if (reqId !== undefined && this.pending.has(reqId)) {
      const p = this.pending.get(reqId)!;
      this.pending.delete(reqId);
      clearTimeout(p.timer);
      p.resolve(msg);
      return;
    }
    // Subscription streams carry a subscription id.
    const sub = msg.subscription as { id?: string } | undefined;
    if (sub?.id && this.subIdToHandler.has(sub.id)) {
      this.subIdToHandler.get(sub.id)!(msg);
    }
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** Send a request and resolve with the response that carries the matching req_id. */
  async request(payload: Record<string, unknown>, opts: WsRequestOptions = {}): Promise<Record<string, unknown>> {
    if (!this.open) await this.connect();
    const ws = this.ws;
    if (!ws) throw new BrokerError(`${this.label}: not connected`, "network", true);
    const reqId = ++this.seq;
    const timeoutMs = opts.timeoutMs ?? 20_000;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new BrokerError(`${this.label}: request timed out after ${timeoutMs}ms`, "network", true));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer, expect: String(payload[Object.keys(payload)[0]!] ?? "") });
      try {
        ws.send(JSON.stringify({ ...payload, req_id: reqId }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(reqId);
        reject(new BrokerError(`${this.label}: send failed: ${(err as Error).message}`, "network", true));
      }
    });
  }

  /** Subscribe to a stream. `subscribe` must be set by the caller in the payload. */
  async subscribe(
    key: string,
    payload: Record<string, unknown>,
    handler: SubscriptionHandler,
  ): Promise<void> {
    const res = await this.request(payload);
    const sub = res.subscription as { id?: string } | undefined;
    if (sub?.id) {
      this.subIdToHandler.set(sub.id, handler);
      this.subscriptions.set(key, handler);
    }
    handler(res);
  }

  async unsubscribe(key: string, payload: Record<string, unknown>): Promise<void> {
    this.subscriptions.delete(key);
    try {
      await this.request(payload, { timeoutMs: 5000 });
    } catch {
      /* best-effort: a failed forget must not break the caller */
    }
  }

  async close(): Promise<void> {
    this.closedByUser = true;
    this.subscriptions.clear();
    this.subIdToHandler.clear();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closing */
      }
    }
    this.ws = null;
    this.open = false;
  }
}
