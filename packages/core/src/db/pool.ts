import pg from "pg";

const { Pool } = pg;
export type Row = Record<string, unknown>;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new Pool({
      connectionString,
      max: Number(process.env.PHIRST_DB_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: "phirst2",
    });
    pool.on("error", (err) => {
      process.stderr.write(JSON.stringify({ level: "error", msg: "pg pool error", error: err.message }) + "\n");
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function query<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await getPool().query(text, params);
  return res.rows as T[];
}

export async function queryOne<T = Row>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function exec(text: string, params: unknown[] = []): Promise<void> {
  await getPool().query(text, params);
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* rollback failure is secondary to the original error */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * A session-level advisory lock guaranteeing a single trading engine. PostgreSQL
 * advisory locks are scoped to the session, so each attempt uses its own dedicated
 * connection; only one caller can hold a given key at a time, even within one process.
 * A stray second engine therefore cannot place a duplicate order.
 */
const LEADER_LOCK_KEY = 0x50485253;
const leaderClients = new Map<number, { client: pg.PoolClient; key: number }>();
let leaderSeq = 0;

/** Attempt to become the leader. Returns a token on success, or null if another holds the key. */
export async function acquireLeaderLock(key: number = LEADER_LOCK_KEY): Promise<number | null> {
  const client = await getPool().connect();
  try {
    const res = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [key]);
    if (!res.rows[0]?.locked) {
      client.release();
      return null;
    }
    const token = ++leaderSeq;
    leaderClients.set(token, { client, key });
    return token;
  } catch (err) {
    client.release();
    throw err;
  }
}

export async function releaseLeaderLock(token: number): Promise<void> {
  const held = leaderClients.get(token);
  if (!held) return;
  leaderClients.delete(token);
  try {
    await held.client.query("SELECT pg_advisory_unlock($1)", [held.key]);
  } finally {
    held.client.release();
  }
}

export function holdsLeaderLock(token: number | null): boolean {
  return token !== null && leaderClients.has(token);
}
