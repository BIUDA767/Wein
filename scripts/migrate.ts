import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, closePool } from "@phirst/core";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "db", "migrations");

async function main(): Promise<void> {
  const pool = getPool();
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Set((await pool.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(migrationsDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      await client.query("COMMIT");
      ran++;
      process.stdout.write(JSON.stringify({ level: "info", msg: "migration applied", file }) + "\n");
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  process.stdout.write(JSON.stringify({ level: "info", msg: "migrations complete", applied: ran, total: files.length }) + "\n");
  await closePool();
}

main().catch(async (err) => {
  process.stderr.write(JSON.stringify({ level: "error", msg: "migrate failed", error: (err as Error).message }) + "\n");
  await closePool().catch(() => {});
  process.exit(1);
});
