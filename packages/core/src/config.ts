/**
 * Central configuration. Every secret comes from the environment; nothing is hardcoded.
 * Fails fast with a precise message when a required value is missing or malformed.
 */
export interface Config {
  env: "development" | "production" | "test";
  databaseUrl: string;
  masterKey: Buffer;
  apiPort: number;
  webOrigin: string;
  sessionSecret: string;
  sessionTtlHours: number;
  geminiApiKey: string | null;
  geminiModel: string;
  /** Ordered fallbacks used when a configured model is retired by the provider. */
  geminiFallbackModels: string[];
  derivAppId: string | null;
  telegramBotToken: string | null;
  telegramAllowedChatIds: string[];
  logLevel: LogLevel;
  engineTickMs: number;
  paperStartingBalance: number;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") throw new Error(`Missing required environment variable ${name}`);
  return v;
}

function opt(name: string, fallback: string | null = null): string | null {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : fallback;
}

/** Master key must decode to exactly 32 bytes for AES-256-GCM. */
export function decodeMasterKey(raw: string): Buffer {
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, "base64");
  } catch {
    throw new Error("PHIRST_MASTER_KEY is not valid base64");
  }
  if (buf.length !== 32) {
    throw new Error(
      `PHIRST_MASTER_KEY must decode to exactly 32 bytes (got ${buf.length}). Generate with: openssl rand -base64 32`,
    );
  }
  return buf;
}

export function loadConfig(): Config {
  const env = (opt("NODE_ENV", "development") as Config["env"]) ?? "development";
  const masterRaw = opt("PHIRST_MASTER_KEY");
  if (!masterRaw) {
    throw new Error(
      "Missing PHIRST_MASTER_KEY. Generate with: openssl rand -base64 32 (must decode to exactly 32 bytes).",
    );
  }
  const apiPort = Number(opt("PHIRST_API_PORT", "12001"));
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    throw new Error(`PHIRST_API_PORT must be a valid TCP port, got ${opt("PHIRST_API_PORT")}`);
  }
  const logLevel = (opt("PHIRST_LOG_LEVEL", env === "production" ? "info" : "debug") as LogLevel) ?? "info";

  return {
    env,
    databaseUrl: req("DATABASE_URL"),
    masterKey: decodeMasterKey(masterRaw),
    apiPort,
    webOrigin: opt("PHIRST_WEB_ORIGIN", "http://localhost:12000") as string,
    sessionSecret: req("PHIRST_SESSION_SECRET"),
    sessionTtlHours: Number(opt("PHIRST_SESSION_TTL_HOURS", "72")),
    geminiApiKey: opt("GEMINI_API_KEY"),
    geminiModel: opt("PHIRST_GEMINI_MODEL", "gemini-3.5-flash") as string,
    geminiFallbackModels: (opt("PHIRST_GEMINI_FALLBACK_MODELS", "gemini-2.5-flash,gemini-flash-latest") as string)
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean),
    derivAppId: opt("DERIV_APP_ID"),
    telegramBotToken: opt("TELEGRAM_BOT_TOKEN"),
    telegramAllowedChatIds: (opt("TELEGRAM_ALLOWED_CHAT_IDS", "") as string)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    logLevel,
    engineTickMs: Number(opt("PHIRST_ENGINE_TICK_MS", "1000")),
    paperStartingBalance: Number(opt("PHIRST_PAPER_BALANCE", "10000")),
  };
}
