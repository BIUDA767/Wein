import {
  getRiskConfig,
  setRiskConfig,
  listStrategies,
  getStrategy,
  upsertStrategy,
  setActiveStrategy,
  setStrategyEnabled,
  deleteStrategy,
  listOrders,
  listPositions,
  listEquity,
  listVerdicts,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  listAudit,
  getSetting,
  setSetting,
  audit,
  DEFAULT_RISK_CONFIG,
  BUILTIN_STRATEGIES,
  getBuiltin,
  type Config,
  type Logger,
  type RiskConfig,
  type TradeMode,
  listSettledOrders,
} from "@phirst/core";
import type { TradingEngine } from "@phirst/engine";
import { json, error, type RequestContext, type Router } from "../http.ts";

function validateRisk(input: unknown): { ok: true; value: RiskConfig } | { ok: false; message: string } {
  const r = (input ?? {}) as Partial<RiskConfig>;
  const merged: RiskConfig = { ...DEFAULT_RISK_CONFIG, ...r };
  const numeric: Array<keyof RiskConfig> = [
    "riskPerTrade",
    "dailyLossLimit",
    "maxDrawdown",
    "maxExposure",
    "maxConcurrentTrades",
    "consecutiveLossLimit",
    "lossStreakDeRiskFactor",
    "maxTradeAmount",
  ];
  for (const key of numeric) {
    const v = merged[key];
    if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false, message: `${key} must be a finite number.` };
    if (v < 0) return { ok: false, message: `${key} cannot be negative.` };
  }
  if (merged.riskPerTrade <= 0 || merged.riskPerTrade > 1) {
    return { ok: false, message: "riskPerTrade must be greater than 0 and at most 1 (100%)." };
  }
  if (merged.maxDrawdown <= 0 || merged.maxDrawdown > 1) {
    return { ok: false, message: "maxDrawdown must be greater than 0 and at most 1 (100%)." };
  }
  if (merged.lossStreakDeRiskFactor <= 0 || merged.lossStreakDeRiskFactor > 1) {
    return { ok: false, message: "lossStreakDeRiskFactor must be greater than 0 and at most 1. Size may never increase after losses." };
  }
  if (merged.maxConcurrentTrades < 1 || !Number.isInteger(merged.maxConcurrentTrades)) {
    return { ok: false, message: "maxConcurrentTrades must be a positive integer." };
  }
  if (merged.consecutiveLossLimit < 1 || !Number.isInteger(merged.consecutiveLossLimit)) {
    return { ok: false, message: "consecutiveLossLimit must be a positive integer." };
  }
  if (merged.maxTradeAmount <= 0) return { ok: false, message: "maxTradeAmount must be greater than 0." };
  if (merged.maxExposure <= 0) return { ok: false, message: "maxExposure must be greater than 0." };
  if (merged.dailyLossLimit <= 0) return { ok: false, message: "dailyLossLimit must be greater than 0." };
  merged.allowedSymbols = Array.isArray(r.allowedSymbols) ? r.allowedSymbols.filter((s) => typeof s === "string") : [];
  merged.allowedStrategies = Array.isArray(r.allowedStrategies) ? r.allowedStrategies.filter((s) => typeof s === "string") : [];
  return { ok: true, value: merged };
}

export function registerEngineRoutes(router: Router, engine: TradingEngine, config: Config, log: Logger): void {
  router.get("/api/engine/status", ({ res }: RequestContext) => {
    void (async () => { json(res, 200, await engine.snapshot()); })();
  });

  router.post("/api/engine/start", ({ res, ip }: RequestContext) => {
    void (async () => {
      const result = await engine.start();
      await audit({ actor: "user", action: "engine.start_request", detail: { ok: result.ok, message: result.message }, ip });
      json(res, result.ok ? 200 : 400, result);
    })();
  });

  router.post("/api/engine/pause", ({ res, body, ip }: RequestContext) => {
    void (async () => {
      const { reason } = (body ?? {}) as { reason?: string };
      await engine.pause(reason || "Paused by user.");
      await audit({ actor: "user", action: "engine.pause_request", ip });
      json(res, 200, { ok: true, message: "Engine paused." });
    })();
  });

  router.post("/api/engine/resume", ({ res, ip }: RequestContext) => {
    void (async () => {
      const result = await engine.resume();
      await audit({ actor: "user", action: "engine.resume_request", detail: { ok: result.ok }, ip });
      json(res, result.ok ? 200 : 400, result);
    })();
  });

  router.post("/api/engine/stop", ({ res, body, ip }: RequestContext) => {
    void (async () => {
      const { reason } = (body ?? {}) as { reason?: string };
      await engine.stop(reason || "Stopped by user.");
      await audit({ actor: "user", action: "engine.stop_request", ip });
      json(res, 200, { ok: true, message: "Engine stopped." });
    })();
  });

  router.post("/api/engine/emergency-stop", ({ res, body, ip }: RequestContext) => {
    void (async () => {
      const { reason } = (body ?? {}) as { reason?: string };
      await engine.emergencyStop(reason || "Emergency stop engaged by user.");
      await audit({ actor: "user", action: "engine.emergency_stop_request", ip });
      json(res, 200, { ok: true, message: "Emergency stop engaged. No new orders will be placed." });
    })();
  });

  router.post("/api/engine/reset-emergency", ({ res, ip }: RequestContext) => {
    void (async () => {
      const result = await engine.resetEmergency();
      await audit({ actor: "user", action: "engine.reset_emergency_request", detail: { ok: result.ok }, ip });
      json(res, result.ok ? 200 : 400, result);
    })();
  });

  router.post("/api/engine/mode", ({ res, body, ip }: RequestContext) => {
    void (async () => {
      const { mode, confirmation } = (body ?? {}) as { mode?: TradeMode; confirmation?: string };
      if (mode !== "paper" && mode !== "live") {
        error(res, 400, 'mode must be "paper" or "live".');
        return;
      }
      const result = await engine.setMode(mode, confirmation);
      await audit({ actor: "user", action: "engine.set_mode_request", detail: { mode, ok: result.ok, message: result.message }, ip });
      json(res, result.ok ? 200 : 400, result);
    })();
  });

  router.post("/api/engine/auto-trade", ({ res, body }: RequestContext) => {
    void (async () => {
      const { enabled } = (body ?? {}) as { enabled?: boolean };
      if (typeof enabled !== "boolean") { error(res, 400, "enabled must be a boolean."); return; }
      engine.setAutoTrade(enabled);
      await setSetting("autoTrade", enabled);
      json(res, 200, { ok: true, autoTrade: enabled });
    })();
  });

  router.post("/api/engine/symbol", ({ res, body }: RequestContext) => {
    void (async () => {
      const { symbol } = (body ?? {}) as { symbol?: string };
      if (!symbol || symbol.trim().length === 0) { error(res, 400, "symbol is required."); return; }
      engine.setSymbol(symbol.trim());
      await setSetting("activeSymbol", symbol.trim());
      json(res, 200, { ok: true, symbol: symbol.trim() });
    })();
  });

  router.post("/api/engine/reconcile", ({ res, ip }: RequestContext) => {
    void (async () => {
      const result = await engine.forceReconcile();
      await audit({ actor: "user", action: "engine.reconcile", detail: result ? { ...result } : null, ip });
      json(res, 200, { ok: true, result });
    })();
  });

  router.post("/api/orders", ({ res, body, ip }: RequestContext) => {
    void (async () => {
      const { side, amount, durationSec, symbol } = (body ?? {}) as {
        side?: "buy" | "sell"; amount?: number; durationSec?: number; symbol?: string;
      };
      if (side !== "buy" && side !== "sell") { error(res, 400, 'side must be "buy" or "sell".'); return; }
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) { error(res, 400, "amount must be a positive number."); return; }
      if (typeof durationSec !== "number" || !Number.isInteger(durationSec) || durationSec <= 0) { error(res, 400, "durationSec must be a positive integer."); return; }
      const result = await engine.manualOrder({ side, amount, durationSec, origin: "manual", symbol });
      await audit({ actor: "user", action: "order.manual_request", detail: { side, amount, durationSec, symbol, ok: result.ok }, ip });
      json(res, result.ok ? 201 : 400, result);
    })();
  });

  router.get("/api/orders", ({ res, url }: RequestContext) => {
    void (async () => {
      const mode = url.searchParams.get("mode") as TradeMode | null;
      const status = url.searchParams.get("status") ?? undefined;
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500);
      json(res, 200, { orders: await listOrders(limit, { mode: mode ?? undefined, status }) });
    })();
  });

  router.get("/api/positions", ({ res, url }: RequestContext) => {
    void (async () => {
      const mode = (url.searchParams.get("mode") as TradeMode | null) ?? undefined;
      json(res, 200, { positions: await listPositions(mode) });
    })();
  });

  router.get("/api/equity", ({ res, url }: RequestContext) => {
    void (async () => {
      const mode = (url.searchParams.get("mode") as TradeMode | null) ?? "paper";
      json(res, 200, { series: await listEquity(mode, 500) });
    })();
  });

  // --- Risk ------------------------------------------------------------------

  router.get("/api/risk", ({ res }: RequestContext) => {
    void (async () => { json(res, 200, { config: await getRiskConfig() }); })();
  });

  router.put("/api/risk", ({ res, body, ip }: RequestContext) => {
    void (async () => {
      const result = validateRisk(body);
      if (!result.ok) { error(res, 400, result.message); return; }
      await setRiskConfig(result.value);
      await audit({ actor: "user", action: "risk.update", detail: result.value as unknown as Record<string, unknown>, ip });
      json(res, 200, { ok: true, config: result.value });
    })();
  });

  // --- Strategies -------------------------------------------------------------

  router.get("/api/strategies", ({ res }: RequestContext) => {
    void (async () => {
      json(res, 200, {
        strategies: await listStrategies(),
        builtins: BUILTIN_STRATEGIES.map((s) => ({ id: s.id, name: s.name, description: s.description, defaultParams: s.defaultParams })),
      });
    })();
  });

  router.post("/api/strategies", ({ res, body, ip }: RequestContext) => {
    void (async () => {
      const { name, description, templateId, params } = (body ?? {}) as {
        name?: string; description?: string; templateId?: string; params?: Record<string, unknown>;
      };
      if (!name || name.trim().length === 0) { error(res, 400, "A strategy name is required."); return; }
      if (!templateId || !getBuiltin(templateId)) {
        error(res, 400, `templateId must be one of: ${BUILTIN_STRATEGIES.map((s) => s.id).join(", ")}`);
        return;
      }
      const id = `custom:${templateId}:${Date.now().toString(36)}`;
      await upsertStrategy({
        id,
        name: name.trim(),
        description: description ?? `Custom strategy based on ${templateId}`,
        params: params ?? {},
        enabled: true,
        builtin: false,
        createdBy: "user",
      });
      await audit({ actor: "user", action: "strategy.create", target: id, detail: { name, templateId }, ip });
      json(res, 201, { ok: true, id });
    })();
  });

  router.post("/api/strategies/:id/activate", ({ res, params, ip }: RequestContext) => {
    void (async () => {
      const row = await getStrategy(params.id!);
      if (!row) { error(res, 404, "Strategy not found."); return; }
      if (row.enabled !== true) { error(res, 400, "Enable the strategy before activating it."); return; }
      await setActiveStrategy(String(row.id));
      await audit({ actor: "user", action: "strategy.activate", target: String(row.id), ip });
      json(res, 200, { ok: true, activeStrategyId: String(row.id) });
    })();
  });

  router.patch("/api/strategies/:id", ({ res, params, body, ip }: RequestContext) => {
    void (async () => {
      const row = await getStrategy(params.id!);
      if (!row) { error(res, 404, "Strategy not found."); return; }
      const { enabled, params: newParams } = (body ?? {}) as { enabled?: boolean; params?: Record<string, unknown> };
      if (typeof enabled === "boolean") {
        const snap = await engine.snapshot();
        if (row.is_active === true && !enabled && snap.state === "running") {
          error(res, 409, "Pause the engine before disabling the active strategy.");
          return;
        }
        await setStrategyEnabled(String(row.id), enabled);
      }
      if (newParams && typeof newParams === "object") {
        await upsertStrategy({
          id: String(row.id),
          name: String(row.name),
          description: String(row.description),
          params: { ...(row.params as Record<string, unknown>), ...newParams },
          enabled: row.enabled === true,
          builtin: row.builtin === true,
          createdBy: row.created_by ? String(row.created_by) : null,
        });
      }
      await audit({ actor: "user", action: "strategy.update", target: String(row.id), detail: { enabled, params: newParams }, ip });
      json(res, 200, { ok: true });
    })();
  });

  router.delete("/api/strategies/:id", ({ res, params, ip }: RequestContext) => {
    void (async () => {
      const row = await getStrategy(params.id!);
      if (!row) { error(res, 404, "Strategy not found."); return; }
      if (row.builtin === true) { error(res, 400, "Built-in strategies cannot be deleted. Disable them instead."); return; }
      await deleteStrategy(String(row.id));
      await audit({ actor: "user", action: "strategy.delete", target: String(row.id), ip });
      json(res, 200, { ok: true });
    })();
  });

  // --- Reporting --------------------------------------------------------------

  router.get("/api/reports/performance", ({ res, url }: RequestContext) => {
    void (async () => {
      const mode = (url.searchParams.get("mode") as TradeMode | null) ?? "paper";
      const orders = await listSettledOrders(mode, 500);
      const profits = orders.map((o) => o.profit ?? 0);
      const wins = profits.filter((p) => p > 0);
      const losses = profits.filter((p) => p < 0);
      const grossWin = wins.reduce((a, b) => a + b, 0);
      const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
      const byStrategy = new Map<string, { trades: number; pnl: number }>();
      for (const o of orders) {
        const key = o.strategyId ?? "manual";
        const entry = byStrategy.get(key) ?? { trades: 0, pnl: 0 };
        entry.trades++;
        entry.pnl += o.profit ?? 0;
        byStrategy.set(key, entry);
      }
      json(res, 200, {
        mode,
        totalTrades: profits.length,
        wins: wins.length,
        losses: losses.length,
        netPnl: profits.reduce((a, b) => a + b, 0),
        winRate: profits.length ? wins.length / profits.length : 0,
        grossWin,
        grossLoss,
        profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
        expectancy: profits.length ? profits.reduce((a, b) => a + b, 0) / profits.length : 0,
        byStrategy: Array.from(byStrategy.entries()).map(([strategyId, v]) => ({ strategyId, ...v })),
      });
    })();
  });

  router.get("/api/verdicts", ({ res, url }: RequestContext) => {
    void (async () => {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);
      json(res, 200, { verdicts: await listVerdicts(limit) });
    })();
  });

  router.get("/api/notifications", ({ res, url }: RequestContext) => {
    void (async () => {
      const unreadOnly = url.searchParams.get("unread") === "true";
      json(res, 200, { notifications: await listNotifications(100, unreadOnly) });
    })();
  });

  router.post("/api/notifications/:id/read", ({ res, params }: RequestContext) => {
    void (async () => { await markNotificationRead(params.id!); json(res, 200, { ok: true }); })();
  });

  router.post("/api/notifications/read-all", ({ res }: RequestContext) => {
    void (async () => { await markAllNotificationsRead(); json(res, 200, { ok: true }); })();
  });

  router.get("/api/audit", ({ res, url }: RequestContext) => {
    void (async () => {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 200) || 200, 500);
      json(res, 200, { entries: await listAudit(limit) });
    })();
  });

  router.get("/api/settings/:key", ({ res, params }: RequestContext) => {
    void (async () => { json(res, 200, { key: params.key, value: await getSetting(params.key!) }); })();
  });

  router.put("/api/settings/:key", ({ res, params, body }: RequestContext) => {
    void (async () => { await setSetting(params.key!, body); json(res, 200, { ok: true }); })();
  });

  log.debug("engine routes registered", { env: config.env });
}
