"use client";

import { useEffect, useState } from "react";
import { api, ApiFailure } from "@/lib/api";
import { Spinner } from "./ui";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"loading" | "setup" | "login" | "ready">("loading");
  const [username, setUsername] = useState("baelay");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const status = await api.get<{ ownerExists: boolean }>("/api/auth/status");
        if (!status.ownerExists) {
          setState("setup");
          return;
        }
        try {
          await api.get<{ authenticated: boolean }>("/api/auth/me");
          setState("ready");
        } catch {
          setState("login");
        }
      } catch (err) {
        setError((err as Error).message);
        setState("login");
      }
    })();
  }, []);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      if (state === "setup") {
        if (password.length < 12) throw new ApiFailure(400, "Password must be at least 12 characters.");
        if (password !== confirm) throw new ApiFailure(400, "Passwords do not match.");
        await api.post("/api/auth/setup", { username: username.trim(), password });
      } else {
        await api.post("/api/auth/login", { username: username.trim(), password });
      }
      setState("ready");
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (state === "ready") return <>{children}</>;

  if (state === "loading") {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center">
        <Spinner size={26} />
      </div>
    );
  }

  const isSetup = state === "setup";

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center px-6">
      <div className="w-full max-w-[380px] animate-fade-up">
        <div className="mb-8 text-center">
          <div
            className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-3xl border border-champagne-500/30"
            style={{ background: "linear-gradient(160deg, rgba(212,184,120,0.18), rgba(16,185,129,0.08))" }}
          >
            <span className="font-display text-[26px] font-semibold text-champagne-300">P</span>
          </div>
          <h1 className="font-display text-[30px] tracking-tight text-white">PHIRST2</h1>
          <p className="mt-1.5 text-[13px] text-white/45">
            {isSetup ? "Create the owner account to begin." : "Sign in to continue."}
          </p>
        </div>

        <div className="glass p-5">
          <div className="mb-4">
            <label className="label" htmlFor="username">Owner</label>
            <input
              id="username"
              className="field"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
            />
          </div>
          <div className="mb-4">
            <label className="label" htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              className="field"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isSetup ? "new-password" : "current-password"}
              placeholder={isSetup ? "At least 12 characters" : ""}
              onKeyDown={(e) => e.key === "Enter" && !isSetup && void submit()}
            />
          </div>
          {isSetup && (
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

          <button className="btn-primary w-full" onClick={() => void submit()} disabled={busy || !password}>
            {busy ? <Spinner /> : isSetup ? "Create owner account" : "Sign in"}
          </button>

          {isSetup && (
            <p className="mt-4 text-[11.5px] leading-relaxed text-white/35">
              This is a one-time setup. The owner account cannot be created again once it exists.
            </p>
          )}
        </div>

        <p className="mt-6 text-center text-[11px] leading-relaxed text-white/30">
          PHIRST2 — Calm in execution. Precise in judgement. Relentless in discipline.
        </p>
      </div>
    </div>
  );
}
