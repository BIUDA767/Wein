import { exec, query, queryOne, type Row } from "./pool.ts";
import { newId } from "../crypto/vault.ts";
import {
  DEFAULT_RISK_CONFIG,
  type BrokerAccount,
  type OrderRecord,
  type OrderStatus,
  type RiskConfig,
  type TradeMode,
  type TradeProposal,
} from "../types.ts";

// --- Users & sessions ---------------------------------------------------------

export interface UserRow extends Row {
  id: string;
  username: string;
  password_hash: string;
  created_at: string;
}

export async function countUsers(): Promise<number> {
  const row = await queryOne<{ n: string }>("SELECT count(*)::text AS n FROM users");
  return Number(row?.n ?? 0);
}

export async function createUser(username: string, passwordHash: string): Promise<UserRow> {
  const row = await queryOne<UserRow>(
    `INSERT INTO users (id, username, password_hash) VALUES ($1,$2,$3) RETURNING *`,
    [newId(), username, passwordHash],
  );
  return row!;
}

export async function findUserByUsername(username: string): Promise<UserRow | null> {
  return queryOne<UserRow>("SELECT * FROM users WHERE username = $1", [username]);
}

export async function findUserById(id: string): Promise<UserRow | null> {
  return queryOne<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
}

export async function createSession(userId: string, tokenHash: string, expiresAt: Date, userAgent: string | null): Promise<void> {
  await exec(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, user_agent) VALUES ($1,$2,$3,$4,$5)`,
    [newId(), userId, tokenHash, expiresAt, userAgent],
  );
}

export async function findSession(tokenHash: string): Promise<{ user_id: string; expires_at: string } | null> {
  return queryOne("SELECT user_id, expires_at FROM sessions WHERE token_hash = $1", [tokenHash]);
}

export async function deleteSession(tokenHash: string): Promise<void> {
  await exec("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
}

/** Set a new password hash for a user. */
export async function updateUserPassword(userId: string, passwordHash: string): Promise<void> {
  await exec("UPDATE users SET password_hash = $2 WHERE id = $1", [userId, passwordHash]);
}

/**
 * Invalidate every session except the one that just changed the password. Keeps the
 * current session usable while forcing any other logged-in device to sign in again.
 */
export async function deleteOtherSessions(userId: string, keepTokenHash: string): Promise<number> {
  const rows = await query<{ id: string }>(
    "DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2 RETURNING id",
    [userId, keepTokenHash],
  );
  return rows.length;
}

export async function purgeExpiredSessions(): Promise<void> {
  await exec("DELETE FROM sessions WHERE expires_at < now()");
}

// --- Brokers & accounts -------------------------------------------------------

export interface BrokerRow extends Row {
  id: string;
  provider: string;
  label: string;
  credentials_enc: string;
  credential_fingerprint: string;
  status: string;
  last_verified_at: string | null;
  last_error: string | null;
  capabilities: Record<string, unknown>;
  created_at: string;
}

export async function listBrokers(): Promise<BrokerRow[]> {
  return query<BrokerRow>("SELECT * FROM brokers ORDER BY created_at ASC");
}

export async function getBroker(id: string): Promise<BrokerRow | null> {
  return queryOne<BrokerRow>("SELECT * FROM brokers WHERE id = $1", [id]);
}

export async function getActiveBroker(): Promise<BrokerRow | null> {
  return queryOne<BrokerRow>("SELECT * FROM brokers WHERE is_active = true LIMIT 1");
}

export async function createBroker(input: {
  provider: string;
  label: string;
  credentialsEnc: string;
  fingerprint: string;
  capabilities: Record<string, unknown>;
}): Promise<BrokerRow> {
  const row = await queryOne<BrokerRow>(
    `INSERT INTO brokers (id, provider, label, credentials_enc, credential_fingerprint, capabilities, status)
     VALUES ($1,$2,$3,$4,$5,$6,'unverified') RETURNING *`,
    [newId(), input.provider, input.label, input.credentialsEnc, input.fingerprint, JSON.stringify(input.capabilities)],
  );
  return row!;
}

export async function updateBrokerStatus(
  id: string,
  status: string,
  lastError: string | null,
  capabilities?: Record<string, unknown>,
): Promise<void> {
  await exec(
    `UPDATE brokers SET status=$2, last_error=$3, last_verified_at=now(),
     capabilities = COALESCE($4, capabilities) WHERE id=$1`,
    [id, status, lastError, capabilities ? JSON.stringify(capabilities) : null],
  );
}

export async function setActiveBroker(id: string): Promise<void> {
  await exec("UPDATE brokers SET is_active = (id = $1)", [id]);
}

export async function deleteBroker(id: string): Promise<void> {
  await exec("DELETE FROM brokers WHERE id = $1", [id]);
}

export async function upsertAccount(brokerId: string, acct: BrokerAccount): Promise<void> {
  await exec(
    `INSERT INTO accounts (id, broker_id, account_id, account_type, currency, balance, loginid, label, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (broker_id, account_id) DO UPDATE
       SET account_type=EXCLUDED.account_type, currency=EXCLUDED.currency,
           balance=EXCLUDED.balance, loginid=EXCLUDED.loginid, updated_at=now()`,
    [newId(), brokerId, acct.id, acct.type, acct.currency, acct.balance, acct.loginid ?? null, acct.label ?? null],
  );
}

export async function listAccounts(brokerId?: string): Promise<Row[]> {
  if (brokerId) return query("SELECT * FROM accounts WHERE broker_id=$1 ORDER BY account_type DESC", [brokerId]);
  return query("SELECT * FROM accounts ORDER BY broker_id, account_type DESC");
}

export async function getActiveAccount(): Promise<Row | null> {
  return queryOne("SELECT * FROM accounts WHERE is_active = true LIMIT 1");
}

export async function setActiveAccount(accountRowId: string): Promise<void> {
  await exec("UPDATE accounts SET is_active = (id = $1)", [accountRowId]);
}

// --- Orders -------------------------------------------------------------------

export async function insertOrder(o: {
  brokerId: string;
  accountId: string;
  symbol: string;
  side: string;
  orderType: string;
  amount: number;
  durationSec: number | null;
  mode: TradeMode;
  strategyId: string | null;
  origin: string;
  clientRef: string | null;
}): Promise<string> {
  const id = newId();
  await exec(
    `INSERT INTO orders (id, broker_id, account_id, symbol, side, order_type, amount, duration_sec, status, mode, strategy_id, origin, client_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11,$12)`,
    [id, o.brokerId, o.accountId, o.symbol, o.side, o.orderType, o.amount, o.durationSec, o.mode, o.strategyId, o.origin, o.clientRef],
  );
  return id;
}

export async function updateOrder(
  id: string,
  patch: Partial<{
    brokerOrderId: string | null;
    status: OrderStatus;
    fillPrice: number | null;
    payout: number | null;
    profit: number | null;
    error: string | null;
    settledAt: string | null;
  }>,
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const map: Record<string, string> = {
    brokerOrderId: "broker_order_id",
    status: "status",
    fillPrice: "fill_price",
    payout: "payout",
    profit: "profit",
    error: "error",
    settledAt: "settled_at",
  };
  for (const [k, col] of Object.entries(map)) {
    if (k in patch) {
      vals.push((patch as Record<string, unknown>)[k]);
      sets.push(`${col} = $${vals.length}`);
    }
  }
  sets.push("updated_at = now()");
  vals.push(id);
  await exec(`UPDATE orders SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
}

// --- Order row mapping ---------------------------------------------------------

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toStr(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

/**
 * PostgreSQL returns snake_case columns and numeric types as strings, while the rest of
 * the codebase works with the camelCase OrderRecord shape. Mapping happens here so that
 * `brokerOrderId` is real; otherwise settlement can never match an order to its
 * broker-side contract.
 */
export function mapOrderRow(row: Row): OrderRecord {
  return {
    id: String(row.id),
    brokerOrderId: toStr(row.broker_order_id),
    brokerId: String(row.broker_id),
    accountId: String(row.account_id),
    symbol: String(row.symbol),
    side: row.side as OrderRecord["side"],
    orderType: row.order_type as OrderRecord["orderType"],
    amount: toNum(row.amount) ?? 0,
    durationSec: toNum(row.duration_sec),
    status: row.status as OrderStatus,
    fillPrice: toNum(row.fill_price),
    payout: toNum(row.payout),
    profit: toNum(row.profit),
    mode: row.mode as TradeMode,
    strategyId: toStr(row.strategy_id),
    origin: String(row.origin),
    clientRef: toStr(row.client_ref),
    error: toStr(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    settledAt: toStr(row.settled_at),
  };
}

export async function getOrder(id: string): Promise<OrderRecord | null> {
  const row = await queryOne<Row>("SELECT * FROM orders WHERE id = $1", [id]);
  return row ? mapOrderRow(row) : null;
}

export async function listOrders(limit = 100, filters: { mode?: TradeMode; status?: string } = {}): Promise<Row[]> {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (filters.mode) {
    vals.push(filters.mode);
    where.push(`mode = $${vals.length}`);
  }
  if (filters.status) {
    vals.push(filters.status);
    where.push(`status = $${vals.length}`);
  }
  vals.push(limit);
  return query(
    `SELECT * FROM orders ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT $${vals.length}`,
    vals,
  );
}

export async function listOpenOrders(mode: TradeMode): Promise<OrderRecord[]> {
  const rows = await query<Row>(
    `SELECT * FROM orders WHERE mode=$1 AND status IN ('submitted','open','partially_filled','unknown') ORDER BY created_at ASC`,
    [mode],
  );
  return rows.map(mapOrderRow);
}

export async function listSettledOrders(mode: TradeMode, limit = 500): Promise<OrderRecord[]> {
  const rows = await query<Row>(
    `SELECT * FROM orders WHERE mode=$1 AND status='settled' ORDER BY created_at DESC LIMIT $2`,
    [mode, limit],
  );
  return rows.map(mapOrderRow);
}

export async function findOrderByBrokerId(brokerOrderId: string): Promise<OrderRecord | null> {
  const row = await queryOne<Row>("SELECT * FROM orders WHERE broker_order_id = $1", [brokerOrderId]);
  return row ? mapOrderRow(row) : null;
}

// --- Trade proposals (approval mode) ------------------------------------------

/** Map a raw snake_case row to the domain shape. Never cast a raw row directly. */
export function mapProposalRow(row: Row): TradeProposal {
  return {
    id: String(row.id),
    symbol: String(row.symbol),
    side: row.side as TradeProposal["side"],
    amount: Number(row.amount),
    durationSec: Number(row.duration_sec),
    strategyId: row.strategy_id === null || row.strategy_id === undefined ? null : String(row.strategy_id),
    rationale: row.rationale === null || row.rationale === undefined ? null : String(row.rationale),
    mode: row.mode as TradeMode,
    status: row.status as TradeProposal["status"],
    referencePrice: row.reference_price === null || row.reference_price === undefined ? null : Number(row.reference_price),
    blockReason: row.block_reason === null || row.block_reason === undefined ? null : String(row.block_reason),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    decidedAt: row.decided_at === null || row.decided_at === undefined ? null : String(row.decided_at),
    orderId: row.order_id === null || row.order_id === undefined ? null : String(row.order_id),
  };
}

/**
 * Insert a pending proposal. The partial unique index makes this the dedupe point:
 * a second pending proposal for the same symbol and direction violates the index
 * and returns null, so the caller simply keeps the existing one.
 */
export async function insertProposal(p: {
  symbol: string;
  side: TradeProposal["side"];
  amount: number;
  durationSec: number;
  strategyId: string | null;
  rationale: string | null;
  mode: TradeMode;
  referencePrice: number | null;
  ttlSec: number;
}): Promise<TradeProposal | null> {
  const id = newId();
  const row = await queryOne<Row>(
    `INSERT INTO trade_proposals
       (id, symbol, side, amount, duration_sec, strategy_id, rationale, mode, reference_price, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + ($10 || ' seconds')::interval)
     ON CONFLICT (symbol, side) WHERE status = 'pending' DO NOTHING
     RETURNING *`,
    [id, p.symbol, p.side, p.amount, p.durationSec, p.strategyId, p.rationale, p.mode, p.referencePrice, p.ttlSec],
  );
  return row ? mapProposalRow(row) : null;
}

export async function getProposal(id: string): Promise<TradeProposal | null> {
  const row = await queryOne<Row>("SELECT * FROM trade_proposals WHERE id = $1", [id]);
  return row ? mapProposalRow(row) : null;
}

export async function listProposals(
  limit = 50,
  filters: { status?: TradeProposal["status"] } = {},
): Promise<TradeProposal[]> {
  const vals: unknown[] = [];
  let where = "";
  if (filters.status) {
    vals.push(filters.status);
    where = `WHERE status = $${vals.length}`;
  }
  vals.push(limit);
  const rows = await query<Row>(
    `SELECT * FROM trade_proposals ${where} ORDER BY created_at DESC LIMIT $${vals.length}`,
    vals,
  );
  return rows.map(mapProposalRow);
}

export async function listPendingProposals(): Promise<TradeProposal[]> {
  const rows = await query<Row>(
    "SELECT * FROM trade_proposals WHERE status = 'pending' ORDER BY created_at ASC",
  );
  return rows.map(mapProposalRow);
}

/**
 * Claim a proposal for execution. Only a still-pending proposal can be claimed, so
 * two concurrent approvals cannot both execute it. Returns the row when this caller
 * won the claim, null when someone else already decided it.
 */
export async function claimProposal(id: string): Promise<TradeProposal | null> {
  const row = await queryOne<Row>(
    `UPDATE trade_proposals SET status='approved', decided_at=now()
     WHERE id=$1 AND status='pending' RETURNING *`,
    [id],
  );
  return row ? mapProposalRow(row) : null;
}

export async function rejectProposal(id: string): Promise<boolean> {
  const row = await queryOne<Row>(
    `UPDATE trade_proposals SET status='rejected', decided_at=now()
     WHERE id=$1 AND status='pending' RETURNING id`,
    [id],
  );
  return row !== null;
}

/** Mark a claimed proposal with the order it produced. */
export async function attachProposalOrder(id: string, orderId: string): Promise<void> {
  await exec("UPDATE trade_proposals SET order_id=$2 WHERE id=$1", [id, orderId]);
}

/**
 * Expire pending proposals that are past their TTL, or whose reference price has
 * moved beyond `maxDriftPct`. A stale proposal is not a trade the owner agreed to.
 */
export async function expireStaleProposals(maxDriftPct: number, currentPrice: number): Promise<number> {
  const res = await query<Row>(
    `UPDATE trade_proposals SET status='expired', decided_at=now()
     WHERE status='pending'
       AND (expires_at < now()
            OR (reference_price IS NOT NULL AND reference_price > 0
                AND abs($1 - reference_price) / reference_price * 100 > $2))
     RETURNING id`,
    [currentPrice, maxDriftPct],
  );
  return res.length;
}

/** Expire every pending proposal, e.g. when leaving approval mode. */
export async function expireAllPendingProposals(reason: string): Promise<number> {
  const res = await query<Row>(
    `UPDATE trade_proposals SET status='expired', decided_at=now(), block_reason=COALESCE(block_reason, $1)
     WHERE status='pending' RETURNING id`,
    [reason],
  );
  return res.length;
}

// --- Positions ----------------------------------------------------------------

export async function upsertPosition(p: {
  brokerId: string;
  accountId: string;
  symbol: string;
  side: string;
  size: number;
  entryPrice: number | null;
  currentPrice: number | null;
  unrealizedPnl: number | null;
  mode: TradeMode;
  brokerPositionId: string | null;
}): Promise<void> {
  await exec(
    `INSERT INTO positions (id, broker_id, account_id, symbol, side, size, entry_price, current_price, unrealized_pnl, mode, broker_position_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     ON CONFLICT (broker_id, account_id, broker_position_id) DO UPDATE
       SET size=EXCLUDED.size, current_price=EXCLUDED.current_price,
           unrealized_pnl=EXCLUDED.unrealized_pnl, updated_at=now()`,
    [newId(), p.brokerId, p.accountId, p.symbol, p.side, p.size, p.entryPrice, p.currentPrice, p.unrealizedPnl, p.mode, p.brokerPositionId],
  );
}

export async function listPositions(mode?: TradeMode): Promise<Row[]> {
  if (mode) return query("SELECT * FROM positions WHERE mode=$1 AND size <> 0 ORDER BY updated_at DESC", [mode]);
  return query("SELECT * FROM positions WHERE size <> 0 ORDER BY updated_at DESC");
}

export async function clearPositions(brokerId: string, accountId: string, mode: TradeMode): Promise<void> {
  await exec("DELETE FROM positions WHERE broker_id=$1 AND account_id=$2 AND mode=$3", [brokerId, accountId, mode]);
}

// --- Risk config --------------------------------------------------------------

export async function getRiskConfig(): Promise<RiskConfig> {
  const row = await queryOne<Row>("SELECT config FROM risk_config WHERE id = 1");
  if (!row) return { ...DEFAULT_RISK_CONFIG };
  return { ...DEFAULT_RISK_CONFIG, ...(row.config as RiskConfig) };
}

export async function setRiskConfig(cfg: RiskConfig): Promise<void> {
  await exec(
    `INSERT INTO risk_config (id, config, updated_at) VALUES (1,$1, now())
     ON CONFLICT (id) DO UPDATE SET config=EXCLUDED.config, updated_at=now()`,
    [JSON.stringify(cfg)],
  );
}

// --- Engine state -------------------------------------------------------------

export async function getEngineState(): Promise<{ state: string; mode: TradeMode; reason: string | null; updated_at: string }> {
  const row = await queryOne<Row>("SELECT state, mode, reason, updated_at FROM engine_state WHERE id = 1");
  return (row as never) ?? { state: "stopped", mode: "paper", reason: null, updated_at: new Date().toISOString() };
}

export async function setEngineState(state: string, mode: TradeMode, reason: string | null): Promise<void> {
  await exec(
    `INSERT INTO engine_state (id, state, mode, reason, updated_at) VALUES (1,$1,$2,$3, now())
     ON CONFLICT (id) DO UPDATE SET state=EXCLUDED.state, mode=EXCLUDED.mode, reason=EXCLUDED.reason, updated_at=now()`,
    [state, mode, reason],
  );
}

// --- Equity snapshots & daily stats ------------------------------------------

export async function recordEquity(mode: TradeMode, equity: number, balance: number, unrealized: number): Promise<void> {
  await exec("INSERT INTO equity_snapshots (id, mode, equity, balance, unrealized) VALUES ($1,$2,$3,$4,$5)", [
    newId(),
    mode,
    equity,
    balance,
    unrealized,
  ]);
}

export async function listEquity(mode: TradeMode, limit = 500): Promise<Row[]> {
  return query("SELECT * FROM equity_snapshots WHERE mode=$1 ORDER BY at DESC LIMIT $2", [mode, limit]);
}

/**
 * Derive the state needed to rebuild the paper simulator after a restart. The database
 * is the source of truth: realized profit comes from settled orders, and open contracts
 * are rehydrated from open orders so they can still expire and settle.
 */
export async function paperRestoreState(
  brokerId: string,
  accountId: string,
  mode: TradeMode,
): Promise<{ realizedPnl: number; openPositions: Array<{ brokerOrderId: string; symbol: string; side: string; amount: number; entryPrice: number | null; expiryAt: number | null; openedAt: number }> }> {
  const realized = await queryOne<{ pnl: string | null }>(
    `SELECT COALESCE(SUM(profit),0)::text AS pnl FROM orders
     WHERE broker_id=$1 AND account_id=$2 AND mode=$3 AND status='settled'`,
    [brokerId, accountId, mode],
  );
  const rows = await query<Row>(
    `SELECT broker_order_id, symbol, side, amount, fill_price, duration_sec, created_at FROM orders
     WHERE broker_id=$1 AND account_id=$2 AND mode=$3 AND broker_order_id IS NOT NULL
       AND status IN ('submitted','open','partially_filled')`,
    [brokerId, accountId, mode],
  );
  return {
    realizedPnl: Number(realized?.pnl ?? 0),
    openPositions: rows.map((r) => {
      const createdMs = new Date(String(r.created_at)).getTime();
      const durationSec = toNum(r.duration_sec);
      return {
        brokerOrderId: String(r.broker_order_id),
        symbol: String(r.symbol),
        side: String(r.side),
        amount: toNum(r.amount) ?? 0,
        entryPrice: toNum(r.fill_price),
        expiryAt: durationSec !== null ? createdMs + durationSec * 1000 : null,
        openedAt: createdMs,
      };
    }),
  };
}

export async function dailyRealizedPnl(mode: TradeMode, since: Date): Promise<number> {
  const row = await queryOne<{ pnl: string | null }>(
    `SELECT COALESCE(SUM(profit),0)::text AS pnl FROM orders
     WHERE mode=$1 AND status='settled' AND settled_at >= $2`,
    [mode, since],
  );
  return Number(row?.pnl ?? 0);
}

export async function consecutiveLosses(mode: TradeMode): Promise<number> {
  const rows = await query<{ profit: string | null }>(
    `SELECT profit FROM orders WHERE mode=$1 AND status='settled' AND profit IS NOT NULL ORDER BY settled_at DESC LIMIT 50`,
    [mode],
  );
  let n = 0;
  for (const r of rows) {
    if (Number(r.profit) < 0) n++;
    else break;
  }
  return n;
}

export async function equityPeak(mode: TradeMode): Promise<number> {
  const row = await queryOne<{ peak: string | null }>(
    "SELECT MAX(equity)::text AS peak FROM equity_snapshots WHERE mode=$1",
    [mode],
  );
  return Number(row?.peak ?? 0);
}

// --- Strategies ---------------------------------------------------------------

export async function listStrategies(): Promise<Row[]> {
  return query("SELECT * FROM strategies ORDER BY builtin DESC, name ASC");
}

export async function getStrategy(id: string): Promise<Row | null> {
  return queryOne("SELECT * FROM strategies WHERE id=$1", [id]);
}

export async function upsertStrategy(s: {
  id: string;
  name: string;
  description: string;
  params: Record<string, unknown>;
  enabled: boolean;
  builtin: boolean;
  createdBy?: string | null;
}): Promise<void> {
  await exec(
    `INSERT INTO strategies (id, name, description, params, enabled, builtin, created_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description,
       params=EXCLUDED.params, enabled=EXCLUDED.enabled, updated_at=now()`,
    [s.id, s.name, s.description, JSON.stringify(s.params), s.enabled, s.builtin, s.createdBy ?? null],
  );
}

export async function setActiveStrategy(id: string): Promise<void> {
  await exec("UPDATE strategies SET is_active = (id = $1)", [id]);
}

export async function getActiveStrategy(): Promise<Row | null> {
  return queryOne("SELECT * FROM strategies WHERE is_active = true LIMIT 1");
}

export async function setStrategyEnabled(id: string, enabled: boolean): Promise<void> {
  await exec("UPDATE strategies SET enabled=$2, updated_at=now() WHERE id=$1", [id, enabled]);
}

export async function deleteStrategy(id: string): Promise<void> {
  await exec("DELETE FROM strategies WHERE id=$1 AND builtin=false", [id]);
}

// --- Agent verdicts -----------------------------------------------------------

export async function insertVerdict(v: {
  agent: string;
  supportive: boolean;
  confidence: number;
  summary: string;
  detail: Record<string, unknown> | null;
  source: string;
  symbol: string | null;
  correlationId: string | null;
}): Promise<void> {
  await exec(
    `INSERT INTO agent_verdicts (id, agent, supportive, confidence, summary, detail, source, symbol, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [newId(), v.agent, v.supportive, v.confidence, v.summary, v.detail ? JSON.stringify(v.detail) : null, v.source, v.symbol, v.correlationId],
  );
}

export async function listVerdicts(limit = 50): Promise<Row[]> {
  return query("SELECT * FROM agent_verdicts ORDER BY at DESC LIMIT $1", [limit]);
}

// --- Notifications ------------------------------------------------------------

export async function insertNotification(n: {
  severity: string;
  title: string;
  body: string;
  category: string;
  meta?: Record<string, unknown> | null;
}): Promise<string> {
  const id = newId();
  await exec(
    `INSERT INTO notifications (id, severity, title, body, category, meta) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, n.severity, n.title, n.body, n.category, n.meta ? JSON.stringify(n.meta) : null],
  );
  return id;
}

export async function listNotifications(limit = 50, unreadOnly = false): Promise<Row[]> {
  return query(
    `SELECT * FROM notifications ${unreadOnly ? "WHERE read_at IS NULL" : ""} ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
}

export async function markNotificationRead(id: string): Promise<void> {
  await exec("UPDATE notifications SET read_at = now() WHERE id=$1", [id]);
}

export async function markAllNotificationsRead(): Promise<void> {
  await exec("UPDATE notifications SET read_at = now() WHERE read_at IS NULL");
}

// --- Audit log ----------------------------------------------------------------

export async function audit(entry: {
  actor: string;
  action: string;
  target?: string | null;
  detail?: Record<string, unknown> | null;
  ip?: string | null;
}): Promise<void> {
  await exec(`INSERT INTO audit_log (id, actor, action, target, detail, ip) VALUES ($1,$2,$3,$4,$5,$6)`, [
    newId(),
    entry.actor,
    entry.action,
    entry.target ?? null,
    entry.detail ? JSON.stringify(entry.detail) : null,
    entry.ip ?? null,
  ]);
}

export async function listAudit(limit = 200): Promise<Row[]> {
  return query("SELECT * FROM audit_log ORDER BY at DESC LIMIT $1", [limit]);
}

// --- AI memory ----------------------------------------------------------------

export async function addMemory(m: { kind: string; content: string; importance: number; source: string }): Promise<string> {
  const id = newId();
  await exec(`INSERT INTO ai_memory (id, kind, content, importance, source) VALUES ($1,$2,$3,$4,$5)`, [
    id,
    m.kind,
    m.content,
    m.importance,
    m.source,
  ]);
  return id;
}

export async function listMemory(limit = 100): Promise<Row[]> {
  return query("SELECT * FROM ai_memory WHERE deleted_at IS NULL ORDER BY importance DESC, created_at DESC LIMIT $1", [limit]);
}

export async function deleteMemory(id: string): Promise<void> {
  await exec("UPDATE ai_memory SET deleted_at = now() WHERE id=$1", [id]);
}

export async function purgeMemory(): Promise<void> {
  await exec("UPDATE ai_memory SET deleted_at = now() WHERE deleted_at IS NULL");
}

export async function updateMemory(id: string, content: string, importance: number): Promise<void> {
  await exec("UPDATE ai_memory SET content=$2, importance=$3 WHERE id=$1", [id, content, importance]);
}

// --- Settings (KV) ------------------------------------------------------------

export async function getSetting<T = unknown>(key: string): Promise<T | null> {
  const row = await queryOne<{ value: unknown }>("SELECT value FROM app_settings WHERE key=$1", [key]);
  return row ? (row.value as T) : null;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await exec(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [key, JSON.stringify(value)],
  );
}

// --- Telegram links -----------------------------------------------------------

export async function upsertTelegramLink(chatId: string, userId: string, permissions: string[]): Promise<void> {
  await exec(
    `INSERT INTO telegram_links (chat_id, user_id, permissions, updated_at) VALUES ($1,$2,$3, now())
     ON CONFLICT (chat_id) DO UPDATE SET user_id=EXCLUDED.user_id, permissions=EXCLUDED.permissions, updated_at=now()`,
    [chatId, userId, JSON.stringify(permissions)],
  );
}

export async function getTelegramLink(chatId: string): Promise<Row | null> {
  return queryOne("SELECT * FROM telegram_links WHERE chat_id=$1", [chatId]);
}

export async function listTelegramLinks(): Promise<Row[]> {
  return query("SELECT * FROM telegram_links ORDER BY updated_at DESC");
}

export async function deleteTelegramLink(chatId: string): Promise<void> {
  await exec("DELETE FROM telegram_links WHERE chat_id=$1", [chatId]);
}

export async function issueTelegramLinkCode(code: string, userId: string, expiresAt: Date): Promise<void> {
  await exec(
    `INSERT INTO telegram_link_codes (code, user_id, expires_at) VALUES ($1,$2,$3)
     ON CONFLICT (code) DO UPDATE SET user_id=EXCLUDED.user_id, expires_at=EXCLUDED.expires_at`,
    [code, userId, expiresAt],
  );
}

export async function consumeTelegramLinkCode(code: string): Promise<string | null> {
  const row = await queryOne<{ user_id: string; expires_at: string }>(
    "SELECT user_id, expires_at FROM telegram_link_codes WHERE code=$1",
    [code],
  );
  if (!row) return null;
  await exec("DELETE FROM telegram_link_codes WHERE code=$1", [code]);
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row.user_id;
}
