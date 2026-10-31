"use client";

import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiFailure,
  type CommentRecord,
  type MemberRecord,
  type MessageRecord,
  type PostRecord,
  type ThreadRecord,
} from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { Card, EmptyState, Pill, SectionTitle, Spinner } from "./ui";

function Avatar({ name, seed, size = 34 }: { name: string; seed: string | null; size?: number }) {
  // Deterministic hue from the seed so a member keeps the same colour everywhere.
  const hue = seed ? Array.from(seed).reduce((a, c) => a + c.charCodeAt(0), 0) % 360 : 210;
  const initials = name.slice(0, 2).toUpperCase();
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full border border-white/12 font-semibold text-white/90"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.36,
        background: `linear-gradient(150deg, hsl(${hue} 45% 32%), hsl(${hue} 40% 18%))`,
      }}
    >
      {initials}
    </div>
  );
}

// --- Community feed -----------------------------------------------------------

export function CommunityScreen({ notify }: { notify: (t: string, tone?: "neutral" | "good" | "bad" | "warn") => void }) {
  const { identity } = useSession();
  const [posts, setPosts] = useState<PostRecord[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [openComments, setOpenComments] = useState<string | null>(null);
  const [comments, setComments] = useState<CommentRecord[]>([]);
  const [commentText, setCommentText] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ posts: PostRecord[] }>("/api/community/posts");
      setPosts(res.posts);
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 12000);
    return () => clearInterval(id);
  }, [load]);

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api.post("/api/community/posts", { text: text.trim() });
      setText("");
      await load();
      notify("Posted.", "good");
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  const like = async (id: string) => {
    try {
      await api.post(`/api/community/posts/${id}/like`);
      await load();
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    }
  };

  const openThread = async (id: string) => {
    setOpenComments(id);
    try {
      const res = await api.get<{ comments: CommentRecord[] }>(`/api/community/posts/${id}`);
      setComments(res.comments);
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    }
  };

  const addComment = async () => {
    if (!openComments || !commentText.trim()) return;
    try {
      const res = await api.post<{ comments: CommentRecord[] }>(`/api/community/posts/${openComments}/comments`, { text: commentText.trim() });
      setComments(res.comments);
      setCommentText("");
      await load();
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    }
  };

  const remove = async (id: string) => {
    try {
      await api.del(`/api/community/posts/${id}`);
      await load();
      notify("Post removed.", "good");
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    }
  };

  const report = async (id: string) => {
    const reason = window.prompt("Why are you reporting this post?");
    if (!reason || reason.trim().length < 3) return;
    try {
      await api.post("/api/community/reports", { targetType: "post", targetId: id, reason: reason.trim() });
      notify("Reported for review.", "good");
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    }
  };

  return (
    <div className="space-y-3">
      <Card>
        <SectionTitle>Share with the community</SectionTitle>
        <textarea
          className="field mb-3"
          rows={3}
          placeholder="Talk about a strategy, an instrument or a lesson learned. Never post credentials or balances."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="btn-primary w-full" onClick={() => void submit()} disabled={busy || !text.trim()}>
          {busy ? <Spinner /> : "Post"}
        </button>
        <p className="mt-2 text-[11px] leading-relaxed text-white/35">
          PHIRST2 screens every post for spam, scams and harassment before it appears.
        </p>
      </Card>

      {loading ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : posts.length === 0 ? (
        <Card>
          <EmptyState title="Nothing here yet" body="The community feed is empty. Share the first idea." />
        </Card>
      ) : (
        posts.map((p) => (
          <Card key={p.id}>
            <div className="mb-3 flex items-center gap-3">
              <Avatar name={p.authorName} seed={p.authorSeed} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13.5px] font-semibold text-white/90">{p.authorName}</span>
                  {p.authorRole === "owner" && <Pill tone="gold">owner</Pill>}
                  {p.authorRole === "moderator" && <Pill tone="good">moderator</Pill>}
                </div>
                <div className="text-[10.5px] text-white/30">{timeAgo(p.createdAt)}</div>
              </div>
            </div>
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-white/80">{p.body}</p>
            <div className="mt-3 flex items-center gap-4 border-t border-white/6 pt-3 text-[12px]">
              <button className={`active:opacity-70 ${p.likedByMe ? "text-emerald-400" : "text-white/50"}`} onClick={() => void like(p.id)}>
                ♥ {p.likeCount}
              </button>
              <button className="text-white/50 active:opacity-70" onClick={() => void openThread(p.id)}>
                💬 {p.commentCount}
              </button>
              {p.authorId === identity.id ? (
                <button className="ml-auto text-ruby-400/80 active:opacity-70" onClick={() => void remove(p.id)}>Delete</button>
              ) : (
                <button className="ml-auto text-white/35 active:opacity-70" onClick={() => void report(p.id)}>Report</button>
              )}
            </div>
          </Card>
        ))
      )}

      {openComments && (
        <div className="fixed inset-0 z-[70]">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setOpenComments(null)} />
          <div className="sheet safe-bottom flex max-h-[80dvh] flex-col">
            <div className="flex items-center justify-between border-b border-white/8 px-5 py-4">
              <h3 className="text-[16px] font-semibold text-white">Comments</h3>
              <button onClick={() => setOpenComments(null)} className="rounded-full border border-white/12 px-3 py-1 text-[12px] text-white/70">Done</button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {comments.length === 0 ? (
                <EmptyState title="No comments" body="Be the first to reply." />
              ) : (
                comments.map((c) => (
                  <div key={c.id} className="border-b border-white/6 py-3 last:border-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[12.5px] font-semibold text-white/85">{c.authorName}</span>
                      {c.authorRole === "owner" && <Pill tone="gold">owner</Pill>}
                      <span className="ml-auto text-[10.5px] text-white/30">{timeAgo(c.createdAt)}</span>
                    </div>
                    <p className="mt-1 text-[12.5px] leading-relaxed text-white/70">{c.body}</p>
                  </div>
                ))
              )}
            </div>
            <div className="border-t border-white/8 px-5 py-3">
              <div className="flex gap-2">
                <input className="field flex-1" placeholder="Add a comment" value={commentText} onChange={(e) => setCommentText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void addComment()} />
                <button className="btn-primary px-5" onClick={() => void addComment()} disabled={!commentText.trim()}>Send</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Private messaging --------------------------------------------------------

export function MessagingScreen({ notify }: { notify: (t: string, tone?: "neutral" | "good" | "bad" | "warn") => void }) {
  const { identity } = useSession();
  const [threads, setThreads] = useState<ThreadRecord[]>([]);
  const [active, setActive] = useState<ThreadRecord | null>(null);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [text, setText] = useState("");
  const [newTo, setNewTo] = useState("");
  const [loading, setLoading] = useState(true);

  const loadThreads = useCallback(async () => {
    try {
      const res = await api.get<{ threads: ThreadRecord[] }>("/api/community/threads");
      setThreads(res.threads);
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { void loadThreads(); }, [loadThreads]);

  const openThread = async (t: ThreadRecord) => {
    setActive(t);
    try {
      const res = await api.get<{ messages: MessageRecord[] }>(`/api/community/threads/${t.id}`);
      setMessages(res.messages);
      await loadThreads();
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    }
  };

  const send = async () => {
    if (!active || !text.trim()) return;
    try {
      await api.post(`/api/community/threads/${active.id}/messages`, { text: text.trim() });
      setText("");
      const res = await api.get<{ messages: MessageRecord[] }>(`/api/community/threads/${active.id}`);
      setMessages(res.messages);
      await loadThreads();
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    }
  };

  const start = async () => {
    if (!newTo.trim()) return;
    try {
      const res = await api.post<{ threadId: string }>("/api/community/threads", { username: newTo.trim() });
      setNewTo("");
      await loadThreads();
      const list = await api.get<{ threads: ThreadRecord[] }>("/api/community/threads");
      const t = list.threads.find((x) => x.id === res.threadId);
      if (t) void openThread(t);
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    }
  };

  if (active) {
    return (
      <div className="space-y-3">
        <Card>
          <div className="flex items-center gap-3">
            <button className="text-[13px] text-white/50" onClick={() => setActive(null)}>‹ Back</button>
            <Avatar name={active.otherName} seed={active.otherSeed} size={30} />
            <span className="text-[14px] font-semibold text-white/90">{active.otherName}</span>
          </div>
        </Card>
        <Card className="!p-3">
          <div className="flex max-h-[52dvh] flex-col gap-2 overflow-y-auto px-1 py-1">
            {messages.length === 0 ? (
              <EmptyState title="No messages yet" body="Say hello." />
            ) : (
              messages.map((m) => {
                const mine = m.senderId === identity.id;
                return (
                  <div key={m.id} className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed ${mine ? "self-end bg-emerald-600/25 text-white" : "self-start bg-white/6 text-white/85"}`}>
                    {m.body}
                    <div className="mt-1 text-[10px] text-white/35">{timeAgo(m.createdAt)}</div>
                  </div>
                );
              })
            )}
          </div>
        </Card>
        <div className="flex gap-2">
          <input className="field flex-1" placeholder="Message" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void send()} />
          <button className="btn-primary px-5" onClick={() => void send()} disabled={!text.trim()}>Send</button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Card>
        <SectionTitle>New conversation</SectionTitle>
        <div className="flex gap-2">
          <input className="field flex-1" placeholder="Username" value={newTo} onChange={(e) => setNewTo(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void start()} />
          <button className="btn-ghost px-5" onClick={() => void start()} disabled={!newTo.trim()}>Start</button>
        </div>
      </Card>
      <Card>
        <SectionTitle>Conversations</SectionTitle>
        {loading ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : threads.length === 0 ? (
          <EmptyState title="No conversations" body="Start one with a member's username." />
        ) : (
          threads.map((t) => (
            <button key={t.id} onClick={() => void openThread(t)} className="flex w-full items-center gap-3 border-b border-white/6 py-3 text-left last:border-0 active:opacity-70">
              <Avatar name={t.otherName} seed={t.otherSeed} size={36} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-medium text-white/90">{t.otherName}</div>
                <div className="text-[10.5px] text-white/30">{timeAgo(t.lastMessageAt)}</div>
              </div>
              {t.unreadCount > 0 && <Pill tone="good">{t.unreadCount}</Pill>}
            </button>
          ))
        )}
      </Card>
    </div>
  );
}

// --- Members ------------------------------------------------------------------

export function MembersScreen({ notify }: { notify: (t: string, tone?: "neutral" | "good" | "bad" | "warn") => void }) {
  const [members, setMembers] = useState<MemberRecord[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<{ members: MemberRecord[] }>("/api/community/members");
        setMembers(res.members);
      } catch (err) {
        notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
      } finally {
        setLoading(false);
      }
    })();
  }, [notify]);

  return (
    <Card>
      <SectionTitle>Members</SectionTitle>
      {loading ? (
        <div className="flex justify-center py-6"><Spinner /></div>
      ) : members.length === 0 ? (
        <EmptyState title="No members" body="Invited members appear here." />
      ) : (
        members.map((m) => (
          <div key={m.id} className="flex items-center gap-3 border-b border-white/6 py-3 last:border-0">
            <Avatar name={m.displayName ?? m.username} seed={m.avatarSeed} size={36} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[13.5px] font-medium text-white/90">{m.displayName ?? m.username}</span>
                {m.role === "owner" && <Pill tone="gold">owner</Pill>}
                {m.role === "moderator" && <Pill tone="good">moderator</Pill>}
                {m.suspended && <Pill tone="bad">suspended</Pill>}
              </div>
              {m.bio && <div className="truncate text-[11.5px] text-white/40">{m.bio}</div>}
            </div>
          </div>
        ))
      )}
    </Card>
  );
}
