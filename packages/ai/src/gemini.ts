/**
 * Minimal Gemini client over the public REST API. No SDK dependency.
 * Every method fails soft: if the key is missing or the call fails, callers get a
 * structured error so the caller can label output as unavailable rather than invent it.
 */
export interface GeminiResult<T> {
  ok: boolean;
  value: T | null;
  error: string | null;
  model: string;
}

export interface GeminiOptions {
  apiKey: string | null;
  model: string;
  /**
   * Ordered fallbacks. If a model has been retired by the provider the next one is
   * tried, so a deprecation does not silently disable AI features.
   */
  fallbackModels?: string[];
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export class GeminiClient {
  constructor(private readonly opts: GeminiOptions) {}

  get available(): boolean {
    return Boolean(this.opts.apiKey);
  }

  /** Models to try, in order. */
  private get chain(): string[] {
    return [this.opts.model, ...(this.opts.fallbackModels ?? [])].filter((m, i, a) => m && a.indexOf(m) === i);
  }

  private async call(body: Record<string, unknown>, timeoutMs = 30_000): Promise<GeminiResult<string>> {
    if (!this.opts.apiKey) {
      return { ok: false, value: null, error: "GEMINI_API_KEY is not configured", model: this.opts.model };
    }
    let last: GeminiResult<string> = { ok: false, value: null, error: "No model attempted", model: this.opts.model };
    for (const model of this.chain) {
      const result = await this.callModel(model, body, timeoutMs);
      if (result.ok) return result;
      last = result;
      // Only a retired or unknown model justifies trying the next one.
      if (!/HTTP 404/.test(result.error ?? "")) return result;
      this.opts.log?.("gemini model unavailable, trying fallback", { model, error: result.error });
    }
    return last;
  }

  private async callModel(model: string, body: Record<string, unknown>, timeoutMs: number): Promise<GeminiResult<string>> {
    const apiKey = this.opts.apiKey;
    if (!apiKey) return { ok: false, value: null, error: "GEMINI_API_KEY is not configured", model };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const detail = text.slice(0, 300);
        this.opts.log?.("gemini call failed", { status: res.status, detail, model });
        return { ok: false, value: null, error: `Gemini HTTP ${res.status}: ${detail}`, model };
      }
      const parsed = JSON.parse(text) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      };
      const out = parsed.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      if (!out) return { ok: false, value: null, error: "Gemini returned an empty response", model };
      return { ok: true, value: out, error: null, model };
    } catch (err) {
      const message = (err as Error).name === "AbortError" ? `Gemini request timed out after ${timeoutMs}ms` : (err as Error).message;
      this.opts.log?.("gemini error", { error: message });
      return { ok: false, value: null, error: message, model: this.opts.model };
    } finally {
      clearTimeout(timer);
    }
  }

  async generate(prompt: string, opts: { system?: string; temperature?: number; maxTokens?: number } = {}): Promise<GeminiResult<string>> {
    return this.call({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
      generationConfig: {
        temperature: opts.temperature ?? 0.6,
        maxOutputTokens: opts.maxTokens ?? 1024,
      },
    });
  }

  /** Ask for JSON and parse it. Returns an error instead of guessing when parsing fails. */
  async generateJson<T>(prompt: string, opts: { system?: string; temperature?: number; maxTokens?: number } = {}): Promise<GeminiResult<T>> {
    const res = await this.call({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
      generationConfig: {
        temperature: opts.temperature ?? 0.3,
        maxOutputTokens: opts.maxTokens ?? 1024,
        responseMimeType: "application/json",
      },
    });
    if (!res.ok || res.value === null) return { ok: false, value: null, error: res.error, model: res.model };
    try {
      return { ok: true, value: JSON.parse(res.value) as T, error: null, model: res.model };
    } catch {
      return { ok: false, value: null, error: "Gemini returned malformed JSON", model: res.model };
    }
  }
}
