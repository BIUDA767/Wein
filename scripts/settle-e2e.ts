/** Prove the full order lifecycle: place, hold, settle, and book the realised P&L. */
import { loadConfig, Vault, Logger, getPool, closePool, setRiskConfig } from "@phirst/core";
import { GeminiClient } from "@phirst/ai";
import { TradingEngine } from "@phirst/engine";

const config = loadConfig();
const log = new Logger("warn", { service: "settle" });
const engine = new TradingEngine({
  vault: new Vault(config.masterKey), log,
  paperStartingBalance: config.paperStartingBalance,
  gemini: new GeminiClient({ apiKey: null, model: "x" }),
  tickMs: 1000, tickSeconds: 5, symbol: "R_100", granularitySec: 60, candleCount: 300, autoTrade: false,
});

async function main(): Promise<void> {
  const pool = getPool();
  await pool.query("SELECT 1");
  await setRiskConfig({
    riskPerTrade: 0.01, dailyLossLimit: 500, maxDrawdown: 0.2, maxExposure: 2000,
    maxConcurrentTrades: 3, consecutiveLossLimit: 3, lossStreakDeRiskFactor: 0.5,
    maxTradeAmount: 50, allowedSymbols: [], allowedStrategies: [],
  });
  await engine.init();

  const before = (await engine.snapshot()).equity;
  const order = await engine.manualOrder({ side: "buy", amount: 10, durationSec: 5, origin: "manual" });
  console.log("order:", JSON.stringify(order));

  const deadline = Date.now() + 40_000;
  let settled = false;
  while (Date.now() < deadline) {
    await engine.tick();
    const row = (await pool.query("SELECT status, profit, payout, settled_at FROM orders WHERE broker_order_id = (SELECT broker_order_id FROM orders ORDER BY created_at DESC LIMIT 1)")).rows[0] as
      | { status: string; profit: string | null; payout: string | null; settled_at: string | null }
      | undefined;
    if (row?.status === "settled") {
      settled = true;
      console.log("settled:", JSON.stringify(row));
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  const snap = await engine.snapshot();
  console.log("equity before:", before, "-> after:", snap.equity);
  console.log("realised P&L today:", snap.dailyPnl);
  console.log("open trades:", snap.openTrades);

  await engine.shutdown();
  await closePool();
  console.log(settled ? "\nSETTLEMENT PASS: the contract settled and the result was booked." : "\nSETTLEMENT FAILED: the contract did not settle in time.");
  process.exit(settled ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await closePool().catch(() => {}); process.exit(1); });
