import {
  countUsers,
  createUser,
  findUserByUsername,
  findUserById as queryUserById,
  createSession,
  findSession,
  deleteSession,
  deleteOtherSessions,
  updateUserPassword,
  hashPassword,
  verifyPassword,
  issueSessionToken,
  hashSessionToken,
  audit,
  setUserRole,
  getUserRole,
  getUserProfile,
  redeemInvite,
  updateProfile,
  deleteUser,
  type Config,
  type Logger,
} from "@phirst/core";
import { json, error, type RequestContext, type Router } from "../http.ts";

const SESSION_COOKIE = "phirst_session";

function setSessionCookie(res: RequestContext["res"], token: string, expires: Date, secure: boolean): void {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expires.toUTCString()}`,
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res: RequestContext["res"]): void {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function registerAuthRoutes(router: Router, config: Config, log: Logger): void {
  const secureCookie = config.env === "production";

  // Public: report whether the owner account exists yet.
  router.get("/api/auth/status", ({ res }: RequestContext) => {
    void (async () => {
      const users = await countUsers();
      json(res, 200, { ownerExists: users > 0, inviteRequired: users > 0 });
    })();
  }, false);

  // Public, one-time: create the owner account. Refuses if an owner already exists.
  router.post("/api/auth/setup", ({ res, body, ip }: RequestContext) => {
    void (async () => {
      const existing = await countUsers();
      if (existing > 0) {
        error(res, 409, "An owner account already exists. Sign in instead.");
        return;
      }
      const { username, password } = (body ?? {}) as { username?: string; password?: string };
      if (!username || username.trim().length < 3) {
        error(res, 400, "Username must be at least 3 characters.");
        return;
      }
      if (!password || password.length < 12) {
        error(res, 400, "Password must be at least 12 characters.");
        return;
      }
      const user = await createUser(username.trim(), JSON.stringify(hashPassword(password)));
      // The account created here is the platform owner. The unique partial index
      // on users(role) WHERE role='owner' guarantees there can never be two.
      await setUserRole(user.id, "owner");
      const token = issueSessionToken(config.sessionTtlHours);
      await createSession(user.id, token.hash, token.expiresAt, null);
      setSessionCookie(res, token.token, token.expiresAt, secureCookie);
      await audit({ actor: user.username, action: "auth.setup", ip });
      log.info("owner account created", { username: user.username });
      json(res, 201, { ok: true, username: user.username });
    })();
  }, false);

  /**
   * Invite-only registration. The owner account is created once through /setup; every
   * other account must present a valid, unused, unrevoked invite code. This is the only
   * path that creates a non-owner account.
   */
  router.post("/api/auth/register", ({ res, body, ip }: RequestContext) => {
    void (async () => {
      const { username, password, inviteCode, displayName } = (body ?? {}) as {
        username?: string;
        password?: string;
        inviteCode?: string;
        displayName?: string;
      };
      if (!username || username.trim().length < 3) {
        error(res, 400, "Username must be at least 3 characters.");
        return;
      }
      if (!password || password.length < 12) {
        error(res, 400, "Password must be at least 12 characters.");
        return;
      }
      if (!inviteCode || !inviteCode.trim()) {
        error(res, 403, "Registration is invite-only. An invite code is required.");
        return;
      }
      const existing = await findUserByUsername(username.trim());
      if (existing) {
        error(res, 409, "That username is taken.");
        return;
      }
      // Create the user first, then redeem. If the code was already consumed the
      // redeem fails and the freshly created row is removed, so a bad code cannot
      // leave a half-registered account behind.
      const user = await createUser(username.trim(), JSON.stringify(hashPassword(password)));
      const ok = await redeemInvite(inviteCode.trim(), user.id);
      if (!ok) {
        await deleteUser(user.id).catch(() => {});
        error(res, 403, "That invite code is invalid, already used, revoked or expired.");
        return;
      }
      if (displayName && displayName.trim()) await updateProfile(user.id, { displayName: displayName.trim() });
      const token = issueSessionToken(config.sessionTtlHours);
      await createSession(user.id, token.hash, token.expiresAt, null);
      setSessionCookie(res, token.token, token.expiresAt, secureCookie);
      await audit({ actor: user.username, action: "auth.register", detail: { invite: inviteCode.trim() }, ip });
      log.info("member registered", { username: user.username });
      json(res, 201, { ok: true, username: user.username, role: "member" });
    })();
  }, false);

  router.post("/api/auth/login", ({ res, body, ip, req }: RequestContext) => {
    void (async () => {
      const { username, password } = (body ?? {}) as { username?: string; password?: string };
      if (!username || !password) {
        error(res, 400, "Username and password are required.");
        return;
      }
      const user = await findUserByUsername(username.trim());
      // Always run a comparison to keep timing similar for unknown users.
      const stored = user ? (JSON.parse(user.password_hash) as ReturnType<typeof hashPassword>) : hashPassword("nonexistent-placeholder");
      const ok = verifyPassword(password, stored) && Boolean(user);
      if (!ok || !user) {
        await audit({ actor: username, action: "auth.login_failed", ip });
        error(res, 401, "Invalid username or password.");
        return;
      }
      const token = issueSessionToken(config.sessionTtlHours);
      await createSession(user.id, token.hash, token.expiresAt, String(req.headers["user-agent"] ?? ""));
      setSessionCookie(res, token.token, token.expiresAt, secureCookie);
      await audit({ actor: user.username, action: "auth.login", ip });
      const role = (await getUserRole(user.id)) ?? "member";
      json(res, 200, { ok: true, username: user.username, role });
    })();
  }, false);

  router.post("/api/auth/logout", ({ res, cookies, ip }: RequestContext) => {
    void (async () => {
      const token = cookies[SESSION_COOKIE];
      if (token) await deleteSession(hashSessionToken(token));
      clearSessionCookie(res);
      await audit({ actor: "user", action: "auth.logout", ip });
      json(res, 200, { ok: true });
    })();
  });

  /**
   * Change the owner password. Requires the current password, so a stolen session alone
   * cannot lock the owner out. Every other session is revoked.
   */
  router.post("/api/auth/change-password", ({ res, body, cookies, ip }: RequestContext) => {
    void (async () => {
      const token = cookies[SESSION_COOKIE];
      if (!token) {
        error(res, 401, "Not signed in.");
        return;
      }
      const session = await findSession(hashSessionToken(token));
      if (!session || new Date(session.expires_at).getTime() < Date.now()) {
        clearSessionCookie(res);
        error(res, 401, "Session expired.");
        return;
      }
      const { currentPassword, newPassword } = (body ?? {}) as { currentPassword?: string; newPassword?: string };
      if (!currentPassword || !newPassword) {
        error(res, 400, "Current and new passwords are required.");
        return;
      }
      if (newPassword.length < 12) {
        error(res, 400, "New password must be at least 12 characters.");
        return;
      }
      if (newPassword === currentPassword) {
        error(res, 400, "New password must differ from the current password.");
        return;
      }
      const user = await queryUserById(session.user_id);
      if (!user) {
        error(res, 401, "Account not found.");
        return;
      }
      const stored = JSON.parse(user.password_hash) as ReturnType<typeof hashPassword>;
      if (!verifyPassword(currentPassword, stored)) {
        await audit({ actor: user.username, action: "auth.change_password_failed", ip });
        error(res, 401, "Current password is incorrect.");
        return;
      }
      await updateUserPassword(user.id, JSON.stringify(hashPassword(newPassword)));
      const revoked = await deleteOtherSessions(user.id, hashSessionToken(token));
      await audit({ actor: user.username, action: "auth.change_password", detail: { sessionsRevoked: revoked }, ip });
      json(res, 200, { ok: true, sessionsRevoked: revoked });
    })();
  });

  router.get("/api/auth/me", ({ res, cookies }: RequestContext) => {
    void (async () => {
      const token = cookies[SESSION_COOKIE];
      if (!token) {
        error(res, 401, "Not signed in.");
        return;
      }
      const session = await findSession(hashSessionToken(token));
      if (!session || new Date(session.expires_at).getTime() < Date.now()) {
        clearSessionCookie(res);
        error(res, 401, "Session expired.");
        return;
      }
      const profile = await getUserProfile(session.user_id);
      if (!profile || profile.suspendedAt) {
        clearSessionCookie(res);
        error(res, 401, "Account is not active.");
        return;
      }
      json(res, 200, {
        authenticated: true,
        user: {
          id: profile.id,
          username: profile.username,
          displayName: profile.displayName,
          role: profile.role,
          avatarSeed: profile.avatarSeed,
        },
      });
    })();
  }, false);
}
