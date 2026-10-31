import {
  Vault,
  evaluateRisk,
  currentExposure,
  lossStreakBreached,
  validateTrade,
  DEFAULT_VALIDATION_LIMITS,
  drawdownFromEquity,
  snapshot,
  resolveStrategy,
  dailyRealizedPnl,
  consecutiveLosses,
  equityPeak,
  recordEquity,
  listEquity,
  listPositions,
  listOpenOrders,
  listSettledOrders,
  listOrders,
  getRiskConfig,
  getEngineState,
  setEngineState,
  getActiveStrategy,
  insertVerdict,
  insertNotification,
  audit,
  acquireLeaderLock,
  releaseLeaderLock,
  holdsLeaderLock,
  getPlatformFlag,
  getSetting,
  setSetting,
  insertProposal,
  listPendingProposals,
  listProposals,
  getProposal,
  claimProposal,
  rejectProposal,
  attachProposalOrder,
  expireStaleProposals,
  expireAllPendingProposals,
  type EngineState,
  type RiskContext,
  type StrategySignal,
  type TradeIntent,
  type TradeMode,
  type TradingMode,
  type TradeProposal,
  type AgentVerdict,
  type Candle,
  type Quote,
  type Logger,
} from "@phirst/core";
import { GeminiClient, runAgentPanel, evaluateProactiveAlerts, type AgentContext, type TradeHistoryStats, type PhirstFacts } from "@phirst/ai";
import { BrokerManager, type ActiveBroker } from "./broker-manager.ts";
import { MarketDataService, resolveMarketDataProvider, BrokerMarketDataProvider } from "@phirst/marketdata";
import type { MarketDataProvider } from "@phirst/marketdata";
import { executeIntent, settleOpenOrders, reconcile, type ExecutionDeps } from "./execution.ts";

export interface EngineOptions {
  vault: Vault;
  log: Logger;
  paperStartingBalance: number;
  gemini: GeminiClient;
  tickMs?: number;
  /** Contract duration used when a strategy does not set one. */
  tickSeconds?: number;
  symbol: string;
  granularitySec: number;
  candleCount: number;
  autoTrade: boolean;
  /** How much authority PHIRST2 has. Enforced by the engine, not the UI. */
  tradingMode?: TradingMode;
  /**
   * Optional market-data provider, separate from the execution broker. When present it
   * supplies quotes and candles; when absent the broker's own feed is used.
   */
  marketData?: MarketDataProvider | null;
  /** Which provider the owner prefers, when a market-data provider is configured. */
  marketDataProviderId?: "deriv" | "twelve_data";
  /**
   * Deadline for the one LLM call on the decision path. The agent panel is advisory, so a
   * slow or rate-limited model must never hold the trading loop open for its full timeout.
   */
  llmTimeoutMs?: number;
}

export interface EngineSnapshot {
  state: EngineState;
  mode: TradeMode;
  /** manual | approval | autonomous. Distinct from `mode` (paper vs live). */
  tradingMode: TradingMode;
  reason: string | null;
  symbol: string;
  equity: number;
  balance: number;
  unrealized: number;
  dailyPnl: number;
  drawdown: number;
  openTrades: number;
  consecutiveLosses: number;
  lastSignal: StrategySignal | null;
  lastVerdicts: AgentVerdict[];
  brokerConnected: boolean;
  brokerName: string | null;
  activeStrategyId: string | null;
  lastPrice: number | null;
  emergencyStop: boolean;
  /** Pending approval-mode proposals awaiting the owner. */
  pendingProposals: TradeProposal[];
  updatedAt: string;
}

/**
 * The trading engine. It runs independently of the frontend and is governed only by
 * its persisted running state and the emergency stop flag.
 *
 * Order of operations on every tick:
 *   1. Settle expired contracts.
 *   2. Recompute equity and risk context.
 *   3. If running, evaluate the strategy and run the agent panel.
 *   4. Apply the risk engine's veto and size.
 *   5. Place at most one order, never resubmitting on ambiguity.
 */
export class TradingEngine {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private state: EngineState = "stopped";
  private mode: TradeMode = "paper";
  private tradingMode: TradingMode = "manual";
  private reason: string | null = null;
  private broker: BrokerManager;
  private market: MarketDataService | null = null;
  private active: ActiveBroker | null = null;
  private lastSignal: StrategySignal | null = null;
  private lastVerdicts: AgentVerdict[] = [];
  private lastPrice: number | null = null;
  private brokerConnected = false;
  private brokerError: string | null = null;
  private equity = 0;
  private balance = 0;
  private unrealized = 0;
  private dailyPnl = 0;
  private drawdown = 0;
  private lossStreak = 0;
  private openTrades = 0;
  private lastAlertKeys = new Set<string>();
  private consecutiveFailures = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private leader: number | null = null;
  private lastConnectivityCheck = 0;

  constructor(private opts: EngineOptions) {
    this.broker = new BrokerManager(opts.vault, opts.log, opts.paperStartingBalance);
    this.tradingMode = opts.tradingMode ?? "manual";
  }

  async init(): Promise<void> {
    const persisted = await getEngineState();
    this.state = persisted.state as EngineState;
    this.mode = persisted.mode;
    this.reason = persisted.reason;
    // The trading authority is persisted separately from the running state, so a
    // restart restores exactly the authority the owner last set — never wider.
    const savedMode = await getSetting<TradingMode>("tradingMode");
    if (savedMode === "manual" || savedMode === "approval" || savedMode === "autonomous") {
      this.tradingMode = savedMode;
    }
    if (this.state === "running") {
      // A restart must not silently resume trading.
      this.state = "paused";
      this.reason = "Engine restarted; resume to continue trading.";
      await setEngineState("paused", this.mode, this.reason);
    }
    await this.refreshBroker();
    await this.refreshStats();
    await this.refreshPrice();
    // init() also runs when the broker set changes. Acquiring again would fail against
    // this process's own first connection and clear a lock we already hold, so only
    // claim it when we do not have it yet.
    if (this.leader === null) {
      this.leader = await acquireLeaderLock();
      if (this.leader === null) {
        this.opts.log.warn("another engine instance holds the leader lock; this instance will not place orders");
      }
    }
    this.startHeartbeat();
    this.opts.log.info("engine initialised", { state: this.state, mode: this.mode, equity: this.equity, leader: this.leader });
  }

  private async refreshBroker(): Promise<void> {
    try {
      this.active = await this.broker.reload(this.mode);
      if (!this.active) {
        this.brokerConnected = false;
        this.brokerError = "No active broker configured.";
        this.market = null;
        return;
      }
      // Market data is served by the configured provider when one is set, and by the
      // broker's own feed otherwise. Order execution always stays with the broker.
      const brokerFeed = new BrokerMarketDataProvider(this.active.adapter, this.active.broker.label);
      const provider = resolveMarketDataProvider({
        preferred: this.opts.marketDataProviderId ?? "deriv",
        twelveData: this.opts.marketData ?? null,
        brokerFeed,
        log: this.opts.log,
      });
      if (!this.market) this.market = new MarketDataService(provider, this.opts.log);
      else this.market.setProvider(provider);
      const check = await this.active.adapter.verifyConnection();
      this.brokerConnected = check.ok;
      this.brokerError = check.ok ? null : check.message;
      if (!check.ok) {
        this.opts.log.warn("broker verification failed", { message: check.message, provider: this.active.broker.provider });
      }
    } catch (err) {
      this.brokerConnected = false;
      this.brokerError = (err as Error).message;
      this.opts.log.error("broker refresh failed", { error: (err as Error).message });
    }
  }

  async start(): Promise<{ ok: boolean; message: string }> {
    // The emergency stop is persistent and must be cleared deliberately with
    // resetEmergency(). Starting must never double as an implicit reset, or the UI's
    // Start/Resume button would silently re-arm trading after an emergency stop.
    if (this.state === "emergency") {
      return { ok: false, message: "Emergency stop is engaged. Reset it before starting." };
    }
    await this.refreshBroker();
    if (!this.active) return { ok: false, message: "Configure a broker before starting the engine." };
    if (!this.market) return { ok: false, message: "Market data is unavailable." };
    try {
      const candles = await this.market.candles(this.opts.symbol, this.opts.granularitySec, 30);
      if (candles.length < 10) return { ok: false, message: `Not enough market data for ${this.opts.symbol}.` };
    } catch (err) {
      return { ok: false, message: `Market data unavailable: ${(err as Error).message}` };
    }
    if (this.mode === "live") {
      const check = await this.active.adapter.verifyConnection();
      if (!check.ok) return { ok: false, message: `Live trading blocked: ${check.message}` };
      if (!this.active.account || this.active.account.account_type !== "real") {
        return { ok: false, message: "Live trading requires an active real-money account." };
      }
    }
    this.state = "running";
    this.reason = null;
    await setEngineState(this.state, this.mode, this.reason);
    await audit({ actor: "system", action: "engine.start", detail: { mode: this.mode, symbol: this.opts.symbol } });
    this.opts.log.info("engine started", { mode: this.mode, symbol: this.opts.symbol });
    this.schedule();
    return { ok: true, message: `Engine running in ${this.mode} mode on ${this.opts.symbol}.` };
  }

  async pause(reason = "Paused by user."): Promise<{ ok: boolean; message: string }> {
    // Pause and stop must not clear a live emergency stop. Only resetEmergency() does,
    // so an accidental Pause/Stop click cannot quietly re-arm trading.
    if (this.state === "emergency") {
      return { ok: false, message: "Emergency stop is engaged. Reset it before pausing." };
    }
    this.state = "paused";
    this.reason = reason;
    await setEngineState(this.state, this.mode, reason);
    await audit({ actor: "user", action: "engine.pause", detail: { reason } });
    this.stopTimer();
    this.opts.log.info("engine paused", { reason });
    return { ok: true, message: "Engine paused." };
  }

  async resume(): Promise<{ ok: boolean; message: string }> {
    if (this.state === "emergency") return { ok: false, message: "Emergency stop is engaged. Reset it before resuming." };
    return this.start();
  }

  async stop(reason = "Stopped by user."): Promise<{ ok: boolean; message: string }> {
    if (this.state === "emergency") {
      return { ok: false, message: "Emergency stop is engaged. Reset it before stopping." };
    }
    this.state = "stopped";
    this.reason = reason;
    await setEngineState(this.state, this.mode, reason);
    await audit({ actor: "user", action: "engine.stop", detail: { reason } });
    this.stopTimer();
    this.opts.log.info("engine stopped", { reason });
    return { ok: true, message: "Engine stopped." };
  }

  /** Persistent, backend-enforced emergency stop. Checked before every order. */
  async emergencyStop(reason = "Emergency stop engaged by user."): Promise<void> {
    this.state = "emergency";
    this.reason = reason;
    await setEngineState("emergency", this.mode, reason);
    await insertNotification({ severity: "critical", title: "Emergency stop engaged", body: reason, category: "risk" });
    await audit({ actor: "user", action: "engine.emergency_stop", detail: { reason } });
    this.stopTimer();
    this.opts.log.error("EMERGENCY STOP", { reason });
  }

  async resetEmergency(): Promise<{ ok: boolean; message: string }> {
    if (this.state !== "emergency") return { ok: false, message: "Emergency stop is not engaged." };
    this.state = "paused";
    this.reason = "Emergency stop cleared; engine paused.";
    await setEngineState("paused", this.mode, this.reason);
    await audit({ actor: "user", action: "engine.reset_emergency" });
    return { ok: true, message: "Emergency stop cleared. The engine is paused; resume when ready." };
  }

  /**
   * Switch trading mode. Paper -> live is a deliberate, confirmed action.
   * The engine is stopped as part of the switch.
   */
  async setMode(mode: TradeMode, confirmation?: string): Promise<{ ok: boolean; message: string }> {
    // A mode switch ends in `stopped`, so allowing it during an emergency would clear the
    // stop through a side door. The emergency stop stays sticky until it is reset.
    if (this.state === "emergency") {
      return { ok: false, message: "Emergency stop is engaged. Reset it before changing the trading mode." };
    }
    if (mode === "live") {
      if (confirmation !== "ENABLE LIVE TRADING") {
        return { ok: false, message: 'Live trading requires the exact confirmation phrase "ENABLE LIVE TRADING".' };
      }
      // The owner's global master switch. When it is off, no account on the platform can
      // go live, regardless of that account's own settings. Only the owner can change it.
      const globallyEnabled = await getPlatformFlag<boolean>("liveTradingEnabled", false);
      if (!globallyEnabled) {
        return {
          ok: false,
          message: "Live trading is disabled platform-wide by the owner. It must be enabled before any account can go live.",
        };
      }
      if (this.mode === "live") return { ok: true, message: "Already in live mode." };
      if (!this.active) return { ok: false, message: "Configure and verify a broker before enabling live trading." };
      const check = await this.active.adapter.verifyConnection();
      if (!check.ok) return { ok: false, message: `Live trading blocked: ${check.message}` };
      if (!this.active.account || this.active.account.account_type !== "real") {
        return { ok: false, message: "Live trading requires an active real-money account." };
      }
      const caps = this.active.adapter.capabilities();
      if (!caps.liveAccounts) return { ok: false, message: "This broker adapter does not support live accounts." };
    }
    await this.stop(`Mode changed to ${mode}.`);
    this.mode = mode;
    await setEngineState("stopped", this.mode, `Mode set to ${mode}.`);
    await audit({ actor: "user", action: "engine.set_mode", detail: { mode } });
    this.opts.log.warn("trading mode changed", { mode });
    return { ok: true, message: `Trading mode is now ${mode}. The engine is stopped; start it when ready.` };
  }

  private schedule(): void {
    this.stopTimer();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.opts.tickMs ?? 1000);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * A slow heartbeat that keeps account state current even while the engine is
   * stopped. Without it a stopped engine would report a stale zero equity, and the
   * companion would repeat that stale number.
   *
   * It also settles expired contracts. A manual order can be placed while the engine
   * is stopped, and a contract that has expired must still resolve; otherwise it stays
   * open forever and the books are wrong. Settlement never opens a new trade.
   */
  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      void (async () => {
        try {
          await this.settleExpired();
          await this.refreshStats();
          await this.refreshPrice();
          await this.sweepProposals();
        } catch (err) {
          this.opts.log.debug("heartbeat failed", { error: (err as Error).message });
        }
      })();
    }, 15_000);
  }

  /**
   * Settle any expired contracts, regardless of running state. Runs on the heartbeat
   * and on every tick. Safe to call concurrently: settlement only reads broker state
   * and writes the final result, so a repeat settles nothing new.
   */
  private async settleExpired(): Promise<void> {
    if (!this.active) return;
    try {
      const settled = await settleOpenOrders(this.execDeps());
      if (settled.length > 0) {
        this.opts.log.info("contracts settled", { count: settled.length });
        await this.refreshStats();
        await this.enforceLossStreak();
      }
    } catch (err) {
      this.opts.log.debug("settlement sweep failed", { error: (err as Error).message });
    }
  }

  /**
   * Pause when the losing streak reaches the configured limit. The risk engine already
   * de-risks each trade after a loss; this is the separate stop the owner configures, and
   * without it the setting would be inert. It fires only while running and never resumes
   * on its own — the owner resumes deliberately, as with every other halt.
   */
  private async enforceLossStreak(): Promise<void> {
    if (this.state !== "running" || this.lossStreak <= 0) return;
    const risk = await getRiskConfig();
    if (lossStreakBreached(this.lossStreak, risk.consecutiveLossLimit)) {
      await this.pause(
        `Paused: ${this.lossStreak} consecutive losses reached the configured limit of ${risk.consecutiveLossLimit}.`,
      );
      await insertNotification({
        severity: "warning",
        title: "Paused after a losing streak",
        body: `${this.lossStreak} consecutive losing trades reached the limit of ${risk.consecutiveLossLimit}. The engine is paused; review the strategy before resuming.`,
        category: "risk",
        meta: { lossStreak: this.lossStreak, limit: risk.consecutiveLossLimit },
      });
    }
  }

  async shutdown(): Promise<void> {
    this.stopTimer();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.leader !== null) {
      await releaseLeaderLock(this.leader).catch(() => {});
      this.leader = null;
    }
    await this.broker.close();
  }

  private execDeps(): ExecutionDeps {
    return {
      log: this.opts.log,
      adapter: this.active!.adapter,
      brokerId: this.active!.broker.id,
      accountId: String(this.active!.account?.account_id ?? "default"),
      mode: this.mode,
    };
  }

  /**
   * Re-verify broker connectivity while running. On a loss, new trades are blocked and
   * BAELAY is alerted; on recovery, real positions and pending orders are reconciled
   * before trading resumes. A paper broker always verifies, so this never blocks paper
   * trading. The check is throttled so it does not hammer the provider.
   */
  private async checkConnectivity(): Promise<void> {
    if (!this.active) return;
    const now = Date.now();
    if (now - this.lastConnectivityCheck < 5000) return;
    this.lastConnectivityCheck = now;
    let ok = false;
    let message = "";
    try {
      const check = await this.active.adapter.verifyConnection();
      ok = check.ok;
      message = check.message;
    } catch (err) {
      ok = false;
      message = (err as Error).message;
    }
    if (!ok && this.brokerConnected) {
      this.brokerConnected = false;
      this.brokerError = message;
      this.opts.log.error("broker connection lost; new trades are blocked", { message });
      await insertNotification({
        severity: "critical",
        title: "Broker connection lost",
        body: `New trades are blocked until connectivity is restored. ${message}`,
        category: "system",
      });
      await audit({ actor: "system", action: "broker.disconnected", detail: { message } });
    } else if (ok && !this.brokerConnected) {
      this.brokerConnected = true;
      this.brokerError = null;
      this.opts.log.warn("broker connection restored; reconciling before resuming");
      let reconciled: { brokerPositions: number; matched: number; resolved: number; unresolved: string[] } | null = null;
      try {
        reconciled = await reconcile(this.execDeps());
        this.opts.log.info("reconciled after reconnect", { ...reconciled });
      } catch (err) {
        this.opts.log.error("reconcile after reconnect failed", { error: (err as Error).message });
      }
      await insertNotification({
        severity: "info",
        title: "Broker connection restored",
        body: reconciled
          ? `Positions reconciled (${reconciled.matched} matched, ${reconciled.unresolved.length} unresolved). Trading may resume.`
          : "Connectivity restored. Trading may resume.",
        category: "system",
      });
      await audit({ actor: "system", action: "broker.reconnected" });
    }
  }

  // --- Main loop --------------------------------------------------------------

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.runTick();
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures++;
      this.opts.log.error("tick failed", { error: (err as Error).message, failures: this.consecutiveFailures });
      const rateLimited = /rate limit/i.test((err as Error).message);
      if (rateLimited) this.consecutiveFailures = 0;
      if (!rateLimited && this.consecutiveFailures >= 5) {
        await this.pause(`Paused after ${this.consecutiveFailures} consecutive errors: ${(err as Error).message}`);
        await insertNotification({
          severity: "critical",
          title: "Engine paused after repeated errors",
          body: `Five consecutive tick failures. Last error: ${(err as Error).message}`,
          category: "system",
        });
      }
    } finally {
      this.ticking = false;
    }
  }

  private async runTick(): Promise<void> {
    if (!this.active || !this.market) {
      await this.refreshBroker();
      if (!this.active || !this.market) return;
    }
    const deps = this.execDeps();

    // 1. Settle expired contracts.
    await this.settleExpired();

    // 2. Refresh account state and risk context, then re-verify connectivity. A lost
    //    connection blocks new trades but settlement continues, so open contracts still
    //    resolve once the broker is reachable again.
    await this.refreshStats();
    await this.refreshPrice();
    await this.checkConnectivity();

    if (this.state !== "running") return;

    // 3. Evaluate the strategy. A rate-limited or failed candle fetch is an expected
    //    condition, not a fault: fall back to the last good candles rather than
    //    counting it toward the consecutive-failure pause.
    let candles: Candle[];
    try {
      candles = await this.market.candles(this.opts.symbol, this.opts.granularitySec, this.opts.candleCount);
    } catch (err) {
      const cached = this.market.peek(this.opts.symbol, this.opts.granularitySec, this.opts.candleCount);
      if (!cached) {
        this.opts.log.debug("no candles available this tick", { error: (err as Error).message });
        return;
      }
      this.opts.log.debug("using cached candles", { error: (err as Error).message });
      candles = cached;
    }
    if (candles.length < 30) return;
    const indicators = snapshot(candles);
    const activeStrategyRow = await getActiveStrategy();
    if (!activeStrategyRow || activeStrategyRow.enabled !== true) {
      this.opts.log.debug("no enabled active strategy");
      return;
    }
    const strategy = resolveStrategy(String(activeStrategyRow.id), (activeStrategyRow.params ?? {}) as Record<string, unknown>);
    if (!strategy) {
      await this.pause(`Active strategy ${String(activeStrategyRow.id)} could not be resolved.`);
      return;
    }
    const signal = strategy.evaluate({ symbol: this.opts.symbol, candles, indicators, params: {} });
    this.lastSignal = signal;

    if (signal.direction === "flat") {
      this.lastVerdicts = [];
      return;
    }

    // 4. Build the proposed intent, then run the agent panel and the risk engine.
    const proposed: TradeIntent = {
      symbol: this.opts.symbol,
      side: signal.direction === "long" ? "buy" : "sell",
      orderType: "fixed_expiry",
      amount: await this.baseAmount(),
      durationSec: signal.durationSec ?? this.opts.tickSeconds ?? this.opts.granularitySec,
      strategyId: String(activeStrategyRow.id),
      rationale: signal.reasons.join(" "),
      origin: "engine",
      mode: this.mode,
    };

    const riskConfig = await getRiskConfig();
    const risk = evaluateRisk({ intent: proposed, config: riskConfig, context: await this.riskContext() });
    const caps = this.active.adapter.capabilities();
    const agentCtx: AgentContext = {
      symbol: this.opts.symbol,
      candles,
      indicators,
      signal,
      risk,
      equity: this.equity,
      openTradeCount: this.openTrades,
      history: await this.historyStats(),
      brokerConnected: this.brokerConnected,
      brokerCapabilities: { minExpirySec: caps.minExpirySec, fixedExpiry: caps.fixedExpiry, marketData: caps.marketData },
      requestedDurationSec: proposed.durationSec ?? null,
      llm: this.opts.gemini,
    };
    const panel = await runAgentPanel(agentCtx, { llmTimeoutMs: this.opts.llmTimeoutMs });
    this.lastVerdicts = panel.verdicts;
    await this.persistVerdicts(panel.verdicts, this.opts.symbol);

    // The risk engine holds final veto authority. The panel is advisory only.
    if (!risk.approved) {
      this.opts.log.debug("risk veto", { reasons: risk.reasons });
      await this.emitAlerts(panel.verdicts, risk.reasons);
      return;
    }
    if (!this.opts.autoTrade) {
      this.opts.log.debug("auto-trade disabled; signal only", { direction: signal.direction });
      await this.emitAlerts(panel.verdicts, []);
      return;
    }
    const executionVerdict = panel.verdicts.find((v) => v.agent === "execution_management");
    if (executionVerdict && !executionVerdict.supportive) {
      this.opts.log.debug("execution agent blocked the trade", { summary: executionVerdict.summary });
      return;
    }

    // The independent validation layer runs after the risk engine and before any
    // execution. It is pure and synchronous, so it adds no latency, and it is the
    // one place that can turn an otherwise-valid trade into a proposal or a block.
    const validation = validateTrade({
      intent: proposed,
      risk,
      verdicts: panel.verdicts,
      spreadFraction: await this.spreadFraction(),
      ordersLastHour: await this.ordersLastHour(),
      secondsSinceLastLoss: await this.secondsSinceLastLoss(),
      consecutiveLosses: this.lossStreak,
      minExpirySec: caps.minExpirySec,
      limits: DEFAULT_VALIDATION_LIMITS,
    });
    if (validation.outcome === "block") {
      this.opts.log.warn("validation blocked a trade", { reasons: validation.reasons });
      await insertNotification({
        severity: "warn",
        title: "Trade blocked by validation",
        body: validation.reasons.join(" "),
        category: "risk",
      });
      return;
    }

    // Do not stack a second identical position while one is already open. Without this
    // the loop would re-enter on every tick for as long as the signal held.
    const open = await listOpenOrders(this.mode);
    const sameDirectionOpen = open.some(
      (o) => o.symbol === this.opts.symbol && ((o.side === "buy" && signal.direction === "long") || (o.side === "sell" && signal.direction === "short")),
    );
    if (sameDirectionOpen) {
      this.opts.log.debug("signal held but an equivalent position is already open", { direction: signal.direction });
      return;
    }

    // Authority check. In manual mode the engine never places an autonomous order.
    // In approval mode it parks a concrete, risk-sized proposal for the owner. Only
    // in autonomous mode — and only when validation did not escalate — does it act.
    const approvedIntent = { ...proposed, amount: risk.approvedAmount };
    if (this.tradingMode === "manual") {
      this.opts.log.debug("manual mode: signal surfaced, not executed");
      return;
    }
    if (this.tradingMode === "approval" || validation.outcome === "escalate") {
      const proposal = await insertProposal({
        symbol: approvedIntent.symbol,
        side: approvedIntent.side,
        amount: approvedIntent.amount,
        durationSec: approvedIntent.durationSec ?? 0,
        strategyId: approvedIntent.strategyId ?? null,
        rationale: [
          approvedIntent.rationale ?? "",
          validation.outcome === "escalate" ? `Flagged: ${validation.reasons.join(" ")}` : "",
        ].filter(Boolean).join(" "),
        mode: this.mode,
        referencePrice: this.lastPrice,
        ttlSec: this.opts.tickSeconds ? Math.max(120, this.opts.tickSeconds * 4) : 300,
      });
      if (proposal) {
        await insertNotification({
          severity: "info",
          title: "Trade ready for your approval",
          body: `${approvedIntent.side.toUpperCase()} ${approvedIntent.symbol} for ${approvedIntent.amount.toFixed(2)}${validation.outcome === "escalate" ? ` — ${validation.reasons[0]}` : ""}.`,
          category: "phirst2",
          meta: { proposalId: proposal.id },
        });
      }
      this.opts.log.info("trade proposal queued", { side: approvedIntent.side, amount: approvedIntent.amount, escalated: validation.outcome === "escalate" });
      return;
    }

    // 5. Place exactly one order, sized by the risk engine. Never open a trade on a
    //    dead connection, and only the process holding the advisory leader lock may
    //    trade, so a stray second engine cannot duplicate it.
    if (!this.brokerConnected) {
      this.opts.log.debug("skipping order: broker is not connected");
      return;
    }
    if (!holdsLeaderLock(this.leader)) {
      this.opts.log.debug("skipping order: this process does not hold the engine leader lock");
      return;
    }
    if (this.mode === "live" && !(await getPlatformFlag<boolean>("liveTradingEnabled", false))) {
      this.opts.log.debug("skipping order: global live trading is disabled by the owner");
      return;
    }
    const order = await executeIntent(deps, { ...proposed, amount: risk.approvedAmount });
    this.opts.log.info("engine order submitted", { orderId: order.id, status: order.status, amount: risk.approvedAmount });
    await this.refreshStats();
  }

  /** Spread as a fraction of price, or null when the adapter does not publish one. */
  private async spreadFraction(): Promise<number | null> {
    if (!this.market) return null;
    const spread = await this.market.spread(this.opts.symbol);
    if (spread === null || this.lastPrice === null || this.lastPrice <= 0) return null;
    return spread / this.lastPrice;
  }

  /** Orders placed in the last hour, for abnormal-activity detection. */
  private async ordersLastHour(): Promise<number> {
    const rows = await listOrders(200, { mode: this.mode });
    const cutoff = Date.now() - 3_600_000;
    return rows.filter((r) => new Date(String(r.created_at)).getTime() >= cutoff).length;
  }

  /** Seconds since the most recent settled losing trade, or null when there is none. */
  private async secondsSinceLastLoss(): Promise<number | null> {
    const settled = await listSettledOrders(this.mode, 50);
    const lastLoss = settled.find((o) => (o.profit ?? 0) < 0);
    if (!lastLoss) return null;
    const at = lastLoss.settledAt ?? lastLoss.updatedAt;
    return Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
  }

  private async baseAmount(): Promise<number> {
    const risk = await getRiskConfig();
    const budget = this.equity > 0 ? this.equity * risk.riskPerTrade : risk.maxTradeAmount;
    return Math.min(budget, risk.maxTradeAmount);
  }

  private async refreshPrice(): Promise<void> {
    if (!this.market) return;
    try {
      this.lastPrice = (await this.market.quote(this.opts.symbol)).mid;
    } catch {
      /* keep the last known price; the UI shows its timestamp */
    }
  }

  private async refreshStats(): Promise<void> {
    if (!this.active) return;
    const accountId = String(this.active.account?.account_id ?? "default");
    let balance = Number(this.active.account?.balance ?? 0);
    try {
      const live = await this.active.adapter.getBalance(accountId);
      if (live !== null) balance = live;
    } catch {
      /* keep the persisted balance */
    }
    let positions: Array<Record<string, unknown>> = [];
    try {
      positions = await listPositions(this.mode);
    } catch {
      positions = [];
    }
    this.unrealized = positions.reduce((a, p) => a + Number(p.unrealized_pnl ?? 0), 0);
    this.balance = balance;
    this.equity = balance + this.unrealized;

    const sinceMidnight = new Date();
    sinceMidnight.setHours(0, 0, 0, 0);
    this.dailyPnl = await dailyRealizedPnl(this.mode, sinceMidnight);
    this.lossStreak = await consecutiveLosses(this.mode);
    this.openTrades = (await listOpenOrders(this.mode)).length;

    const peak = Math.max(await equityPeak(this.mode), this.equity);
    this.drawdown = peak > 0 ? (peak - this.equity) / peak : 0;
    await recordEquity(this.mode, this.equity, this.balance, this.unrealized);
  }

  private async riskContext(): Promise<RiskContext> {
    const risk = await getRiskConfig();
    // Exposure is the money actually at risk right now. For fixed-expiry contracts that
    // is the open orders, not the position table: the paper simulator and Deriv both
    // report open contracts as portfolio entries, so a position-based figure would read
    // zero while several contracts are live and the maxExposure ceiling would never bind.
    const [positions, openOrders] = await Promise.all([listPositions(this.mode), listOpenOrders(this.mode)]);
    const exposure = currentExposure(
      openOrders.map((o) => Number(o.amount ?? 0)),
      positions.map((p) => Number(p.size ?? 0)),
    );
    const lossToday = this.dailyPnl < 0 ? -this.dailyPnl : 0;
    const halted = this.state === "emergency" || lossToday >= risk.dailyLossLimit || this.drawdown >= risk.maxDrawdown;
    return {
      equity: this.equity,
      dailyPnl: this.dailyPnl,
      currentDrawdown: this.drawdown,
      openExposure: exposure,
      openTradeCount: this.openTrades,
      consecutiveLosses: this.lossStreak,
      tradingHalted: halted,
    };
  }

  private async historyStats(): Promise<TradeHistoryStats> {
    const rows = await listSettledOrders(this.mode, 200);
    const profits = rows.map((r) => r.profit ?? 0);
    const wins = profits.filter((p) => p > 0);
    const losses = profits.filter((p) => p < 0);
    const netPnl = profits.reduce((a, b) => a + b, 0);
    const grossWin = wins.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
    return {
      totalTrades: profits.length,
      wins: wins.length,
      losses: losses.length,
      netPnl,
      winRate: profits.length ? wins.length / profits.length : 0,
      avgWin: wins.length ? grossWin / wins.length : 0,
      avgLoss: losses.length ? grossLoss / losses.length : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
      expectancy: profits.length ? netPnl / profits.length : 0,
    };
  }

  private async persistVerdicts(verdicts: AgentVerdict[], symbol: string): Promise<void> {
    for (const v of verdicts) {
      await insertVerdict({
        agent: v.agent,
        supportive: v.supportive,
        confidence: v.confidence,
        summary: v.summary,
        detail: v.detail ?? null,
        source: v.source,
        symbol,
        correlationId: null,
      });
    }
  }

  /** Emit proactive alerts once per distinct trigger per session. */
  private async emitAlerts(verdicts: AgentVerdict[], riskReasons: string[]): Promise<void> {
    const alerts = evaluateProactiveAlerts(await this.phirstFacts(verdicts));
    for (const a of alerts) {
      const key = `${a.trigger}:${a.severity}`;
      if (this.lastAlertKeys.has(key)) continue;
      this.lastAlertKeys.add(key);
      await insertNotification({ severity: a.severity, title: a.title, body: a.body, category: "phirst2", meta: { trigger: a.trigger } });
      this.opts.log.warn("proactive alert", { trigger: a.trigger, severity: a.severity });
    }
    for (const reason of riskReasons) {
      const key = `risk:${reason}`;
      if (this.lastAlertKeys.has(key)) continue;
      this.lastAlertKeys.add(key);
      await insertNotification({ severity: "info", title: "Risk engine veto", body: reason, category: "risk" });
    }
  }

  async phirstFacts(verdicts?: AgentVerdict[]): Promise<PhirstFacts> {
    const risk = await getRiskConfig();
    const strategy = await getActiveStrategy();
    return {
      engineState: this.state,
      mode: this.mode,
      equity: this.equity,
      balance: this.balance,
      openTrades: this.openTrades,
      dailyPnl: this.dailyPnl,
      brokerConnected: this.brokerConnected,
      brokerName: this.active?.broker.label ?? null,
      activeStrategy: strategy ? String(strategy.name) : null,
      activeSymbol: this.opts.symbol,
      lastPrice: this.lastPrice,
      risk: {
        maxConcurrentTrades: risk.maxConcurrentTrades,
        dailyLossLimit: risk.dailyLossLimit,
        riskPerTrade: risk.riskPerTrade,
        maxDrawdown: risk.maxDrawdown,
      },
      recentVerdicts: verdicts ?? this.lastVerdicts,
      emergencyStop: this.state === "emergency",
    };
  }

  async snapshot(): Promise<EngineSnapshot> {
    const strategy = await getActiveStrategy();
    const equityRows = await listEquity(this.mode, 500);
    const series = equityRows.map((r) => Number(r.equity)).reverse();
    const drawdown = series.length > 1 ? drawdownFromEquity(series) : this.drawdown;
    const pendingProposals = await listPendingProposals();
    return {
      state: this.state,
      mode: this.mode,
      tradingMode: this.tradingMode,
      reason: this.reason,
      symbol: this.opts.symbol,
      equity: this.equity,
      balance: this.balance,
      unrealized: this.unrealized,
      dailyPnl: this.dailyPnl,
      drawdown,
      openTrades: this.openTrades,
      consecutiveLosses: this.lossStreak,
      lastSignal: this.lastSignal,
      lastVerdicts: this.lastVerdicts,
      brokerConnected: this.brokerConnected,
      brokerName: this.active?.broker.label ?? null,
      activeStrategyId: strategy ? String(strategy.id) : null,
      lastPrice: this.lastPrice,
      emergencyStop: this.state === "emergency",
      pendingProposals,
      updatedAt: new Date().toISOString(),
    };
  }

  /** Manual order entry from the UI or Telegram. Still passes through the risk engine. */
  async manualOrder(input: {
    side: "buy" | "sell";
    amount: number;
    durationSec: number;
    origin: "manual" | "telegram" | "agent";
    symbol?: string;
  }): Promise<{ ok: boolean; message: string; orderId?: string }> {
    if (this.state === "emergency") return { ok: false, message: "Emergency stop is engaged." };
    if (!this.active) return { ok: false, message: "No active broker configured." };
    const symbol = input.symbol ?? this.opts.symbol;
    const riskConfig = await getRiskConfig();
    const intent: TradeIntent = {
      symbol,
      side: input.side,
      orderType: "fixed_expiry",
      amount: input.amount,
      durationSec: input.durationSec,
      origin: input.origin,
      mode: this.mode,
    };
    const decision = evaluateRisk({ intent, config: riskConfig, context: await this.riskContext() });
    if (!decision.approved) {
      return { ok: false, message: `Risk engine vetoed the order: ${decision.reasons.join(" ")}` };
    }
    // The same independent validator that guards autonomous trades also guards manual
    // ones. The owner is present, so an "escalate" outcome is surfaced rather than
    // silently obeyed, but a "block" is a hard refusal on both paths.
    const validation = validateTrade({
      intent,
      risk: decision,
      verdicts: this.lastVerdicts,
      spreadFraction: await this.spreadFraction(),
      ordersLastHour: await this.ordersLastHour(),
      secondsSinceLastLoss: await this.secondsSinceLastLoss(),
      consecutiveLosses: this.lossStreak,
      minExpirySec: this.active.adapter.capabilities().minExpirySec,
      limits: DEFAULT_VALIDATION_LIMITS,
    });
    if (validation.outcome === "block") {
      return { ok: false, message: `Validation refused the order: ${validation.reasons.join(" ")}` };
    }
    const caps = this.active.adapter.capabilities();
    if (caps.minExpirySec !== null && input.durationSec < caps.minExpirySec) {
      return { ok: false, message: `Duration ${input.durationSec}s is below the broker minimum of ${caps.minExpirySec}s.` };
    }
    if (!this.brokerConnected && this.mode === "live") {
      return { ok: false, message: "Broker is not connected; live orders are blocked." };
    }
    if (this.mode === "live" && !(await getPlatformFlag<boolean>("liveTradingEnabled", false))) {
      return { ok: false, message: "Live trading is disabled platform-wide by the owner." };
    }
    const deps = this.execDeps();
    if (!holdsLeaderLock(this.leader)) {
      return { ok: false, message: "This engine instance is not the active trading leader; the order was not placed." };
    }
    const order = await executeIntent(deps, { ...intent, amount: decision.approvedAmount });
    await this.refreshStats();
    if (order.status === "rejected") return { ok: false, message: order.error ?? "Order rejected.", orderId: order.id };
    if (order.status === "unknown") {
      return {
        ok: false,
        message: "Broker response was ambiguous. The order is recorded and will be reconciled; it will not be resubmitted.",
        orderId: order.id,
      };
    }
    return { ok: true, message: `Order ${order.status}.`, orderId: order.id };
  }

  getStatus(): { state: EngineState; mode: TradeMode; brokerConnected: boolean; brokerError: string | null } {
    return { state: this.state, mode: this.mode, brokerConnected: this.brokerConnected, brokerError: this.brokerError };
  }

  setAutoTrade(enabled: boolean): void {
    this.opts.autoTrade = enabled;
  }

  getTradingMode(): TradingMode {
    return this.tradingMode;
  }

  /**
   * Change how much authority PHIRST2 has. This is enforced by the backend; the UI only
   * reflects it. The transition is made safe deliberately:
   *   - it is refused while the engine is mid-trade (running), so no order is duplicated
   *     or left half-placed across the change; the owner pauses first;
   *   - leaving approval mode expires every pending proposal, so a decision the owner
   *     never made cannot be executed later;
   *   - the new mode is persisted before it takes effect, so a crash mid-change restores
   *     the previous, safer value rather than a half-applied one.
   */
  async setTradingMode(mode: TradingMode): Promise<{ ok: boolean; message: string }> {
    if (mode === this.tradingMode) return { ok: true, message: `Trading mode is already ${mode}.` };
    if (this.state === "running") {
      return { ok: false, message: "Pause the engine before changing trading mode, so no order is caught mid-flight." };
    }
    const previous = this.tradingMode;
    try {
      await setSetting("tradingMode", mode);
    } catch (err) {
      // Persist failed: keep the previous mode rather than applying an unrecorded change.
      return { ok: false, message: `Could not persist the new trading mode: ${(err as Error).message}. The mode is unchanged (${previous}).` };
    }
    this.tradingMode = mode;
    if (previous === "approval" && mode !== "approval") {
      const expired = await expireAllPendingProposals(`Trading mode changed to ${mode}.`);
      if (expired > 0) {
        await insertNotification({
          severity: "info",
          title: "Pending proposals cleared",
          body: `${expired} pending proposal(s) expired because the trading mode changed to ${mode}.`,
          category: "phirst2",
        });
      }
    }
    await audit({ actor: "user", action: "engine.set_trading_mode", detail: { from: previous, to: mode } });
    await insertNotification({
      severity: "info",
      title: `Trading mode: ${mode}`,
      body: mode === "autonomous"
        ? "PHIRST2 may execute qualifying trades within your risk limits."
        : mode === "approval"
          ? "PHIRST2 will prepare trades for your approval before executing."
          : "PHIRST2 will analyse and recommend only; you execute.",
      category: "phirst2",
    });
    this.opts.log.warn("trading authority changed", { from: previous, to: mode });
    return { ok: true, message: `Trading mode is now ${mode}.` };
  }

  /** Approve a pending proposal and execute exactly what it describes, once. */
  async approveProposal(id: string): Promise<{ ok: boolean; message: string; orderId?: string }> {
    if (this.state === "emergency") return { ok: false, message: "Emergency stop is engaged." };
    const existing = await getProposal(id);
    if (!existing) return { ok: false, message: "Proposal not found." };
    if (existing.status !== "pending") return { ok: false, message: `Proposal is already ${existing.status}.` };
    if (new Date(existing.expiresAt).getTime() < Date.now()) {
      return { ok: false, message: "Proposal has expired. Ask PHIRST2 for a fresh one." };
    }
    // Claim it first: only a still-pending proposal can be claimed, so a double tap or
    // two owners cannot both execute it.
    const claimed = await claimProposal(id);
    if (!claimed) return { ok: false, message: "Proposal was already decided." };

    const result = await this.manualOrder({
      side: claimed.side,
      amount: claimed.amount,
      durationSec: claimed.durationSec,
      origin: "manual",
      symbol: claimed.symbol,
    });
    if (result.orderId) await attachProposalOrder(claimed.id, result.orderId);
    await audit({ actor: "user", action: "proposal.approve", target: id, detail: { ok: result.ok, orderId: result.orderId ?? null } });
    return result;
  }

  async rejectProposalById(id: string): Promise<{ ok: boolean; message: string }> {
    const done = await rejectProposal(id);
    await audit({ actor: "user", action: "proposal.reject", target: id, detail: { ok: done } });
    return done ? { ok: true, message: "Proposal rejected." } : { ok: false, message: "Proposal was already decided." };
  }

  /** Drop stale proposals. Called on the heartbeat so expired ones do not linger. */
  private async sweepProposals(): Promise<void> {
    if (this.tradingMode !== "approval" || this.lastPrice === null) return;
    const n = await expireStaleProposals(1.5, this.lastPrice);
    if (n > 0) this.opts.log.info("expired stale proposals", { count: n });
  }

  setSymbol(symbol: string): void {
    this.opts.symbol = symbol;
    this.market?.invalidate();
  }

  /**
   * Re-read the owner's market-data preference and rebuild the provider in place. The
   * preference is persisted by the integrations route, but the engine holds its own copy
   * in `opts`; without this the switch would be recorded and never applied.
   */
  async applyMarketDataProvider(): Promise<void> {
    const saved = await getSetting<string>("marketDataProvider");
    this.opts.marketDataProviderId = saved === "twelve_data" ? "twelve_data" : "deriv";
    await this.refreshBroker();
  }

  /** Force a reconciliation pass, e.g. after reconnecting. */
  async forceReconcile(): Promise<Awaited<ReturnType<typeof reconcile>> | null> {
    if (!this.active) return null;
    return reconcile({
      log: this.opts.log,
      adapter: this.active.adapter,
      brokerId: this.active.broker.id,
      accountId: String(this.active.account?.account_id ?? "default"),
      mode: this.mode,
    });
  }

  /** Load candles for the chart without going through the strategy path. */
  async candles(symbol: string, granularitySec: number, count: number): Promise<Candle[]> {
    if (!this.market) await this.refreshBroker();
    if (!this.market) throw new Error("Market data is unavailable.");
    return this.market.candles(symbol, granularitySec, count);
  }

  /** A single live quote for an arbitrary symbol, from the active market-data provider. */
  async quote(symbol: string): Promise<Quote> {
    if (!this.market) await this.refreshBroker();
    if (!this.market) throw new Error("Market data is unavailable.");
    return this.market.quote(symbol);
  }

  /** Live quotes for several symbols, tolerating per-symbol failure rather than all-or-nothing. */
  async quotes(symbols: string[]): Promise<Record<string, Quote | null>> {
    const out: Record<string, Quote | null> = {};
    await Promise.all(
      symbols.map(async (s) => {
        try {
          out[s] = await this.quote(s);
        } catch {
          out[s] = null;
        }
      }),
    );
    return out;
  }

  async instruments() {
    if (!this.market) await this.refreshBroker();
    if (!this.market) return [];
    return this.market.instruments();
  }
}
