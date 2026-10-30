import {
  listMemory,
  addMemory,
  deleteMemory,
  updateMemory,
  purgeMemory,
  getSetting,
  setSetting,
  listVerdicts,
  audit,
  type Config,
} from "@phirst/core";
import { GeminiClient, phirstReply, PHIRST2_IDENTITY, DEFAULT_VOICE_SETTINGS } from "@phirst/ai";
import type { TradingEngine } from "@phirst/engine";
import { json, error, type RequestContext, type Router } from "../http.ts";

/**
 * PHIRST2 companion routes.
 *
 * Facts supplied to the model are assembled from the engine and the database only.
 * Broker credentials are never included in any prompt or stored in memory.
 */
export function registerPhirstRoutes(router: Router, engine: TradingEngine, gemini: GeminiClient, config: Config): void {
  router.get("/api/phirst/identity", ({ res }: RequestContext) => {
    json(res, 200, {
      identity: PHIRST2_IDENTITY,
      llm: { available: gemini.available, model: gemini.available ? config.geminiModel : null },
      voiceDefaults: DEFAULT_VOICE_SETTINGS,
    });
  });

  router.post("/api/phirst/chat", ({ res, body, ip }: RequestContext) => {
    void (async () => {
      const { message } = (body ?? {}) as { message?: string };
      if (!message || message.trim().length === 0) { error(res, 400, "message is required."); return; }
      if (message.length > 2000) { error(res, 400, "message must be 2000 characters or fewer."); return; }

      const facts = await engine.phirstFacts();
      const memoryRows = await listMemory(25);
      const memory = memoryRows.map((m) => String(m.content));
      const reply = await phirstReply(message.trim(), facts, memory, gemini);
      await audit({ actor: "user", action: "phirst.chat", detail: { source: reply.source, urgency: reply.urgency }, ip });
      json(res, 200, {
        reply: reply.reply,
        source: reply.source,
        model: reply.model,
        urgency: reply.urgency,
        error: reply.error,
        facts,
      });
    })();
  });

  router.get("/api/phirst/memory", ({ res }: RequestContext) => {
    void (async () => { json(res, 200, { memory: await listMemory(200) }); })();
  });

  router.post("/api/phirst/memory", ({ res, body, ip }: RequestContext) => {
    void (async () => {
      const { content, kind, importance } = (body ?? {}) as { content?: string; kind?: string; importance?: number };
      if (!content || content.trim().length === 0) { error(res, 400, "content is required."); return; }
      const id = await addMemory({
        kind: kind ?? "note",
        content: content.trim().slice(0, 2000),
        importance: typeof importance === "number" ? Math.max(1, Math.min(5, Math.round(importance))) : 1,
        source: "user",
      });
      await audit({ actor: "user", action: "phirst.memory_add", target: id, ip });
      json(res, 201, { ok: true, id });
    })();
  });

  router.patch("/api/phirst/memory/:id", ({ res, params, body, ip }: RequestContext) => {
    void (async () => {
      const { content, importance } = (body ?? {}) as { content?: string; importance?: number };
      if (!content || content.trim().length === 0) { error(res, 400, "content is required."); return; }
      await updateMemory(params.id!, content.trim().slice(0, 2000), typeof importance === "number" ? Math.max(1, Math.min(5, Math.round(importance))) : 1);
      await audit({ actor: "user", action: "phirst.memory_update", target: params.id, ip });
      json(res, 200, { ok: true });
    })();
  });

  router.delete("/api/phirst/memory/:id", ({ res, params, ip }: RequestContext) => {
    void (async () => {
      await deleteMemory(params.id!);
      await audit({ actor: "user", action: "phirst.memory_delete", target: params.id, ip });
      json(res, 200, { ok: true });
    })();
  });

  router.post("/api/phirst/memory/purge", ({ res, ip }: RequestContext) => {
    void (async () => {
      await purgeMemory();
      await audit({ actor: "user", action: "phirst.memory_purge", ip });
      json(res, 200, { ok: true });
    })();
  });

  router.get("/api/phirst/voice", ({ res }: RequestContext) => {
    void (async () => {
      const stored = await getSetting<Record<string, unknown>>("voice");
      json(res, 200, { voice: stored ?? DEFAULT_VOICE_SETTINGS });
    })();
  });

  router.put("/api/phirst/voice", ({ res, body, ip }: RequestContext) => {
    void (async () => {
      const input = (body ?? {}) as Record<string, unknown>;
      const merged = { ...DEFAULT_VOICE_SETTINGS, ...input };
      if (merged.voice !== "male" && merged.voice !== "female") { error(res, 400, 'voice must be "male" or "female".'); return; }
      const rate = Number(merged.rate);
      const pitch = Number(merged.pitch);
      if (!Number.isFinite(rate) || rate < 0.5 || rate > 2) { error(res, 400, "rate must be between 0.5 and 2."); return; }
      if (!Number.isFinite(pitch) || pitch < 0 || pitch > 2) { error(res, 400, "pitch must be between 0 and 2."); return; }
      const clean = {
        enabled: Boolean(merged.enabled),
        voice: merged.voice,
        accent: String(merged.accent ?? "ja-JP-inspired"),
        rate,
        pitch,
        pushToTalk: Boolean(merged.pushToTalk),
        handsFree: Boolean(merged.handsFree),
        autoSpeakAlerts: Boolean(merged.autoSpeakAlerts),
      };
      await setSetting("voice", clean);
      await audit({ actor: "user", action: "phirst.voice_update", detail: clean, ip });
      json(res, 200, { ok: true, voice: clean });
    })();
  });

  router.get("/api/phirst/verdicts", ({ res, url }: RequestContext) => {
    void (async () => {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);
      json(res, 200, { verdicts: await listVerdicts(limit) });
    })();
  });
}
