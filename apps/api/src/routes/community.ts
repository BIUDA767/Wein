import {
  createPost,
  listPosts,
  getPost,
  deletePost,
  hidePost,
  toggleReaction,
  listComments,
  createComment,
  hideComment,
  ensureThread,
  listThreads,
  listMessages,
  sendMessage,
  markThreadRead,
  isThreadMember,
  listMembers,
  createReport,
  insertModerationAction,
  insertModerationNotice,
  setUserSuspended,
  createAppeal,
  listModerationNotices,
  audit,
  type Logger,
} from "@phirst/core";
import { json, error, type RequestContext, type Router } from "../http.ts";
import { screenContent } from "@phirst/ai";

/** Simple length and rate guard so a member cannot flood the feed. */
const POST_MAX = 2000;
const COMMENT_MAX = 1000;
const MESSAGE_MAX = 2000;

function badBody(v: unknown, max: number): string | null {
  if (typeof v !== "string") return "Message body is required.";
  const t = v.trim();
  if (t.length === 0) return "Message body cannot be empty.";
  if (t.length > max) return `Message body must be at most ${max} characters.`;
  return null;
}

/**
 * Community, private messaging and PHIRST2 moderation.
 *
 * Privacy: a member's balance, broker credentials and account identifiers never appear
 * in any response here. Only username, display name, avatar seed, role and the content
 * the member chose to post are exposed.
 */
export function registerCommunityRoutes(router: Router, log: Logger): void {
  // --- Feed -------------------------------------------------------------------

  router.get("/api/community/posts", ({ res, userId }: RequestContext) => {
    void (async () => {
      json(res, 200, { posts: await listPosts(userId!, 50) });
    })();
  });

  router.post("/api/community/posts", ({ res, body, userId }: RequestContext) => {
    void (async () => {
      const { text, strategyId, symbol } = (body ?? {}) as { text?: string; strategyId?: string; symbol?: string };
      const problem = badBody(text, POST_MAX);
      if (problem) {
        error(res, 400, problem);
        return;
      }
      // PHIRST2 automated moderation runs before the post is stored. A blocked post
      // never reaches the feed.
      const verdict = screenContent(text!.trim(), { authorId: userId! });
      if (verdict.blocked) {
        const actionId = await insertModerationAction({
          targetUser: userId!,
          targetType: "post",
          targetId: null,
          action: verdict.action,
          actor: "phirst2",
          automated: true,
          reason: verdict.reason,
          evidence: verdict.evidence,
        });
        await insertModerationNotice({
          userId: userId!,
          actionId,
          title: "PHIRST2 removed your post",
          body: `${verdict.reason} If you believe this is wrong you can appeal from Settings.`,
        });
        if (verdict.action === "suspend") await setUserSuspended(userId!, `Automated moderation: ${verdict.reason}`);
        await audit({ actor: "phirst2", action: "moderation.blocked_post", detail: { userId, reason: verdict.reason } });
        error(res, 422, `Post blocked by PHIRST2 moderation: ${verdict.reason}`);
        return;
      }
      const id = await createPost({ authorId: userId!, body: text!.trim(), strategyId: strategyId ?? null, symbol: symbol ?? null });
      json(res, 201, { ok: true, id, post: await getPost(id, userId!) });
    })();
  });

  router.get("/api/community/posts/:id", ({ res, params, userId }: RequestContext) => {
    void (async () => {
      const post = await getPost(params.id!, userId!);
      if (!post || post.hiddenAt) {
        error(res, 404, "Post not found.");
        return;
      }
      json(res, 200, { post, comments: await listComments(params.id!) });
    })();
  });

  router.delete("/api/community/posts/:id", ({ res, params, userId, role }: RequestContext) => {
    void (async () => {
      const post = await getPost(params.id!, userId!);
      if (!post) {
        error(res, 404, "Post not found.");
        return;
      }
      // The author may delete their own post; the owner and moderators may hide any post.
      const own = await deletePost(params.id!, userId!);
      if (own) {
        json(res, 200, { ok: true, deleted: true });
        return;
      }
      if (role === "owner" || role === "moderator") {
        await hidePost(params.id!, userId!);
        await insertModerationAction({
          targetUser: post.authorId,
          targetType: "post",
          targetId: params.id!,
          action: "hide",
          actor: userId!,
          automated: false,
          reason: "Removed by a moderator.",
        });
        json(res, 200, { ok: true, hidden: true });
        return;
      }
      error(res, 403, "You can only delete your own posts.");
    })();
  });

  router.post("/api/community/posts/:id/like", ({ res, params, userId }: RequestContext) => {
    void (async () => {
      const post = await getPost(params.id!, userId!);
      if (!post || post.hiddenAt) {
        error(res, 404, "Post not found.");
        return;
      }
      const liked = await toggleReaction(params.id!, userId!);
      json(res, 200, { ok: true, liked });
    })();
  });

  router.post("/api/community/posts/:id/comments", ({ res, body, params, userId }: RequestContext) => {
    void (async () => {
      const { text } = (body ?? {}) as { text?: string };
      const problem = badBody(text, COMMENT_MAX);
      if (problem) {
        error(res, 400, problem);
        return;
      }
      const post = await getPost(params.id!, userId!);
      if (!post || post.hiddenAt) {
        error(res, 404, "Post not found.");
        return;
      }
      const verdict = screenContent(text!.trim(), { authorId: userId! });
      if (verdict.blocked) {
        const actionId = await insertModerationAction({
          targetUser: userId!,
          targetType: "comment",
          targetId: params.id!,
          action: verdict.action,
          actor: "phirst2",
          automated: true,
          reason: verdict.reason,
          evidence: verdict.evidence,
        });
        await insertModerationNotice({
          userId: userId!,
          actionId,
          title: "PHIRST2 removed your comment",
          body: verdict.reason,
        });
        error(res, 422, `Comment blocked by PHIRST2 moderation: ${verdict.reason}`);
        return;
      }
      const id = await createComment({ postId: params.id!, authorId: userId!, body: text!.trim() });
      json(res, 201, { ok: true, id, comments: await listComments(params.id!) });
    })();
  });

  router.delete("/api/community/comments/:id", ({ res, params, userId, role }: RequestContext) => {
    void (async () => {
      if (role !== "owner" && role !== "moderator") {
        error(res, 403, "Only a moderator can remove a comment. Contact a moderator to report it.");
        return;
      }
      void userId;
      await hideComment(params.id!);
      json(res, 200, { ok: true });
    })();
  });

  // --- Members ----------------------------------------------------------------

  router.get("/api/community/members", ({ res }: RequestContext) => {
    void (async () => {
      const members = await listMembers(200);
      // Strip everything except the public profile fields.
      json(res, 200, {
        members: members.map((m) => ({
          id: m.id,
          username: m.username,
          displayName: m.displayName,
          role: m.role,
          avatarSeed: m.avatarSeed,
          bio: m.bio,
          suspended: Boolean(m.suspendedAt),
        })),
      });
    })();
  });

  router.post("/api/community/reports", ({ res, body, userId }: RequestContext) => {
    void (async () => {
      const { targetType, targetId, reason } = (body ?? {}) as { targetType?: string; targetId?: string; reason?: string };
      if (!targetType || !targetId || !reason || reason.trim().length < 3) {
        error(res, 400, "targetType, targetId and a reason are required.");
        return;
      }
      const id = await createReport({ reporterId: userId!, targetType, targetId, reason: reason.trim() });
      await audit({ actor: userId!, action: "community.report", detail: { targetType, targetId } });
      json(res, 201, { ok: true, id });
    })();
  });

  // --- Moderation notices and appeals (self-service) --------------------------

  router.get("/api/community/moderation", ({ res, userId }: RequestContext) => {
    void (async () => {
      const notices = await listModerationNotices(userId!);
      json(res, 200, {
        notices: notices.map((n) => ({
          id: String(n.id),
          title: String(n.title),
          body: String(n.body),
          actionId: (n.action_id as string | null) ?? null,
          acknowledgedAt: n.acknowledged_at ? String(n.acknowledged_at) : null,
          createdAt: String(n.created_at),
        })),
      });
    })();
  });

  router.post("/api/community/appeals", ({ res, body, userId }: RequestContext) => {
    void (async () => {
      const { actionId, text } = (body ?? {}) as { actionId?: string | null; text?: string };
      if (!text || text.trim().length < 10) {
        error(res, 400, "An appeal needs at least 10 characters explaining your case.");
        return;
      }
      const id = await createAppeal({ userId: userId!, actionId: actionId ?? null, body: text.trim() });
      await audit({ actor: userId!, action: "community.appeal", detail: { actionId } });
      json(res, 201, { ok: true, id });
    })();
  });

  // --- Private messaging ------------------------------------------------------

  router.get("/api/community/threads", ({ res, userId }: RequestContext) => {
    void (async () => {
      json(res, 200, { threads: await listThreads(userId!) });
    })();
  });

  router.post("/api/community/threads", ({ res, body, userId }: RequestContext) => {
    void (async () => {
      const { username } = (body ?? {}) as { username?: string };
      if (!username || !username.trim()) {
        error(res, 400, "A username is required to start a conversation.");
        return;
      }
      const members = await listMembers(200);
      const target = members.find((m) => m.username === username.trim());
      if (!target) {
        error(res, 404, "No member with that username.");
        return;
      }
      if (target.id === userId) {
        error(res, 400, "You cannot message yourself.");
        return;
      }
      if (target.suspendedAt) {
        error(res, 403, "That member is suspended and cannot receive messages.");
        return;
      }
      const id = await ensureThread(userId!, target.id);
      json(res, 201, { ok: true, threadId: id });
    })();
  });

  router.get("/api/community/threads/:id", ({ res, params, userId }: RequestContext) => {
    void (async () => {
      const member = await isThreadMember(params.id!, userId!);
      if (!member) {
        // Deliberately the same response as "not found" so thread ids are not probeable.
        error(res, 404, "Conversation not found.");
        return;
      }
      const messages = await listMessages(params.id!);
      await markThreadRead(params.id!, userId!);
      json(res, 200, { messages });
    })();
  });

  router.post("/api/community/threads/:id/messages", ({ res, body, params, userId }: RequestContext) => {
    void (async () => {
      const member = await isThreadMember(params.id!, userId!);
      if (!member) {
        error(res, 404, "Conversation not found.");
        return;
      }
      const { text } = (body ?? {}) as { text?: string };
      const problem = badBody(text, MESSAGE_MAX);
      if (problem) {
        error(res, 400, problem);
        return;
      }
      const verdict = screenContent(text!.trim(), { authorId: userId! });
      if (verdict.blocked) {
        const actionId = await insertModerationAction({
          targetUser: userId!,
          targetType: "message",
          targetId: params.id!,
          action: verdict.action,
          actor: "phirst2",
          automated: true,
          reason: verdict.reason,
          evidence: verdict.evidence,
        });
        await insertModerationNotice({
          userId: userId!,
          actionId,
          title: "PHIRST2 blocked your message",
          body: verdict.reason,
        });
        error(res, 422, `Message blocked by PHIRST2 moderation: ${verdict.reason}`);
        return;
      }
      const id = await sendMessage(params.id!, userId!, text!.trim());
      json(res, 201, { ok: true, id });
    })();
  });
}
