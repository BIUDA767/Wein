/**
 * Platform repositories: users and roles, invites, community, messaging, moderation.
 *
 * These are kept apart from `repo.ts` (trading core) so the trading boundary stays
 * readable. Every function maps raw snake_case rows to camelCase domain objects at
 * this boundary; a raw row is never cast to a domain interface.
 */
import { exec, query, queryOne, type Row } from "./pool.ts";
import { newId } from "../crypto/vault.ts";

export type UserRole = "owner" | "moderator" | "member";

export interface MemberProfile {
  id: string;
  username: string;
  displayName: string | null;
  role: UserRole;
  avatarSeed: string | null;
  bio: string | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
  createdAt: string;
}

export function mapMember(row: Row): MemberProfile {
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: (row.display_name as string | null) ?? null,
    role: (row.role as UserRole) ?? "member",
    avatarSeed: (row.avatar_seed as string | null) ?? null,
    bio: (row.bio as string | null) ?? null,
    suspendedAt: row.suspended_at ? String(row.suspended_at) : null,
    suspendedReason: (row.suspended_reason as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

// --- Users and roles ----------------------------------------------------------

export async function getUserRole(userId: string): Promise<UserRole | null> {
  const row = await queryOne<{ role: UserRole }>("SELECT role FROM users WHERE id = $1", [userId]);
  return row?.role ?? null;
}

export async function getUserProfile(userId: string): Promise<MemberProfile | null> {
  const row = await queryOne<Row>("SELECT * FROM users WHERE id = $1", [userId]);
  return row ? mapMember(row) : null;
}

export async function getMemberByUsername(username: string): Promise<MemberProfile | null> {
  const row = await queryOne<Row>("SELECT * FROM users WHERE username = $1", [username]);
  return row ? mapMember(row) : null;
}

/** Public member directory. Never exposes password hashes or account identifiers. */
export async function listMembers(limit = 100): Promise<MemberProfile[]> {
  const rows = await query<Row>("SELECT * FROM users ORDER BY created_at ASC LIMIT $1", [limit]);
  return rows.map(mapMember);
}

export async function updateProfile(
  userId: string,
  patch: { displayName?: string | null; bio?: string | null; avatarSeed?: string | null },
): Promise<void> {
  await exec(
    `UPDATE users SET
       display_name = COALESCE($2, display_name),
       bio = COALESCE($3, bio),
       avatar_seed = COALESCE($4, avatar_seed)
     WHERE id = $1`,
    [userId, patch.displayName ?? null, patch.bio ?? null, patch.avatarSeed ?? null],
  );
}

export async function setUserRole(userId: string, role: UserRole): Promise<void> {
  await exec("UPDATE users SET role = $2 WHERE id = $1", [userId, role]);
}

export async function setUserSuspended(userId: string, reason: string | null): Promise<void> {
  await exec(
    "UPDATE users SET suspended_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END, suspended_reason = $2 WHERE id = $1",
    [userId, reason],
  );
}

/**
 * Remove a user. Used to roll back a registration whose invite code failed to redeem,
 * so a bad code never leaves a half-created account. Cascades to sessions and content.
 */
export async function deleteUser(userId: string): Promise<void> {
  await exec("DELETE FROM users WHERE id = $1", [userId]);
}

export async function countOwners(): Promise<number> {
  const row = await queryOne<{ n: string }>("SELECT count(*)::text AS n FROM users WHERE role = 'owner'");
  return Number(row?.n ?? 0);
}

// --- Invites ------------------------------------------------------------------

export interface InviteRecord {
  code: string;
  createdBy: string | null;
  note: string | null;
  expiresAt: string | null;
  usedBy: string | null;
  usedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  /** Derived: whether the code can still be redeemed. */
  state: "available" | "used" | "revoked" | "expired";
}

export function mapInvite(row: Row): InviteRecord {
  const expiresAt = row.expires_at ? String(row.expires_at) : null;
  const usedAt = row.used_at ? String(row.used_at) : null;
  const revokedAt = row.revoked_at ? String(row.revoked_at) : null;
  const expired = expiresAt !== null && new Date(expiresAt).getTime() < Date.now();
  const state: InviteRecord["state"] = revokedAt ? "revoked" : usedAt ? "used" : expired ? "expired" : "available";
  return {
    code: String(row.code),
    createdBy: (row.created_by as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    expiresAt,
    usedBy: (row.used_by as string | null) ?? null,
    usedAt,
    revokedAt,
    createdAt: String(row.created_at),
    state,
  };
}

/** Create an invite. The code is a random 20-char token, never guessable. */
export async function createInvite(input: { createdBy: string; note?: string | null; expiresAt?: Date | null }): Promise<InviteRecord> {
  const code = newId().replace(/-/g, "").slice(0, 20);
  const row = await queryOne<Row>(
    "INSERT INTO invites (code, created_by, note, expires_at) VALUES ($1,$2,$3,$4) RETURNING *",
    [code, input.createdBy, input.note ?? null, input.expiresAt ?? null],
  );
  return mapInvite(row!);
}

export async function listInvites(limit = 100): Promise<InviteRecord[]> {
  const rows = await query<Row>("SELECT * FROM invites ORDER BY created_at DESC LIMIT $1", [limit]);
  return rows.map(mapInvite);
}

export async function revokeInvite(code: string): Promise<boolean> {
  const rows = await query<Row>(
    "UPDATE invites SET revoked_at = now() WHERE code = $1 AND used_at IS NULL AND revoked_at IS NULL RETURNING code",
    [code],
  );
  return rows.length > 0;
}

/**
 * Redeem an invite. Runs inside a transaction with a row lock so two simultaneous
 * redemptions of the same code cannot both succeed.
 */
export async function redeemInvite(code: string, userId: string): Promise<boolean> {
  const rows = await query<Row>(
    `UPDATE invites SET used_by = $2, used_at = now()
     WHERE code = $1 AND used_at IS NULL AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())
     RETURNING code`,
    [code, userId],
  );
  return rows.length > 0;
}

// --- Community ----------------------------------------------------------------

export interface PostRecord {
  id: string;
  authorId: string;
  authorName: string;
  authorRole: UserRole;
  authorSeed: string | null;
  body: string;
  strategyId: string | null;
  symbol: string | null;
  hiddenAt: string | null;
  createdAt: string;
  likeCount: number;
  commentCount: number;
  likedByMe: boolean;
}

export function mapPost(row: Row): PostRecord {
  return {
    id: String(row.id),
    authorId: String(row.author_id),
    authorName: String(row.display_name ?? row.username ?? "member"),
    authorRole: (row.role as UserRole) ?? "member",
    authorSeed: (row.avatar_seed as string | null) ?? null,
    body: String(row.body),
    strategyId: (row.strategy_id as string | null) ?? null,
    symbol: (row.symbol as string | null) ?? null,
    hiddenAt: row.hidden_at ? String(row.hidden_at) : null,
    createdAt: String(row.created_at),
    likeCount: Number(row.like_count ?? 0),
    commentCount: Number(row.comment_count ?? 0),
    likedByMe: Boolean(row.liked_by_me),
  };
}

export async function createPost(input: { authorId: string; body: string; strategyId?: string | null; symbol?: string | null }): Promise<string> {
  const id = newId();
  await exec("INSERT INTO posts (id, author_id, body, strategy_id, symbol) VALUES ($1,$2,$3,$4,$5)", [
    id,
    input.authorId,
    input.body,
    input.strategyId ?? null,
    input.symbol ?? null,
  ]);
  return id;
}

export async function listPosts(viewerId: string, limit = 50): Promise<PostRecord[]> {
  const rows = await query<Row>(
    `SELECT p.*, u.username, u.display_name, u.role, u.avatar_seed,
            (SELECT count(*)::int FROM reactions r WHERE r.post_id = p.id) AS like_count,
            (SELECT count(*)::int FROM comments c WHERE c.post_id = p.id AND c.hidden_at IS NULL) AS comment_count,
            EXISTS (SELECT 1 FROM reactions r2 WHERE r2.post_id = p.id AND r2.user_id = $1) AS liked_by_me
     FROM posts p JOIN users u ON u.id = p.author_id
     WHERE p.hidden_at IS NULL
     ORDER BY p.created_at DESC LIMIT $2`,
    [viewerId, limit],
  );
  return rows.map(mapPost);
}

export async function getPost(postId: string, viewerId: string): Promise<PostRecord | null> {
  const row = await queryOne<Row>(
    `SELECT p.*, u.username, u.display_name, u.role, u.avatar_seed,
            (SELECT count(*)::int FROM reactions r WHERE r.post_id = p.id) AS like_count,
            (SELECT count(*)::int FROM comments c WHERE c.post_id = p.id AND c.hidden_at IS NULL) AS comment_count,
            EXISTS (SELECT 1 FROM reactions r2 WHERE r2.post_id = p.id AND r2.user_id = $2) AS liked_by_me
     FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = $1`,
    [postId, viewerId],
  );
  return row ? mapPost(row) : null;
}

export async function deletePost(postId: string, authorId: string): Promise<boolean> {
  const rows = await query<Row>("DELETE FROM posts WHERE id = $1 AND author_id = $2 RETURNING id", [postId, authorId]);
  return rows.length > 0;
}

export async function hidePost(postId: string, byUserId: string): Promise<void> {
  await exec("UPDATE posts SET hidden_at = now(), hidden_by = $2 WHERE id = $1", [postId, byUserId]);
}

export async function toggleReaction(postId: string, userId: string): Promise<boolean> {
  const existing = await queryOne<Row>("SELECT 1 FROM reactions WHERE post_id = $1 AND user_id = $2", [postId, userId]);
  if (existing) {
    await exec("DELETE FROM reactions WHERE post_id = $1 AND user_id = $2", [postId, userId]);
    return false;
  }
  await exec("INSERT INTO reactions (post_id, user_id) VALUES ($1,$2)", [postId, userId]);
  return true;
}

export interface CommentRecord {
  id: string;
  postId: string;
  authorId: string;
  authorName: string;
  authorRole: UserRole;
  body: string;
  createdAt: string;
}

export async function listComments(postId: string, limit = 100): Promise<CommentRecord[]> {
  const rows = await query<Row>(
    `SELECT c.*, u.username, u.display_name, u.role FROM comments c JOIN users u ON u.id = c.author_id
     WHERE c.post_id = $1 AND c.hidden_at IS NULL ORDER BY c.created_at ASC LIMIT $2`,
    [postId, limit],
  );
  return rows.map((r) => ({
    id: String(r.id),
    postId: String(r.post_id),
    authorId: String(r.author_id),
    authorName: String(r.display_name ?? r.username ?? "member"),
    authorRole: (r.role as UserRole) ?? "member",
    body: String(r.body),
    createdAt: String(r.created_at),
  }));
}

export async function createComment(input: { postId: string; authorId: string; body: string }): Promise<string> {
  const id = newId();
  await exec("INSERT INTO comments (id, post_id, author_id, body) VALUES ($1,$2,$3,$4)", [id, input.postId, input.authorId, input.body]);
  return id;
}

export async function hideComment(commentId: string, byUserId: string): Promise<void> {
  await exec("UPDATE comments SET hidden_at = now() WHERE id = $1", [commentId]);
  void byUserId;
}

// --- Private messaging --------------------------------------------------------

export interface ThreadRecord {
  id: string;
  otherUserId: string;
  otherName: string;
  otherRole: UserRole;
  otherSeed: string | null;
  lastMessageAt: string;
  unreadCount: number;
}

/** Canonical pair ordering so a conversation has exactly one thread row. */
function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export async function ensureThread(userA: string, userB: string): Promise<string> {
  const [a, b] = pairKey(userA, userB);
  const existing = await queryOne<Row>("SELECT id FROM threads WHERE user_a = $1 AND user_b = $2", [a, b]);
  if (existing) return String(existing.id);
  const id = newId();
  await exec("INSERT INTO threads (id, user_a, user_b) VALUES ($1,$2,$3) ON CONFLICT (user_a, user_b) DO NOTHING", [id, a, b]);
  const row = await queryOne<Row>("SELECT id FROM threads WHERE user_a = $1 AND user_b = $2", [a, b]);
  return String(row!.id);
}

export async function listThreads(userId: string): Promise<ThreadRecord[]> {
  const rows = await query<Row>(
    `SELECT t.id, t.last_message_at,
            CASE WHEN t.user_a = $1 THEN t.user_b ELSE t.user_a END AS other_id,
            u.username, u.display_name, u.role, u.avatar_seed,
            (SELECT count(*)::int FROM messages m WHERE m.thread_id = t.id AND m.sender_id <> $1 AND m.read_at IS NULL) AS unread
     FROM threads t
     JOIN users u ON u.id = (CASE WHEN t.user_a = $1 THEN t.user_b ELSE t.user_a END)
     WHERE t.user_a = $1 OR t.user_b = $1
     ORDER BY t.last_message_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    id: String(r.id),
    otherUserId: String(r.other_id),
    otherName: String(r.display_name ?? r.username ?? "member"),
    otherRole: (r.role as UserRole) ?? "member",
    otherSeed: (r.avatar_seed as string | null) ?? null,
    lastMessageAt: String(r.last_message_at),
    unreadCount: Number(r.unread ?? 0),
  }));
}

export interface MessageRecord {
  id: string;
  threadId: string;
  senderId: string;
  senderName: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

/** Messages in a thread. Access is checked by the caller against membership. */
export async function listMessages(threadId: string, limit = 200): Promise<MessageRecord[]> {
  const rows = await query<Row>(
    `SELECT m.*, u.username, u.display_name FROM messages m JOIN users u ON u.id = m.sender_id
     WHERE m.thread_id = $1 AND m.hidden_at IS NULL ORDER BY m.created_at ASC LIMIT $2`,
    [threadId, limit],
  );
  return rows.map((r) => ({
    id: String(r.id),
    threadId: String(r.thread_id),
    senderId: String(r.sender_id),
    senderName: String(r.display_name ?? r.username ?? "member"),
    body: String(r.body),
    readAt: r.read_at ? String(r.read_at) : null,
    createdAt: String(r.created_at),
  }));
}

export async function isThreadMember(threadId: string, userId: string): Promise<boolean> {
  const row = await queryOne<Row>("SELECT 1 FROM threads WHERE id = $1 AND (user_a = $2 OR user_b = $2)", [threadId, userId]);
  return Boolean(row);
}

export async function sendMessage(threadId: string, senderId: string, body: string): Promise<string> {
  const id = newId();
  await exec("INSERT INTO messages (id, thread_id, sender_id, body) VALUES ($1,$2,$3,$4)", [id, threadId, senderId, body]);
  await exec("UPDATE threads SET last_message_at = now() WHERE id = $1", [threadId]);
  return id;
}

export async function markThreadRead(threadId: string, userId: string): Promise<void> {
  await exec("UPDATE messages SET read_at = now() WHERE thread_id = $1 AND sender_id <> $2 AND read_at IS NULL", [threadId, userId]);
}

// --- Moderation ---------------------------------------------------------------

export type ModerationAction = "warn" | "hide" | "suspend" | "ban" | "restore";

export interface ModerationRecord {
  id: string;
  targetUser: string | null;
  targetType: string;
  targetId: string | null;
  action: ModerationAction;
  actor: string;
  automated: boolean;
  reason: string;
  revertedAt: string | null;
  revertedBy: string | null;
  createdAt: string;
}

export function mapModeration(row: Row): ModerationRecord {
  return {
    id: String(row.id),
    targetUser: (row.target_user as string | null) ?? null,
    targetType: String(row.target_type),
    targetId: (row.target_id as string | null) ?? null,
    action: row.action as ModerationAction,
    actor: String(row.actor),
    automated: Boolean(row.automated),
    reason: String(row.reason),
    revertedAt: row.reverted_at ? String(row.reverted_at) : null,
    revertedBy: (row.reverted_by as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

export async function insertModerationAction(input: {
  targetUser: string | null;
  targetType: string;
  targetId: string | null;
  action: ModerationAction;
  actor: string;
  automated: boolean;
  reason: string;
  evidence?: unknown;
}): Promise<string> {
  const id = newId();
  await exec(
    `INSERT INTO moderation_actions (id, target_user, target_type, target_id, action, actor, automated, reason, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      input.targetUser,
      input.targetType,
      input.targetId,
      input.action,
      input.actor,
      input.automated,
      input.reason,
      input.evidence === undefined ? null : JSON.stringify(input.evidence),
    ],
  );
  return id;
}

export async function listModerationActions(limit = 100): Promise<ModerationRecord[]> {
  const rows = await query<Row>("SELECT * FROM moderation_actions ORDER BY created_at DESC LIMIT $1", [limit]);
  return rows.map(mapModeration);
}

export async function revertModerationAction(actionId: string, byUserId: string): Promise<void> {
  await exec("UPDATE moderation_actions SET reverted_at = now(), reverted_by = $2 WHERE id = $1 AND reverted_at IS NULL", [
    actionId,
    byUserId,
  ]);
}

export async function insertModerationNotice(input: { userId: string; actionId: string | null; title: string; body: string }): Promise<void> {
  await exec("INSERT INTO moderation_notices (id, user_id, action_id, title, body) VALUES ($1,$2,$3,$4,$5)", [
    newId(),
    input.userId,
    input.actionId,
    input.title,
    input.body,
  ]);
}

export async function listModerationNotices(userId: string): Promise<Row[]> {
  return query<Row>("SELECT * FROM moderation_notices WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50", [userId]);
}

export async function createAppeal(input: { userId: string; actionId: string | null; body: string }): Promise<string> {
  const id = newId();
  await exec("INSERT INTO appeals (id, user_id, action_id, body) VALUES ($1,$2,$3,$4)", [
    id,
    input.userId,
    input.actionId,
    input.body,
  ]);
  return id;
}

export async function listAppeals(status?: string): Promise<Row[]> {
  if (status) return query<Row>("SELECT * FROM appeals WHERE status = $1 ORDER BY created_at DESC LIMIT 100", [status]);
  return query<Row>("SELECT * FROM appeals ORDER BY created_at DESC LIMIT 100");
}

export async function resolveAppeal(appealId: string, byUserId: string, status: "upheld" | "denied", resolution: string): Promise<void> {
  await exec("UPDATE appeals SET status = $2, resolved_by = $3, resolved_at = now(), resolution = $4 WHERE id = $1", [
    appealId,
    status,
    byUserId,
    resolution,
  ]);
}

export async function createReport(input: { reporterId: string; targetType: string; targetId: string; reason: string }): Promise<string> {
  const id = newId();
  await exec("INSERT INTO content_reports (id, reporter_id, target_type, target_id, reason) VALUES ($1,$2,$3,$4,$5)", [
    id,
    input.reporterId,
    input.targetType,
    input.targetId,
    input.reason,
  ]);
  return id;
}

export async function listReports(status = "open"): Promise<Row[]> {
  return query<Row>("SELECT * FROM content_reports WHERE status = $1 ORDER BY created_at DESC LIMIT 100", [status]);
}

export async function resolveReport(reportId: string, status: "actioned" | "dismissed"): Promise<void> {
  await exec("UPDATE content_reports SET status = $2 WHERE id = $1", [reportId, status]);
}

// --- Platform flags and broker catalog ---------------------------------------

export async function getPlatformFlag<T = unknown>(key: string, fallback: T): Promise<T> {
  const row = await queryOne<{ value: T }>("SELECT value FROM platform_flags WHERE key = $1", [key]);
  return row ? row.value : fallback;
}

export async function setPlatformFlag(key: string, value: unknown, byUserId: string | null): Promise<void> {
  await exec(
    `INSERT INTO platform_flags (key, value, updated_by, updated_at) VALUES ($1,$2,$3, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = now()`,
    [key, JSON.stringify(value), byUserId],
  );
}

export interface CatalogEntry {
  provider: string;
  enabled: boolean;
  note: string | null;
}

export async function listBrokerCatalog(): Promise<CatalogEntry[]> {
  const rows = await query<Row>("SELECT * FROM broker_catalog ORDER BY provider");
  return rows.map((r) => ({ provider: String(r.provider), enabled: Boolean(r.enabled), note: (r.note as string | null) ?? null }));
}

export async function setCatalogEntry(provider: string, enabled: boolean, byUserId: string, note?: string | null): Promise<void> {
  await exec(
    `INSERT INTO broker_catalog (provider, enabled, note, updated_by, updated_at) VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (provider) DO UPDATE SET enabled = $2, note = COALESCE($3, broker_catalog.note), updated_by = $4, updated_at = now()`,
    [provider, enabled, note ?? null, byUserId],
  );
}

export async function isProviderEnabled(provider: string): Promise<boolean> {
  const row = await queryOne<{ enabled: boolean }>("SELECT enabled FROM broker_catalog WHERE provider = $1", [provider]);
  // A provider absent from the catalog is allowed by default; the owner opts out.
  return row ? row.enabled : true;
}
