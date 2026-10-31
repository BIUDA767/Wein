"use client";

import { createContext, useContext } from "react";
import type { Identity } from "./api";

/**
 * The signed-in identity, resolved once by AuthGate from `/api/auth/me`.
 * Role comes from the server; the client never decides its own permissions. Screens use
 * it only to decide what to render - the API enforces the real check on every request.
 */
export interface Session {
  identity: Identity;
  isOwner: boolean;
  isModerator: boolean;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ identity, children }: { identity: Identity; children: React.ReactNode }) {
  const value: Session = {
    identity,
    isOwner: identity.role === "owner",
    isModerator: identity.role === "owner" || identity.role === "moderator",
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside a SessionProvider");
  return ctx;
}
