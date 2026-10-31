import {
  createInvite,
  listInvites,
  revokeInvite,
  listMembers,
  getUserProfile,
  setUserRole,
  setUserSuspended,
  listBrokerCatalog,
  setCatalogEntry,
  listModerationActions,
  revertModerationAction,
  listAppeals,
  resolveAppeal,
  listReports,
  resolveReport,
  getPlatformFlag,
  setPlatformFlag,
  audit,
  type Config,
  type Logger,
  type UserRole,
} from "@phirst/core";
import { json, error, type RequestContext, type Router } from "../http.ts";
import { PROVIDERS } from "@phirst/brokers";

/**
 * Owner administration. Every route here is registered with `ownerOnly: true`, so the
 * router refuses a non-owner before the handler runs. Owner-only controls stay exclusive
 * to the owner and cannot be reached by a member.
 */
export function registerAdminRoutes(router: Router, config: Config, log: Logger): void {
  // --- Platform state ---------------------------------------------------------

  router.get("/api/admin/overview", ({ res }: RequestContext) => {
    void (async () => {
      const [members, invites, catalog, moderation, reports, appeals] = await Promise.all([
        listMembers(200),
        listInvites(200),
        listBrokerCatalog(),
        listModerationActions(50),
        listReports("open"),
        listAppeals("open"),
      ]);
      const liveTradingEnabled = await getPlatformFlag<boolean>("liveTradingEnabled", false);
      json(res, 200, {
        liveTradingEnabled,
        counts: {
          members: members.length,
          owners: members.filter((m) => m.role === "owner").length,
          moderators: members.filter((m) => m.role === "moderator").length,
          suspended: members.filter((m) => m.suspendedAt).length,
          invitesAvailable: invites.filter((i) => i.state === "available").length,
          openReports: reports.length,
          openAppeals: appeals.length,
        },
        moderation: moderation.slice(0, 20),
      });
    })();
  }, true, { ownerOnly: true });

  /**
   * The global live-trading master switch. Only the owner can enable real-money trading
   * platform-wide; when disabled, no member can place a live order regardless of their
   * own settings. This is checked by the engine before any live order.
   */
  router.put("/api/admin/live-trading", ({ res, body, userId }: RequestContext) => {
    void (async () => {
      const { enabled, confirmation } = (body ?? {}) as { enabled?: boolean; confirmation?: string };
      if (typeof enabled !== "boolean") {
        error(res, 400, "`enabled` must be a boolean.");
        return;
      }
      if (enabled && confirmation !== "ENABLE GLOBAL LIVE TRADING") {
        error(res, 400, 'Enabling global live trading requires the exact phrase "ENABLE GLOBAL LIVE TRADING".');
        return;
      }
      await setPlatformFlag("liveTradingEnabled", enabled, userId ?? null);
      await audit({ actor: userId ?? "owner", action: "admin.live_trading", detail: { enabled } });
      log.warn("global live trading changed", { enabled });
      json(res, 200, { ok: true, liveTradingEnabled: enabled });
    })();
  }, true, { ownerOnly: true });

  // --- Invites ----------------------------------------------------------------

  router.get("/api/admin/invites", ({ res }: RequestContext) => {
    void (async () => {
      json(res, 200, { invites: await listInvites(200) });
    })();
  }, true, { ownerOnly: true });

  router.post("/api/admin/invites", ({ res, body, userId }: RequestContext) => {
    void (async () => {
      const { note, expiresInDays } = (body ?? {}) as { note?: string; expiresInDays?: number };
      const expiresAt = expiresInDays && expiresInDays > 0 ? new Date(Date.now() + expiresInDays * 86400_000) : null;
      const invite = await createInvite({ createdBy: userId!, note: note ?? null, expiresAt });
      await audit({ actor: userId!, action: "admin.invite_created", detail: { code: invite.code, note } });
      json(res, 201, { ok: true, invite });
    })();
  }, true, { ownerOnly: true });

  router.delete("/api/admin/invites/:code", ({ res, params, userId }: RequestContext) => {
    void (async () => {
      const ok = await revokeInvite(params.code!);
      if (!ok) {
        error(res, 404, "Invite not found, already used, or already revoked.");
        return;
      }
      await audit({ actor: userId!, action: "admin.invite_revoked", detail: { code: params.code } });
      json(res, 200, { ok: true });
    })();
  }, true, { ownerOnly: true });

  // --- Members ----------------------------------------------------------------

  router.get("/api/admin/members", ({ res }: RequestContext) => {
    void (async () => {
      json(res, 200, { members: await listMembers(200) });
    })();
  }, true, { ownerOnly: true });

  router.put("/api/admin/members/:id/role", ({ res, body, params, userId }: RequestContext) => {
    void (async () => {
      const { role } = (body ?? {}) as { role?: UserRole };
      if (role !== "owner" && role !== "moderator" && role !== "member") {
        error(res, 400, "role must be owner, moderator or member.");
        return;
      }
      // Ownership cannot be granted or transferred through this endpoint; it is fixed
      // at first-run setup. Refusing here keeps the single-owner guarantee intact.
      if (role === "owner") {
        error(res, 400, "Ownership cannot be reassigned. It is fixed when the owner account is created.");
        return;
      }
      const target = await getUserProfile(params.id!);
      if (!target) {
        error(res, 404, "Member not found.");
        return;
      }
      if (target.role === "owner") {
        error(res, 400, "The owner role cannot be changed.");
        return;
      }
      await setUserRole(params.id!, role);
      await audit({ actor: userId!, action: "admin.member_role", detail: { member: params.id, role } });
      json(res, 200, { ok: true });
    })();
  }, true, { ownerOnly: true });

  router.put("/api/admin/members/:id/suspension", ({ res, body, params, userId }: RequestContext) => {
    void (async () => {
      const { suspended, reason } = (body ?? {}) as { suspended?: boolean; reason?: string };
      if (typeof suspended !== "boolean") {
        error(res, 400, "`suspended` must be a boolean.");
        return;
      }
      if (suspended && (!reason || reason.trim().length < 3)) {
        error(res, 400, "A suspension reason is required.");
        return;
      }
      const target = await getUserProfile(params.id!);
      if (!target) {
        error(res, 404, "Member not found.");
        return;
      }
      if (target.role === "owner") {
        error(res, 400, "The owner cannot be suspended.");
        return;
      }
      await setUserSuspended(params.id!, suspended ? reason!.trim() : null);
      await audit({ actor: userId!, action: suspended ? "admin.member_suspended" : "admin.member_restored", detail: { member: params.id, reason } });
      json(res, 200, { ok: true });
    })();
  }, true, { ownerOnly: true });

  // --- Broker catalog ---------------------------------------------------------

  router.get("/api/admin/broker-catalog", ({ res }: RequestContext) => {
    void (async () => {
      const catalog = await listBrokerCatalog();
      // Join the owner's enable/disable choices onto the real provider catalog so the
      // dashboard shows every adapter that exists in the build.
      const merged = PROVIDERS.map((p) => ({
        ...p,
        enabled: catalog.find((c) => c.provider === p.id)?.enabled ?? true,
        note: catalog.find((c) => c.provider === p.id)?.note ?? null,
      }));
      json(res, 200, { providers: merged });
    })();
  }, true, { ownerOnly: true });

  router.put("/api/admin/broker-catalog/:provider", ({ res, body, params, userId }: RequestContext) => {
    void (async () => {
      const { enabled, note } = (body ?? {}) as { enabled?: boolean; note?: string };
      if (typeof enabled !== "boolean") {
        error(res, 400, "`enabled` must be a boolean.");
        return;
      }
      const known = PROVIDERS.some((p) => p.id === params.provider);
      if (!known) {
        error(res, 404, `Unknown provider ${params.provider}.`);
        return;
      }
      await setCatalogEntry(params.provider!, enabled, userId!, note ?? null);
      await audit({ actor: userId!, action: "admin.catalog", detail: { provider: params.provider, enabled } });
      json(res, 200, { ok: true });
    })();
  }, true, { ownerOnly: true });

  // --- Moderation review ------------------------------------------------------

  router.get("/api/admin/moderation", ({ res }: RequestContext) => {
    void (async () => {
      const [actions, appeals, reports] = await Promise.all([listModerationActions(100), listAppeals(), listReports("open")]);
      json(res, 200, { actions, appeals, reports });
    })();
  }, true, { ownerOnly: true });

  router.post("/api/admin/moderation/:id/revert", ({ res, params, userId }: RequestContext) => {
    void (async () => {
      await revertModerationAction(params.id!, userId!);
      await audit({ actor: userId!, action: "admin.moderation_reverted", detail: { action: params.id } });
      json(res, 200, { ok: true });
    })();
  }, true, { ownerOnly: true });

  router.post("/api/admin/appeals/:id/resolve", ({ res, body, params, userId }: RequestContext) => {
    void (async () => {
      const { status, resolution } = (body ?? {}) as { status?: "upheld" | "denied"; resolution?: string };
      if (status !== "upheld" && status !== "denied") {
        error(res, 400, "status must be upheld or denied.");
        return;
      }
      await resolveAppeal(params.id!, userId!, status, resolution ?? "");
      await audit({ actor: userId!, action: "admin.appeal_resolved", detail: { appeal: params.id, status } });
      json(res, 200, { ok: true });
    })();
  }, true, { ownerOnly: true });

  router.post("/api/admin/reports/:id/resolve", ({ res, body, params, userId }: RequestContext) => {
    void (async () => {
      const { status } = (body ?? {}) as { status?: "actioned" | "dismissed" };
      if (status !== "actioned" && status !== "dismissed") {
        error(res, 400, "status must be actioned or dismissed.");
        return;
      }
      await resolveReport(params.id!, status);
      await audit({ actor: userId!, action: "admin.report_resolved", detail: { report: params.id, status } });
      json(res, 200, { ok: true });
    })();
  }, true, { ownerOnly: true });
}
