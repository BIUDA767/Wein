import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GeminiClient } from "@phirst/ai";

/**
 * Gemini 3.x charges internal reasoning against maxOutputTokens. Without an explicit
 * thinking budget a short answer arrives truncated because the reasoning consumed the
 * budget. These tests pin that behaviour and the model-fallback rule.
 */

function geminiResponse(text: string, finishReason = "STOP") {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("GeminiClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sentBody(callIndex = 0): Record<string, unknown> {
    const [, init] = fetchMock.mock.calls[callIndex] as [string, RequestInit];
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  }

  it("disables thinking by default so the reply budget is not consumed by reasoning", async () => {
    fetchMock.mockResolvedValueOnce(geminiResponse("OK"));
    const client = new GeminiClient({ apiKey: "k", model: "gemini-3.5-flash" });

    await client.generate("hi", { maxTokens: 700 });

    const config = sentBody().generationConfig as { maxOutputTokens: number; thinkingConfig: { thinkingBudget: number } };
    expect(config.thinkingConfig.thinkingBudget).toBe(0);
    expect(config.maxOutputTokens).toBe(700);
  });

  it("passes a caller-supplied thinking budget through unchanged", async () => {
    fetchMock.mockResolvedValueOnce(geminiResponse("analysis"));
    const client = new GeminiClient({ apiKey: "k", model: "gemini-3.5-flash" });

    await client.generate("analyse", { thinkingBudget: 512 });

    const config = sentBody().generationConfig as { thinkingConfig: { thinkingBudget: number } };
    expect(config.thinkingConfig.thinkingBudget).toBe(512);
  });

  it("requests a JSON mime type only for generateJson", async () => {
    fetchMock.mockResolvedValue(jsonResponseOnce('{"supportive":true}'));
    const client = new GeminiClient({ apiKey: "k", model: "gemini-3.5-flash" });

    await client.generateJson<{ supportive: boolean }>("assess");

    const config = sentBody().generationConfig as { responseMimeType?: string };
    expect(config.responseMimeType).toBe("application/json");
  });

  it("falls back when a model is retired (HTTP 404)", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 }))
      .mockResolvedValueOnce(geminiResponse("from fallback"));
    const client = new GeminiClient({ apiKey: "k", model: "gemini-2.5-flash", fallbackModels: ["gemini-flash-latest"] });

    const result = await client.generate("hi");

    expect(result.ok).toBe(true);
    expect(result.value).toBe("from fallback");
    expect(result.model).toBe("gemini-flash-latest");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back on a transient provider fault (HTTP 503), since capacity is per-model", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 }))
      .mockResolvedValueOnce(geminiResponse("from fallback"));
    const client = new GeminiClient({ apiKey: "k", model: "gemini-3.5-flash", fallbackModels: ["gemini-flash-latest"] });

    const result = await client.generate("hi");

    expect(result.ok).toBe(true);
    expect(result.value).toBe("from fallback");
    expect(result.model).toBe("gemini-flash-latest");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry the next model on a request or credential fault", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 403 }));
    const client = new GeminiClient({ apiKey: "k", model: "gemini-3.5-flash", fallbackModels: ["gemini-flash-latest"] });

    const result = await client.generate("hi");

    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the upstream response body out of the surfaced error", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "quota for project 1234567890 exceeded" } }), { status: 429 }),
    );
    const client = new GeminiClient({ apiKey: "k", model: "gemini-3.5-flash" });

    const result = await client.generate("hi");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Gemini HTTP 429");
    expect(result.error).not.toMatch(/project 1234567890/);
  });

  it("returns a structured error rather than inventing output when no key is set", async () => {
    const client = new GeminiClient({ apiKey: null, model: "gemini-3.5-flash" });

    expect(client.available).toBe(false);
    const result = await client.generate("hi");

    expect(result.ok).toBe(false);
    expect(result.value).toBeNull();
    expect(result.error).toMatch(/GEMINI_API_KEY is not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports malformed JSON as an error instead of guessing a value", async () => {
    fetchMock.mockResolvedValueOnce(geminiResponse("not json at all"));
    const client = new GeminiClient({ apiKey: "k", model: "gemini-3.5-flash" });

    const result = await client.generateJson("assess");

    expect(result.ok).toBe(false);
    expect(result.value).toBeNull();
    expect(result.error).toMatch(/malformed JSON/);
  });
});

function jsonResponseOnce(text: string): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
