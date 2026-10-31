import {
  audit,
  consumeOAuthState,
  createBroker,
  ensureActiveAfterConnect,
  getBroker,
  insertNotification,
  insertOAuthState,
  setBrokerCredentials,
  setBrokerOAuth,
  updateBrokerStatus,
  upsertAccount,
  type Config,
  type Logger,
  type Vault,
} from "@phirst/core";
import {
  buildAuthorizeUrl,
  createAdapter,
  deriveCodeChallenge,
  exchangeCodeForToken,
  generateCodeVerifier,
  generateState,
  OAuthError,
  type BrokerCredentials,
} from "@phirst/brokers";
import { json, error, type RequestContext, type Router } from "../http.ts";

/**
 * Deriv OAuth 2.0 one-tap account connection.
 *
 * Flow:
 *   1. POST /api/deriv/oauth/start   — owner-only. Generates PKCE verifier + challenge and
 *      a CSRF state, stores them server-side, and returns Deriv's authorization URL.
 *   2. The browser navigates to Deriv, where the user logs in and approves scopes.
 *   3. GET  /api/deriv/oauth/callback — public, because Deriv's redirect carries no session.
 *      The state is validated and consumed atomically, the code is exchanged server-side,
 *      and the resulting token is encrypted before it is stored.
 *
 * Nothing secret reaches the browser: the verifier stays server-side, the token exchange
 * happens here, and the callback response is a redirect carrying only a short status word.
 */

/** The authorization code is single-use and short-lived; the state window matches. */
const STATE_TTL_MS = 10 * 60 * 1000;

interface CallbackQuery {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

/** Redirect the browser back into the app with a short, non-sensitive status. */
function redirectToApp(res: RequestContext["res"], webOrigin: string, params: Record<string, string>): void {
  const url = new URL("/", webOrigin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  res.writeHead(302, { Location: url.toString(), "Cache-Control": "no-store" });
  res.end();
}

export function registerDerivOAuthRoutes(
  router: Router,
  config: Config,
  log: Logger,
  vault: Vault,
  onBrokersChanged: () => Promise<void>,
): void {
  const configured = Boolean(config.derivOauthClientId && config.derivOauthRedirectUri);

  // What the UI needs to render the connect control honestly. The client id is not a secret
  // (it is sent in a URL), but it is not echoed here either; only whether it is set.
  router.owner.get("/api/deriv/oauth/config", ({ res }: RequestContext) => {
    json(res, 200, {
      configured,
      provider: "deriv",
      redirectUri: config.derivOauthRedirectUri,
      scopes: config.derivOauthScopes.split(/\s+/).filter(Boolean),
      authorizationEndpoint: "https://auth.deriv.com/oauth2/auth",
      // Names the exact environment variables a deployment must set. Never their values.
      requiredEnv: ["DERIV_OAUTH_CLIENT_ID", "DERIV_OAUTH_REDIRECT_URI"],
    });
  });

  const start = (intent: "connect" | "reconnect") => {
    return ({ res, body, userId, ip }: RequestContext): void => {
      void (async () => {
        if (!configured) {
          error(res, 503, "Deriv OAuth is not configured on this deployment.", {
            requiredEnv: ["DERIV_OAUTH_CLIENT_ID", "DERIV_OAUTH_REDIRECT_URI"],
          });
          return;
        }
        const { brokerId } = (body ?? {}) as { brokerId?: string };

        if (intent === "reconnect") {
          if (!brokerId) {
            error(res, 400, "brokerId is required to reconnect.");
            return;
          }
          const broker = await getBroker(brokerId);
          if (!broker) {
            error(res, 404, "Broker not found.");
            return;
          }
          if (broker.provider !== "deriv") {
            error(res, 400, "Only Deriv connections use OAuth reauthorization.");
            return;
          }
        }

        const codeVerifier = generateCodeVerifier();
        const codeChallenge = deriveCodeChallenge(codeVerifier);
        const state = generateState();
        const redirectUri = config.derivOauthRedirectUri!;

        await insertOAuthState({
          state,
          provider: "deriv",
          userId: userId!,
          codeVerifierEnc: vault.encrypt(codeVerifier),
          redirectUri,
          intent,
          brokerId: intent === "reconnect" ? brokerId! : null,
          expiresAt: new Date(Date.now() + STATE_TTL_MS),
        });

        const url = buildAuthorizeUrl({
          clientId: config.derivOauthClientId!,
          redirectUri,
          scopes: config.derivOauthScopes,
          state,
          codeChallenge,
        });
        await audit({ actor: "user", action: `deriv.oauth.${intent}_start`, detail: { intent }, ip });
        json(res, 200, { url });
      })();
    };
  };

  router.owner.post("/api/deriv/oauth/start", start("connect"));
  router.owner.post("/api/deriv/oauth/reconnect", start("reconnect"));

  // Public: Deriv's redirect arrives without a Wein session. The `state` row is the
  // authorisation proof, and it is single-use.
  router.get(
    "/api/deriv/oauth/callback",
    ({ res, url, ip }: RequestContext) => {
      void (async () => {
        const q: CallbackQuery = {
          code: url.searchParams.get("code") ?? undefined,
          state: url.searchParams.get("state") ?? undefined,
          error: url.searchParams.get("error") ?? undefined,
          error_description: url.searchParams.get("error_description") ?? undefined,
        };

        // Deriv reports a user cancellation or provider error before any state is needed.
        if (q.error) {
          const reason = q.error === "access_denied" ? "cancelled" : q.error;
          log.warn("deriv oauth callback returned an error", { error: q.error, description: q.error_description });
          redirectToApp(res, config.webOrigin, { deriv: "error", reason });
          return;
        }

        if (!q.state || !q.code) {
          log.warn("deriv oauth callback missing code or state");
          redirectToApp(res, config.webOrigin, { deriv: "error", reason: "invalid_callback" });
          return;
        }

        // Atomically read-and-consume. Unknown, replayed and expired states all return null.
        const stateRow = await consumeOAuthState(q.state);
        if (!stateRow) {
          log.warn("deriv oauth state rejected", { ip });
          redirectToApp(res, config.webOrigin, { deriv: "error", reason: "invalid_state" });
          return;
        }

        let codeVerifier: string;
        try {
          codeVerifier = vault.decrypt(stateRow.code_verifier_enc);
        } catch {
          log.error("deriv oauth code verifier could not be decrypted");
          redirectToApp(res, config.webOrigin, { deriv: "error", reason: "server_error" });
          return;
        }

        let token;
        try {
          token = await exchangeCodeForToken({
            clientId: config.derivOauthClientId!,
            code: q.code,
            codeVerifier,
            // The exact value sent in the authorization request, not a recomputed one.
            redirectUri: stateRow.redirect_uri,
            log: (m, f) => log.debug(m, f),
          });
        } catch (err) {
          const e = err as OAuthError;
          log.warn("deriv oauth token exchange failed", { code: e.code, status: e.status });
          redirectToApp(res, config.webOrigin, { deriv: "error", reason: e.code });
          return;
        }

        const expiresAt = new Date(Date.now() + token.expiresIn * 1000);
        const credentials: BrokerCredentials = {
          token: token.accessToken,
          authMethod: "oauth",
          // OAuth requests do not need a Deriv-App-ID; kept for parity with PAT connections.
          appId: config.derivAppId ?? undefined,
        };
        const encrypted = vault.encrypt(JSON.stringify(credentials));
        const fingerprint = vault.fingerprint(`deriv:oauth:${token.accessToken.slice(-12)}`);

        // Verify the token against Deriv before storing anything, so a connection is only
        // ever recorded as "connected" when Deriv itself confirms it.
        const adapter = createAdapter({
          provider: "deriv",
          credentials,
          log: (msg, fields) => log.debug(msg, fields),
        });
        let check;
        try {
          check = await adapter.verifyConnection();
        } catch (err) {
          check = { ok: false, authenticated: false, accounts: [], message: (err as Error).message };
        }

        let brokerId: string;
        if (stateRow.intent === "reconnect" && stateRow.broker_id) {
          // Replace the token in place, keeping the broker's id, label and active account.
          await setBrokerCredentials(stateRow.broker_id, encrypted, fingerprint);
          brokerId = stateRow.broker_id;
        } else {
          const row = await createBroker({
            provider: "deriv",
            label: "Deriv",
            credentialsEnc: encrypted,
            fingerprint,
            capabilities: {},
          });
          brokerId = row.id;
        }

        await setBrokerOAuth({ brokerId, oauthExpiresAt: expiresAt, scope: token.scope ?? config.derivOauthScopes });
        for (const acct of check.accounts) await upsertAccount(brokerId, acct);
        await updateBrokerStatus(
          brokerId,
          check.ok ? "connected" : "error",
          check.ok ? null : check.message,
          adapter.capabilities() as unknown as Record<string, unknown>,
        );

        // Smart active-account selection: never replaces an existing active account.
        const selection = await ensureActiveAfterConnect(brokerId);
        await onBrokersChanged();
        await adapter.close?.();

        await audit({
          actor: "user",
          action: `deriv.oauth.${stateRow.intent === "reconnect" ? "reconnect" : "connect"}`,
          target: brokerId,
          detail: { verified: check.ok, accounts: check.accounts.length, activeChanged: selection.changed },
          ip,
        });

        if (!check.ok) {
          await insertNotification({
            severity: "warn",
            title: "Deriv connected but verification failed",
            body: check.message,
            category: "broker",
            meta: { brokerId },
          }).catch(() => {});
          redirectToApp(res, config.webOrigin, { deriv: "unverified", broker: brokerId });
          return;
        }

        await insertNotification({
          severity: "info",
          title: stateRow.intent === "reconnect" ? "Deriv reconnected" : "Deriv connected",
          body: `${check.accounts.length} account(s) available. ${selection.message}`,
          category: "broker",
          meta: { brokerId, accounts: check.accounts.length },
        }).catch(() => {});

        redirectToApp(res, config.webOrigin, { deriv: "connected", broker: brokerId });
      })();
    },
    false,
  );
}
