"use client";

import { useRef, useState } from "react";
import { Emblem } from "./Emblem";
import { NavIcon, type NavIconKey } from "./NavIcons";
import { Toast } from "./ui";
import { CommunityScreen, MembersScreen, MessagingScreen } from "./Community";
import { ProfileScreen, SupportScreen } from "./Screens";
import { useSession } from "@/lib/session";
import { sound } from "@/lib/sound";

type MemberTab = "community" | "messages" | "support" | "profile";

const TABS: Array<{ key: MemberTab; label: string; icon: NavIconKey }> = [
  { key: "community", label: "Community", icon: "discover" },
  { key: "messages", label: "Messages", icon: "assets" },
  { key: "support", label: "Support", icon: "positions" },
  { key: "profile", label: "Profile", icon: "more" },
];

interface ToastMessage {
  id: number;
  text: string;
  tone: "neutral" | "good" | "bad" | "warn";
}

/**
 * The member experience. A member never receives the engine snapshot, so this shell shows
 * the community surfaces and their own account settings only. Trading, broker, risk and
 * strategy controls live behind owner-only API routes and are not reachable from here.
 */
export function MemberShell() {
  const { identity, isModerator } = useSession();
  const [tab, setTab] = useState<MemberTab>("community");
  const [membersOpen, setMembersOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const seq = useRef(0);

  const notify = (text: string, tone: ToastMessage["tone"] = "neutral") => {
    const id = ++seq.current;
    setToasts((prev) => [...prev, { id, text, tone }]);
  };
  const dismiss = (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id));

  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-[720px] flex-col pb-24">
      {toasts.map((t) => (
        <Toast key={t.id} message={t.text} tone={t.tone} onDone={() => dismiss(t.id)} />
      ))}

      <header
        className="safe-top sticky top-0 z-40 px-4 pb-3 backdrop-blur-xl"
        style={{
          background: "linear-gradient(180deg, rgba(10,10,11,0.92) 0%, rgba(10,10,11,0.82) 100%)",
          borderBottom: "1px solid transparent",
          borderImage:
            "linear-gradient(90deg, transparent, rgba(166,175,186,0.22) 22%, rgba(212,175,55,0.30) 50%, rgba(166,175,186,0.22) 78%, transparent) 1",
        }}
      >
        <div className="flex items-center gap-2.5 pt-1">
          <Emblem size={30} className="shrink-0 drop-shadow-[0_2px_6px_rgba(212,175,55,0.25)]" />
          <div>
            <span className="font-display text-[15px] tracking-[0.14em] text-white">WEIN</span>
            <div className="mt-0.5 text-[10.5px] text-white/40">
              {identity.displayName || identity.username} · {identity.role}
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 px-4 pt-4">
        {membersOpen ? (
          <>
            <button
              className="mb-3 flex items-center gap-1.5 text-[13px] font-medium text-white/55 transition hover:text-white/80 active:opacity-70"
              onClick={() => { sound.play("tap"); setMembersOpen(false); }}
            >
              <span className="text-[15px] leading-none">‹</span> Back
            </button>
            <MembersScreen notify={notify} />
          </>
        ) : (
          <>
            {tab === "community" && (
              <>
                {isModerator && (
                  <button
                    className="btn-ghost mb-3 w-full"
                    onClick={() => { sound.play("tap"); setMembersOpen(true); }}
                  >
                    Open member directory
                  </button>
                )}
                <CommunityScreen notify={notify} />
              </>
            )}
            {tab === "messages" && <MessagingScreen notify={notify} />}
            {tab === "support" && <SupportScreen notify={notify} />}
            {tab === "profile" && <ProfileScreen notify={notify} />}
          </>
        )}
      </main>

      <nav className="tabbar z-40">
        <div className="mx-auto flex max-w-[720px] items-stretch">
          {TABS.map((item) => {
            const active = tab === item.key && !membersOpen;
            return (
              <button
                key={item.key}
                onClick={() => { sound.play("tap"); setTab(item.key); setMembersOpen(false); }}
                aria-current={active ? "page" : undefined}
                className={`relative flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px] font-medium transition ${
                  active ? "text-champagne-300" : "text-white/40 hover:text-white/60"
                }`}
              >
                <span
                  className={`absolute inset-x-3 top-0 h-px transition-opacity duration-200 ${active ? "opacity-100" : "opacity-0"}`}
                  style={{ background: "linear-gradient(90deg, transparent, rgba(232,206,122,0.85), transparent)" }}
                />
                <NavIcon name={item.icon} filled={active} size={21} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
