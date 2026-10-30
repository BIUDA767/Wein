import {
  issueTelegramLinkCode,
  listTelegramLinks,
  deleteTelegramLink,
  upsertTelegramLink,
  audit,
  newId,
  type Logger,
} from "@phirst/core";
import type { TelegramBot, TelegramPermission } from "../lib/telegram.ts";
import { json, error, type RequestContext, type Router } from "../http.ts";

const VALID_PERMISSIONS: TelegramPermission[] = ["read", "control", "trade", "emergency"];

export function registerTelegramRoutes(router: Router, bot: TelegramBot, log: Logger): void {
  router.get("/api/telegram/status", ({ res }: RequestContext) => {
    void (async () => {
      const links = await listTelegramLinks();
      json(res, 200, {
        ...bot.status(),
        links: links.map((l) => ({ chatId: l.chat_id, permissions: l.permissions, updatedAt: l.updated_at })),
        availablePermissions: VALID_PERMISSIONS,
      });
    })();
  });

  /** Issue a one-time link code. The user sends /start <code> to the bot. */
  router.post("/api/telegram/link-code", ({ res, ip }: RequestContext) => {
    void (async () => {
      if (!bot.configured) {
        error(res, 400, "TELEGRAM_BOT_TOKEN is not configured on the server. Set it and restart the API.");
        return;
      }
      const code = newId().replace(/-/g, "").slice(0, 12);
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      // The code is bound to the single owner user; the id is resolved at consume time.
      await issueTelegramLinkCode(code, "owner", expiresAt);
      await audit({ actor: "user", action: "telegram.link_code_issued", ip });
      log.info("telegram link code issued");
      json(res, 200, { code, expiresAt: expiresAt.toISOString(), instructions: `Send "/start ${code}" to the bot.` });
    })();
  });

  router.put("/api/telegram/links/:chatId", ({ res, params, body, ip }: RequestContext) => {
    void (async () => {
      const { permissions } = (body ?? {}) as { permissions?: string[] };
      if (!Array.isArray(permissions)) {
        error(res, 400, "permissions must be an array.");
        return;
      }
      const invalid = permissions.filter((p) => !VALID_PERMISSIONS.includes(p as TelegramPermission));
      if (invalid.length) {
        error(res, 400, `Invalid permissions: ${invalid.join(", ")}. Valid: ${VALID_PERMISSIONS.join(", ")}`);
        return;
      }
      const links = await listTelegramLinks();
      const existing = links.find((l) => String(l.chat_id) === params.chatId);
      if (!existing) {
        error(res, 404, "That chat is not linked. Issue a link code and send /start to the bot first.");
        return;
      }
      await upsertTelegramLink(params.chatId!, String(existing.user_id), permissions);
      await audit({ actor: "user", action: "telegram.permissions_update", target: params.chatId, detail: { permissions }, ip });
      json(res, 200, { ok: true });
    })();
  });

  router.delete("/api/telegram/links/:chatId", ({ res, params, ip }: RequestContext) => {
    void (async () => {
      await deleteTelegramLink(params.chatId!);
      await audit({ actor: "user", action: "telegram.unlink", target: params.chatId, ip });
      json(res, 200, { ok: true });
    })();
  });

  router.post("/api/telegram/test", ({ res, ip }: RequestContext) => {
    void (async () => {
      if (!bot.configured) {
        error(res, 400, "TELEGRAM_BOT_TOKEN is not configured on the server.");
        return;
      }
      const links = await listTelegramLinks();
      if (links.length === 0) {
        error(res, 400, "No Telegram chats are linked yet. Issue a link code and send /start to the bot.");
        return;
      }
      await bot.broadcast("PHIRST2 test message", "This is a test notification sent from the PHIRST2 web app.");
      await audit({ actor: "user", action: "telegram.test_broadcast", ip });
      json(res, 200, { ok: true, recipients: links.length });
    })();
  });
}
