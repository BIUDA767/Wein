import { getPool, closePool, setEngineState } from "@phirst/core";

/** Development helper: clear trading state so tests and demos start clean. */
async function main(): Promise<void> {
  const pool = getPool();
  await pool.query("TRUNCATE orders, positions, equity_snapshots, agent_verdicts, notifications, audit_log RESTART IDENTITY");
  await setEngineState("stopped", "paper", "Reset by reset-dev script.");
  process.stdout.write(JSON.stringify({ level: "info", msg: "dev state reset" }) + "\n");
  await closePool();
}
main().catch(async (e) => { process.stderr.write(String(e) + "\n"); await closePool().catch(() => {}); process.exit(1); });
