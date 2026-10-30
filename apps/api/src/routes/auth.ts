import {
  countUsers,
  createUser,
  findUserByUsername,
  createSession,
  findSession,
  deleteSession,
  hashPassword,
  verifyPassword,
  issueSessionToken,
  hashSessionToken,
  audit,
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
      json(res, 200, { ownerExists: users > 0 });
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
      const token = issueSessionToken(config.sessionTtlHours);
      await createSession(user.id, token.hash, token.expiresAt, null);
      setSessionCookie(res, token.token, token.expiresAt, secureCookie);
      await audit({ actor: user.username, action: "auth.setup", ip });
      log.info("owner account created", { username: user.username });
      json(res, 201, { ok: true, username: user.username });
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
      json(res, 200, { ok: true, username: user.username });
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
      json(res, 200, { authenticated: true });
    })();
  }, false);
}
