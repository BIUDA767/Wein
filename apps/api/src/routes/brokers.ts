import {
  Vault,
  createBroker,
  listBrokers,
  getBroker,
  updateBrokerStatus,
  setActiveBroker,
  deleteBroker,
  upsertAccount,
  listAccounts,
  setActiveAccount,
  getActiveBroker,
  setActiveTradingAccount,
  ensureActiveAfterConnect,
  getActiveSelection,
  getActiveConnectionHealth,
  toPublicBroker,
  audit,
  type Config,
  type Logger,
} from "@phirst/core";
import { PROVIDERS, getProvider, createAdapter, type BrokerCredentials, type BrokerAdapter } from "@phirst/brokers";
import { json, error, type RequestContext, type Router } from "../http.ts";

/** Fields that must never be echoed back to the client. */
const SECRET_FIELDS = ["token", "apiSecret", "password", "secret", "apiKey"];

function redactCapabilities(caps: Record<string, unknown>): Record<string, unknown> {
  return caps;
}

export function registerBrokerRoutes(
  router: Router,
  config: Config,
  log: Logger,
  vault: Vault,
  onBrokersChanged: () => Promise<void>,
): void {
  router.owner.get("/api/brokers/providers", ({ res }: RequestContext) => {
    json(res, 200, {
      providers: PROVIDERS.map((p) => ({
        id: p.id,
        name: p.name,
        assetClasses: p.assetClasses,
        implemented: p.implemented,
        requires: p.requires,
        fiveSecondExpiry: p.fiveSecondExpiry,
        docsUrl: p.docsUrl,
        notes: p.notes,
      })),
    });
  });

  router.owner.get("/api/brokers", ({ res }: RequestContext) => {
    void (async () => {
      const rows = await listBrokers();
      const active = await getActiveBroker();
      json(res, 200, {
        brokers: rows.map((b) => ({
          id: b.id,
          provider: b.provider,
          label: b.label,
          status: b.status,
          isActive: b.id === active?.id,
          credentialFingerprint: b.credential_fingerprint,
          lastVerifiedAt: b.last_verified_at,
          lastError: b.last_error,
          capabilities: redactCapabilities(b.capabilities as Record<string, unknown>),
          // OAuth connection state. No token is ever included; only its non-secret metadata.
          authMethod: b.auth_method ?? "pat",
          oauthExpiresAt: b.oauth_expires_at ?? null,
          oauthExpired: Boolean(b.oauth_expires_at && new Date(b.oauth_expires_at).getTime() <= Date.now()),
          oauthScope: b.oauth_scope ?? null,
          createdAt: b.created_at,
        })),
      });
    })();
  });

  // Create a broker connection. Credentials are encrypted before they touch the database.
  router.owner.post("/api/brokers", ({ res, body, ip }: RequestContext) => {
    void (async () => {
      const { provider, label, credentials } = (body ?? {}) as {
        provider?: string;
        label?: string;
        credentials?: BrokerCredentials;
      };
      if (!provider || !getProvider(provider)) {
        error(res, 400, `Unknown provider. Supported: ${PROVIDERS.map((p) => p.id).join(", ")}`);
        return;
      }
      const spec = getProvider(provider)!;
      if (!spec.implemented) {
        error(res, 400, `${spec.name} has no adapter yet. Required: ${spec.requires.join(", ")}`, {
          requiredFields: spec.requires,
        });
        return;
      }
      if (!label || label.trim().length === 0) {
        error(res, 400, "A label is required.");
        return;
      }
      const creds: BrokerCredentials = { ...(credentials ?? {}) };
      if (provider === "deriv" && creds.appId === undefined) creds.appId = config.derivAppId ?? undefined;

      const primary = creds.token ?? creds.apiKey ?? "";
      const encrypted = vault.encrypt(JSON.stringify(creds));
      const fingerprint = vault.fingerprint(primary || `${provider}:${label}`);
      const row = await createBroker({
        provider,
        label: label.trim(),
        credentialsEnc: encrypted,
        fingerprint,
        capabilities: {},
      });
      await audit({ actor: "user", action: "broker.create", target: row.id, detail: { provider, label }, ip });

      // Verify immediately so the UI can report the true state.
      const adapter = createAdapter({
        provider,
        credentials: creds,
        paperStartingBalance: config.paperStartingBalance,
        log: (msg, fields) => log.debug(msg, fields),
      });
      let check;
      try {
        check = await adapter.verifyConnection();
      } catch (err) {
        check = { ok: false, authenticated: false, accounts: [], message: (err as Error).message };
      }
      for (const acct of check.accounts) await upsertAccount(row.id, acct);
      await updateBrokerStatus(row.id, check.ok ? "connected" : "error", check.ok ? null : check.message, adapter.capabilities() as unknown as Record<string, unknown>);
      // Smart selection: only claims the active slot when nothing else holds it.
      const selection = await ensureActiveAfterConnect(row.id);
      await onBrokersChanged();
      await adapter.close?.();

      json(res, 201, {
        id: row.id,
        verified: check.ok,
        authenticated: check.authenticated,
        message: check.message,
        accounts: check.accounts,
        capabilities: adapter.capabilities(),
        selection,
      });
    })();
  });

  router.owner.post("/api/brokers/:id/verify", ({ res, params }: RequestContext) => {
    void (async () => {
      const row = await getBroker(params.id!);
      if (!row) {
        error(res, 404, "Broker not found.");
        return;
      }
      const creds = JSON.parse(vault.decrypt(row.credentials_enc)) as BrokerCredentials;
      const adapter = createAdapter({
        provider: row.provider,
        credentials: creds,
        paperStartingBalance: config.paperStartingBalance,
        log: (msg, fields) => log.debug(msg, fields),
      });
      let check;
      try {
        check = await adapter.verifyConnection();
      } catch (err) {
        check = { ok: false, authenticated: false, accounts: [], message: (err as Error).message };
      }
      for (const acct of check.accounts) await upsertAccount(row.id, acct);
      await updateBrokerStatus(row.id, check.ok ? "connected" : "error", check.ok ? null : check.message, adapter.capabilities() as unknown as Record<string, unknown>);
      await onBrokersChanged();
      await adapter.close?.();
      json(res, 200, {
        verified: check.ok,
        authenticated: check.authenticated,
        message: check.message,
        accounts: check.accounts,
        capabilities: adapter.capabilities(),
      });
    })();
  });

  router.owner.get("/api/brokers/:id/accounts", ({ res, params }: RequestContext) => {
    void (async () => {
      const rows = await listAccounts(params.id!);
      json(res, 200, { accounts: rows });
    })();
  });

  router.owner.post("/api/brokers/:id/activate", ({ res, params, ip }: RequestContext) => {
    void (async () => {
      const row = await getBroker(params.id!);
      if (!row) {
        error(res, 404, "Broker not found.");
        return;
      }
      await setActiveBroker(row.id);
      await audit({ actor: "user", action: "broker.activate", target: row.id, ip });
      await onBrokersChanged();
      json(res, 200, { ok: true, activeBrokerId: row.id });
    })();
  });

  router.owner.post("/api/accounts/:id/activate", ({ res, params, body, ip }: RequestContext) => {
    void (async () => {
      const { confirm } = (body ?? {}) as { confirm?: boolean };
      const result = await setActiveTradingAccount(params.id!, { confirm: confirm === true });
      await audit({
        actor: "user",
        action: "account.activate",
        target: params.id!,
        detail: { ok: result.ok, requiresConfirmation: result.requiresConfirmation },
        ip,
      });
      if (!result.ok) {
        error(res, result.requiresConfirmation ? 409 : 404, result.message, {
          requiresConfirmation: result.requiresConfirmation,
        });
        return;
      }
      await onBrokersChanged();
      json(res, 200, { ok: true, selection: result.selection });
    })();
  });

  // The active selection and its health, in one call. Drives the connection banner and the
  // "active account" indicator without the UI having to infer either from two responses.
  router.owner.get("/api/brokers/active", ({ res }: RequestContext) => {
    void (async () => {
      const [selection, health] = await Promise.all([getActiveSelection(), getActiveConnectionHealth()]);
      json(res, 200, {
        selection,
        health: { ...health, broker: health.broker ? toPublicBroker(health.broker) : null },
      });
    })();
  });

  // The active account row with its real stored balance and currency. This is the single
  // source the header reads for the displayed balance, so the number is always the value
  // the broker reported at the last verification, never a client-side guess.
  router.owner.get("/api/accounts/active", ({ res }: RequestContext) => {
    void (async () => {
      const selection = await getActiveSelection();
      const accounts = await listAccounts();
      const active = accounts.find((a) => a.is_active) ?? null;
      const accountsForBroker = selection.brokerId ? accounts.filter((a) => a.broker_id === selection.brokerId) : [];
      json(res, 200, {
        selection,
        account: active
          ? {
              id: String(active.id),
              accountId: String(active.account_id),
              accountType: String(active.account_type),
              currency: String(active.currency ?? "USD"),
              balance: active.balance === null || active.balance === undefined ? null : Number(active.balance),
              loginid: active.loginid ? String(active.loginid) : null,
              label: active.label ? String(active.label) : null,
              status: active.status ? String(active.status) : null,
              brokerId: String(active.broker_id),
            }
          : null,
        accounts: accountsForBroker.map((a) => ({
          id: String(a.id),
          accountId: String(a.account_id),
          accountType: String(a.account_type),
          currency: String(a.currency ?? "USD"),
          balance: a.balance === null || a.balance === undefined ? null : Number(a.balance),
          loginid: a.loginid ? String(a.loginid) : null,
          label: a.label ? String(a.label) : null,
          status: a.status ? String(a.status) : null,
          brokerId: String(a.broker_id),
          isActive: a.is_active === true,
        })),
      });
    })();
  });

  router.owner.delete("/api/brokers/:id", ({ res, params, ip }: RequestContext) => {
    void (async () => {
      const row = await getBroker(params.id!);
      if (!row) {
        error(res, 404, "Broker not found.");
        return;
      }
      await deleteBroker(row.id);
      await audit({ actor: "user", action: "broker.delete", target: row.id, detail: { provider: row.provider }, ip });
      await onBrokersChanged();
      json(res, 200, { ok: true });
    })();
  });
}
