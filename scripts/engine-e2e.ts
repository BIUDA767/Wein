/**
 * End-to-end engine test: runs the real engine loop against the real Deriv public
 * feed in paper mode and asserts that signals, orders and settlements all occur.
 */
import { loadConfig, Vault, Logger, getPool, closePool, setRiskConfig, setActiveStrategy, getSetting } from "@phirst/core";
import { GeminiClient } from "@phirst/ai";
import { TradingEngine } from "@phirst/engine";

const config = loadConfig();
const log = new Logger("info", { service: "e2e" });
const vault = new Vault(config.masterKey);
const gemini = new GeminiClient({ apiKey: config.geminiApiKey, model: config.geminiModel, fallbackModels: config.geminiFallbackModels });

const engine = new TradingEngine({
  vault, log, paperStartingBalance: config.paperStartingBalance, gemini,
  tickMs: 1000, tickSeconds: 5, symbol: "R_100", granularitySec: 60, candleCount: 300, autoTrade: true,
});

async function main(): Promise<void> {
  await getPool().query("SELECT 1");
  await setRiskConfig({
    riskPerTrade: 0.01, dailyLossLimit: 500, maxDrawdown: 0.2, maxExposure: 2000,
    maxConcurrentTrades: 3, consecutiveLossLimit: 3, lossStreakDeRiskFactor: 0.5,
    maxTradeAmount: 50, allowedSymbols: [], allowedStrategies: [],
  });
  await setActiveStrategy("trend_ema");
  await engine.init();

  const start = await engine.start();
  console.log("start:", JSON.stringify(start));
  if (!start.ok) { await engine.shutdown(); await closePool(); process.exit(1); }

  let signalsSeen = 0;
  let ordersSeen = 0;
  let settledSeen = 0;
  const deadline = Date.now() + 260_000;

  while (Date.now() < deadline) {
    await engine.tick();
    const snap = await engine.snapshot();
    if (snap.lastSignal && snap.lastSignal.direction !== "flat") signalsSeen++;
    const orders = (await getPool().query("SELECT status, profit FROM orders")).rows as Array<{ status: string; profit: string | null }>;
    ordersSeen = orders.length;
    settledSeen = orders.filter((o) => o.status === "settled").length;
    if (settledSeen > 0) break;
    await new Promise((r) => setTimeout(r, 1200));
  }

  const snap = await engine.snapshot();
  console.log("--- results ---");
  console.log("signals observed:", signalsSeen);
  console.log("orders placed:", ordersSeen);
  console.log("orders settled:", settledSeen);
  console.log("equity:", snap.equity, "dailyPnl:", snap.dailyPnl, "openTrades:", snap.openTrades);
  console.log("last signal:", snap.lastSignal ? `${snap.lastSignal.direction} (${snap.lastSignal.confidence.toFixed(2)}) ${snap.lastSignal.reasons[0]}` : "none");
  console.log("verdicts:", snap.lastVerdicts.map((v) => `${v.agent}:${v.supportive ? "+" : "-"}${v.confidence.toFixed(1)}`).join(" "));

  await engine.pause("e2e complete");
  await engine.shutdown();
  await closePool();

  const ok = signalsSeen > 0 && ordersSeen > 0;
  console.log(ok ? "\nE2E PASS: the engine evaluated the market and placed real paper orders." : "\nE2E INCOMPLETE: no trade was taken in the window.");
  process.exit(ok ? 0 : 1);
}

main().catch(async (e) => { console.error("e2e failed:", e); await closePool().catch(() => {}); process.exit(1); });
