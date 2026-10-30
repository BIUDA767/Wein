import { getPool, closePool, upsertStrategy, setActiveStrategy, BUILTIN_STRATEGIES, DEFAULT_RISK_CONFIG, setRiskConfig, setEngineState, getRiskConfig, listStrategies, setSetting } from "@phirst/core";

/** Seed built-in strategies, default risk config and engine state. Idempotent. */
async function main(): Promise<void> {
  const pool = getPool();

  for (const s of BUILTIN_STRATEGIES) {
    await upsertStrategy({
      id: s.id,
      name: s.name,
      description: s.description,
      params: s.defaultParams,
      enabled: true,
      builtin: true,
    });
  }

  const existing = await listStrategies();
  const active = existing.find((s) => s.is_active === true);
  if (!active) await setActiveStrategy("trend_ema");

  // Only install the default risk config if none has been saved yet.
  const current = await getRiskConfig();
  if (JSON.stringify(current) === JSON.stringify(DEFAULT_RISK_CONFIG)) {
    await setRiskConfig(DEFAULT_RISK_CONFIG);
  }

  const state = await pool.query<{ state: string }>("SELECT state FROM engine_state WHERE id = 1");
  if (state.rowCount === 0) await setEngineState("stopped", "paper", null);

  // Defaults for voice and notifications. Values only set when absent.
  const defaults: Record<string, unknown> = {
    voice: { enabled: true, voice: "female", accent: "ja-JP-inspired", rate: 1, pitch: 1, pushToTalk: true, handsFree: false, autoSpeakAlerts: true },
    notifications: { desktop: true, voice: true, telegram: false, proactive: true },
    avatar: { enabled: true, style: "japanese-inspired", floating: true },
  };
  for (const [key, value] of Object.entries(defaults)) {
    const res = await pool.query("SELECT 1 FROM app_settings WHERE key = $1", [key]);
    if (res.rowCount === 0) await setSetting(key, value);
  }

  process.stdout.write(
    JSON.stringify({ level: "info", msg: "seed complete", strategies: BUILTIN_STRATEGIES.length }) + "\n",
  );
  await closePool();
}

main().catch(async (err) => {
  process.stderr.write(JSON.stringify({ level: "error", msg: "seed failed", error: (err as Error).message }) + "\n");
  await closePool().catch(() => {});
  process.exit(1);
});
