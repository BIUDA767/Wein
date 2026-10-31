import { describe, it, expect, afterEach } from "vitest";
import { DerivAdapter, resolveTradingWsUrl, toNumber, type BrokerPosition } from "@phirst/brokers";

/**
 * Regression guards for the Deriv options adapter. Each case here corresponds to a defect
 * that reached a real call against Deriv's API:
 *
 *  - `toNumber`: Deriv serialises money as a decimal string, so a `typeof === "number"`
 *    check turned every balance, fill price and settled profit into `null`.
 *  - `resolveTradingWsUrl`: the OTP endpoint returns the socket as `data.url`, not
 *    `ws_url`/`wsUrl`, so the live trading socket never opened.
 *  - `placeOrder`: the options trading API names the instrument `underlying_symbol`, and
 *    tick expiries are capped at 10, so a `symbol` field or a large tick count was rejected.
 */

describe("toNumber", () => {
  it("parses Deriv's decimal money strings", () => {
    expect(toNumber("10000.00")).toBe(10000);
    expect(toNumber("-1.00")).toBe(-1);
    expect(toNumber("569.74")).toBe(569.74);
  });

  it("passes through finite numbers", () => {
    expect(toNumber(1.92)).toBe(1.92);
    expect(toNumber(0)).toBe(0);
  });

  it("does not invent a value for missing or unparseable data", () => {
    expect(toNumber(null)).toBeNull();
    expect(toNumber(undefined)).toBeNull();
    expect(toNumber("")).toBeNull();
    expect(toNumber("   ")).toBeNull();
    expect(toNumber("n/a")).toBeNull();
    expect(toNumber(NaN)).toBeNull();
    expect(toNumber(Infinity)).toBeNull();
  });
});

describe("resolveTradingWsUrl", () => {
  it("uses the ready-to-use socket Deriv returns as data.url", () => {
    const url = resolveTradingWsUrl({ data: { url: "wss://api.derivws.com/trading/v1/options/ws/demo?otp=abc" } }, "demo");
    expect(url).toBe("wss://api.derivws.com/trading/v1/options/ws/demo?otp=abc");
  });

  it("accepts the defensive ws_url and wsUrl spellings", () => {
    expect(resolveTradingWsUrl({ data: { ws_url: "wss://a" } }, "demo")).toBe("wss://a");
    expect(resolveTradingWsUrl({ data: { wsUrl: "wss://b" } }, "real")).toBe("wss://b");
  });

  it("assembles a socket from a bare otp, choosing the account kind", () => {
    expect(resolveTradingWsUrl({ data: { otp: "xyz" } }, "demo")).toContain("/ws/demo?otp=xyz");
    expect(resolveTradingWsUrl({ data: { otp: "xyz" } }, "real")).toContain("/ws/real?otp=xyz");
  });

  it("returns null rather than an unusable url when nothing is present", () => {
    expect(resolveTradingWsUrl({ data: {} }, "demo")).toBeNull();
    expect(resolveTradingWsUrl({}, "demo")).toBeNull();
  });
});

describe("DerivAdapter balance reads", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it("reads string balances from the accounts endpoint", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { account_id: "DOT94980040", account_type: "demo", currency: "USD", balance: "10000.00", loginid: "DOT94980040" },
            { account_id: "ROT92844090", account_type: "real", currency: "USD", balance: "0.00", loginid: "ROT92844090" },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const adapter = new DerivAdapter({ token: "pat_x", appId: "34PCV510XlKxHZvUQZjXa", authMethod: "pat" });
    const accounts = await adapter.listAccounts();
    expect(accounts.find((a) => a.id === "DOT94980040")?.balance).toBe(10000);
    expect(accounts.find((a) => a.id === "ROT92844090")?.balance).toBe(0);
    expect(await adapter.getBalance("DOT94980040")).toBe(10000);
  });
});

describe("DerivAdapter duration mapping", () => {
  /**
   * The public socket is replaced with a stand-in so the mapping can be asserted without
   * network access. Only `ticks_history` and the trading request matter here.
   */
  function stubSockets(adapter: DerivAdapter, tickSec: number, tradingResponses: Record<string, unknown>[]) {
    const sent: Array<Record<string, unknown>> = [];
    const publicWs = {
      request: async (payload: Record<string, unknown>) => {
        if ("ticks_history" in payload) {
          const now = 1_800_000_000;
          return { history: { times: [now - tickSec * 2, now - tickSec, now] } };
        }
        return {};
      },
    };
    const tradingWs = {
      isOpen: () => true,
      request: async (payload: Record<string, unknown>) => {
        sent.push(payload);
        return tradingResponses.shift() ?? {};
      },
    };
    (adapter as unknown as { publicWs: unknown }).publicWs = publicWs;
    (adapter as unknown as { tradingWs: unknown }).tradingWs = tradingWs;
    (adapter as unknown as { activeAccountId: string }).activeAccountId = "DOT1";
    return sent;
  }

  it("sends a short duration as whole ticks and names the instrument underlying_symbol", async () => {
    const adapter = new DerivAdapter({ token: "pat_x", appId: "app", authMethod: "pat" });
    const sent = stubSockets(adapter, 2, [
      { proposal: { id: "p1", ask_price: 1, payout: 1.92 } },
      { buy: { contract_id: 123, buy_price: "1.00", payout: "1.92", balance_after: "9999" } },
    ]);

    const res = await adapter.placeOrder({ symbol: "R_100", side: "buy", orderType: "fixed_expiry", amount: 1, durationSec: 10 } as never);
    const proposal = sent[0]!;
    expect(proposal.underlying_symbol).toBe("R_100");
    expect("symbol" in proposal).toBe(false);
    expect(proposal.duration_unit).toBe("t");
    expect(proposal.duration).toBe(5);
    expect(res.brokerOrderId).toBe("123");
    expect(res.fillPrice).toBe(1);
    expect(res.payout).toBe(1.92);
    expect(res.effectiveDurationSec).toBe(10);
  });

  it("switches to a seconds contract when the request exceeds the 10-tick ceiling", async () => {
    const adapter = new DerivAdapter({ token: "pat_x", appId: "app", authMethod: "pat" });
    const sent = stubSockets(adapter, 2, [
      { proposal: { id: "p1", ask_price: 1, payout: 1.89 } },
      { buy: { contract_id: 456, buy_price: "1.00", payout: "1.89" } },
    ]);

    const res = await adapter.placeOrder({ symbol: "R_100", side: "buy", orderType: "fixed_expiry", amount: 1, durationSec: 60 } as never);
    expect(sent[0]!.duration_unit).toBe("s");
    expect(sent[0]!.duration).toBe(60);
    expect(res.effectiveDurationSec).toBe(60);
  });

  it("widens a sub-15s request to Deriv's intraday minimum and reports the real expiry", async () => {
    const adapter = new DerivAdapter({ token: "pat_x", appId: "app", authMethod: "pat" });
    // A 1s-per-tick index with a 6s request rounds to 6 ticks, which fits the ceiling.
    const sent = stubSockets(adapter, 1, [
      { proposal: { id: "p1", ask_price: 1, payout: 1.9 } },
      { buy: { contract_id: 789, buy_price: "1.00", payout: "1.9" } },
    ]);
    const res = await adapter.placeOrder({ symbol: "1HZ100V", side: "buy", orderType: "fixed_expiry", amount: 1, durationSec: 6 } as never);
    expect(sent[0]!.duration_unit).toBe("t");
    expect(sent[0]!.duration).toBe(6);
    expect(res.effectiveDurationSec).toBe(6);
  });
});

describe("DerivAdapter getOrder", () => {
  it("coerces the settled contract's string profit and entry spot", async () => {
    const adapter = new DerivAdapter({ token: "pat_x", appId: "app", authMethod: "pat" });
    (adapter as unknown as { activeAccountId: string }).activeAccountId = "DOT1";
    (adapter as unknown as { tradingWs: unknown }).tradingWs = {
      isOpen: () => true,
      request: async () => ({
        proposal_open_contract: { is_sold: 1, profit: "-1.00", entry_spot: "569.74", payout: "1.92" },
      }),
    };
    const order = await adapter.getOrder("123");
    expect(order).not.toBeNull();
    expect(order!.status).toBe("settled");
    expect(order!.profit).toBe(-1);
    expect(order!.fillPrice).toBe(569.74);
    expect(order!.payout).toBe(1.92);
  });

  it("reports an unsold contract as open", async () => {
    const adapter = new DerivAdapter({ token: "pat_x", appId: "app", authMethod: "pat" });
    (adapter as unknown as { activeAccountId: string }).activeAccountId = "DOT1";
    (adapter as unknown as { tradingWs: unknown }).tradingWs = {
      isOpen: () => true,
      request: async () => ({ proposal_open_contract: { is_sold: 0, profit: "0.00", entry_spot: "570.00", payout: "1.92" } }),
    };
    const order = await adapter.getOrder("123");
    expect(order!.status).toBe("open");
  });
});

describe("DerivAdapter getPositions", () => {
  it("maps an open contract with string numerics", async () => {
    const adapter = new DerivAdapter({ token: "pat_x", appId: "app", authMethod: "pat" });
    (adapter as unknown as { activeAccountId: string }).activeAccountId = "DOT1";
    (adapter as unknown as { tradingWs: unknown }).tradingWs = {
      isOpen: () => true,
      request: async () => ({
        portfolio: {
          contracts: [
            { contract_id: 18981419379, underlying_symbol: "R_100", contract_type: "CALL", buy_price: "1.00", entry_spot: "570.31", current_spot: "569.71", profit: "-0.10" },
          ],
        },
      }),
    };
    const positions: BrokerPosition[] = await adapter.getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]!.symbol).toBe("R_100");
    expect(positions[0]!.side).toBe("buy");
    expect(positions[0]!.size).toBe(1);
    expect(positions[0]!.entryPrice).toBe(570.31);
    expect(positions[0]!.unrealizedPnl).toBe(-0.1);
  });
});
