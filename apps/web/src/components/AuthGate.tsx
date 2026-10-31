"use client";

import { useEffect, useState } from "react";
import { api, ApiFailure, type MeResponse } from "@/lib/api";
import { Spinner } from "./ui";
import { SessionProvider } from "@/lib/session";

export type AuthMode = "setup" | "login" | "register";

/**
 * Authentication gate. Three real modes:
 *  - setup:    first run only; creates the owner account.
 *  - login:    an existing account signs in.
 *  - register: invite-only registration for a member.
 * The mode is decided by the server, never by a client flag, so a member cannot reach
 * the owner-setup path once an owner exists.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"loading" | "gate" | "ready">("loading");
  const [mode, setMode] = useState<AuthMode>("login");
  const [inviteRequired, setInviteRequired] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<MeResponse["user"] | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const status = await api.get<{ ownerExists: boolean; inviteRequired: boolean }>("/api/auth/status");
        setInviteRequired(status.inviteRequired);
        if (!status.ownerExists) {
          setMode("setup");
          setState("gate");
          return;
        }
        try {
          const me = await api.get<MeResponse>("/api/auth/me");
          setIdentity(me.user);
          setState("ready");
        } catch {
          setMode("login");
          setState("gate");
        }
      } catch (err) {
        setError((err as Error).message);
        setState("gate");
      }
    })();
  }, []);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      if (mode === "setup") {
        if (password.length < 12) throw new ApiFailure(400, "Password must be at least 12 characters.");
        if (password !== confirm) throw new ApiFailure(400, "Passwords do not match.");
        await api.post("/api/auth/setup", { username: username.trim(), password });
      } else if (mode === "register") {
        if (password.length < 12) throw new ApiFailure(400, "Password must be at least 12 characters.");
        if (password !== confirm) throw new ApiFailure(400, "Passwords do not match.");
        if (!inviteCode.trim()) throw new ApiFailure(403, "An invite code is required to register.");
        await api.post("/api/auth/register", {
          username: username.trim(),
          password,
          inviteCode: inviteCode.trim(),
          displayName: displayName.trim() || undefined,
        });
      } else {
        await api.post("/api/auth/login", { username: username.trim(), password });
      }
      const me = await api.get<MeResponse>("/api/auth/me");
      setIdentity(me.user);
      setState("ready");
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (state === "ready" && identity) {
    return <SessionProvider identity={identity}>{children}</SessionProvider>;
  }

  if (state === "loading") {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center">
        <Spinner size={26} />
      </div>
    );
  }

  const isSetup = mode === "setup";
  const isRegister = mode === "register";

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center px-6 py-10">
      <div className="w-full max-w-[380px] animate-fade-up">
        <div className="mb-8 text-center">
          <div
            className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-3xl border border-champagne-500/30"
            style={{ background: "linear-gradient(160deg, rgba(212,175,55,0.18), rgba(0,200,83,0.08))" }}
          >
            <span className="font-display text-[26px] font-semibold text-champagne-300">W</span>
          </div>
          <h1 className="font-display text-[30px] tracking-[0.18em] text-white">WEIN</h1>
          <p className="mt-1 text-[13px] text-white/40" lang="ja">ワイン</p>
          <p className="mt-2 text-[12.5px] text-white/45">
            {isSetup
              ? "Create the owner account to begin."
              : isRegister
                ? "Registration is invite-only."
                : "Sign in to continue."}
          </p>
        </div>

        <div className="glass p-5">
          {isRegister && (
            <div className="mb-4">
              <label className="label" htmlFor="invite">Invite code</label>
              <input
                id="invite"
                className="field mono-num"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder="Paste the code the owner gave you"
                autoComplete="off"
              />
            </div>
          )}

          <div className="mb-4">
            <label className="label" htmlFor="username">{isSetup ? "Owner" : "Username"}</label>
            <input
              id="username"
              className="field"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
            />
          </div>

          {isRegister && (
            <div className="mb-4">
              <label className="label" htmlFor="display">Display name (optional)</label>
              <input
                id="display"
                className="field"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Shown in the community"
                autoComplete="nickname"
              />
            </div>
          )}

          <div className="mb-4">
            <label className="label" htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              className="field"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isSetup || isRegister ? "new-password" : "current-password"}
              placeholder={isSetup || isRegister ? "At least 12 characters" : ""}
              onKeyDown={(e) => e.key === "Enter" && !isSetup && !isRegister && void submit()}
            />
          </div>

          {(isSetup || isRegister) && (
            <div className="mb-4">
              <label className="label" htmlFor="confirm">Confirm password</label>
              <input
                id="confirm"
                type="password"
                className="field"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                onKeyDown={(e) => e.key === "Enter" && void submit()}
              />
            </div>
          )}

          {error && (
            <div className="mb-4 rounded-2xl border border-ruby-500/35 bg-ruby-500/10 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ruby-400">
              {error}
            </div>
          )}

          <button className="btn-primary w-full" onClick={() => void submit()} disabled={busy || !password || !username}>
            {busy ? <Spinner /> : isSetup ? "Create owner account" : isRegister ? "Register" : "Sign in"}
          </button>

          {!isSetup && inviteRequired && (
            <div className="mt-4 text-center">
              {mode === "login" ? (
                <button
                  className="text-[12.5px] text-white/50 underline decoration-white/20 underline-offset-4"
                  onClick={() => { setMode("register"); setError(null); }}
                >
                  Have an invite code? Register
                </button>
              ) : (
                <button
                  className="text-[12.5px] text-white/50 underline decoration-white/20 underline-offset-4"
                  onClick={() => { setMode("login"); setError(null); }}
                >
                  Already registered? Sign in
                </button>
              )}
            </div>
          )}

          {isSetup && (
            <p className="mt-4 text-[11.5px] leading-relaxed text-white/35">
              This is a one-time setup. The owner account cannot be created again once it exists.
            </p>
          )}
          {isRegister && (
            <p className="mt-4 text-[11.5px] leading-relaxed text-white/35">
              Invite codes are issued by the owner. Each code works once.
            </p>
          )}
        </div>

        <p className="mt-6 text-center text-[11px] leading-relaxed text-white/30">
          WEIN — Calm in execution. Precise in judgement. Relentless in discipline.
        </p>
      </div>
    </div>
  );
}
