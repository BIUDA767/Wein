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
  // --- Deriv OAuth 2.0 (one-tap account connection) ---------------------------
  /**
   * OAuth2 client id issued when an OAuth app is registered with Deriv. Distinct from
   * `derivAppId`, which is the public app id used for market data and PAT requests.
   */
  derivOauthClientId: string | null;
  /**
   * Absolute callback URL. Deriv requires it to match the registered value exactly,
   * including scheme, host, port and trailing slash.
   */
  derivOauthRedirectUri: string | null;
  /** Space-separated scopes requested at the authorization endpoint. */
  derivOauthScopes: string;
  telegramBotToken: string | null;
  telegramAllowedChatIds: string[];
  logLevel: LogLevel;
  engineTickMs: number;
  /**
   * Deadline for the LLM call on the trading decision path. Kept short: the agent panel is
   * advisory and must not hold the tick loop open when the model is slow or rate limited.
   */
  llmTimeoutMs: number;
  paperStartingBalance: number;

  // --- Twelve Data (market data) ---------------------------------------------
  twelveDataApiKey: string | null;
  /**
   * Which provider supplies market data for quotes, candles and the instrument list.
   * `deriv` (the broker's own public feed) is the default; `twelve_data` routes reads
   * through the Twelve Data REST API. Order execution is always the active broker.
   */
  marketDataProvider: "deriv" | "twelve_data";

  // --- Resend (email) ---------------------------------------------------------
  resendApiKey: string | null;
  /** Verified sender. Must be a domain verified in Resend, or onboarding@resend.dev. */
  resendFrom: string;
  resendReplyTo: string | null;

  // --- Supabase (auth + platform data) ---------------------------------------
  supabaseUrl: string | null;
  /** Public/anon key. Safe to expose to the browser; never grants privileged access. */
  supabaseAnonKey: string | null;
  /** Service-role key. Server-only. Never sent to the browser and never logged. */
  supabaseServiceRoleKey: string | null;
  supabaseJwksUrl: string | null;
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

  // Twelve Data is optional. When no key is present the market-data provider falls back
  // to the broker's own feed so the app still runs; the integration reports "not
  // configured" rather than pretending to have a data feed.
  const marketDataProvider = (opt("PHIRST_MARKET_DATA_PROVIDER", "deriv") as Config["marketDataProvider"]) ?? "deriv";
  if (marketDataProvider !== "deriv" && marketDataProvider !== "twelve_data") {
    throw new Error(`PHIRST_MARKET_DATA_PROVIDER must be "deriv" or "twelve_data", got ${marketDataProvider}`);
  }

  const supabaseUrl = opt("SUPABASE_URL");
  const supabaseJwksUrl = opt("SUPABASE_JWKS_URL", supabaseUrl ? `${supabaseUrl.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json` : null);

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
    geminiFallbackModels: (opt("PHIRST_GEMINI_FALLBACK_MODELS", "gemini-flash-latest,gemini-3.1-pro-preview") as string)
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean),
    derivAppId: opt("DERIV_APP_ID"),
    derivOauthClientId: opt("DERIV_OAUTH_CLIENT_ID"),
    // Defaults to the web origin's callback path so a deployment that sets only
    // DERIV_OAUTH_CLIENT_ID still gets a correct redirect. The value registered at Deriv
    // must match this exactly, so it is shown in the UI rather than hidden.
    derivOauthRedirectUri: opt(
      "DERIV_OAUTH_REDIRECT_URI",
      `${(opt("PHIRST_WEB_ORIGIN", "http://localhost:12000") as string).replace(/\/$/, "")}/api/deriv/oauth/callback`,
    ),
    // Minimum scopes for the features that exist: read accounts and place trades.
    // `account_manage` and `payment` are deliberately not requested; nothing in Wein needs
    // to create accounts or move money.
    derivOauthScopes: opt("DERIV_OAUTH_SCOPES", "trade") as string,
    telegramBotToken: opt("TELEGRAM_BOT_TOKEN"),
    telegramAllowedChatIds: (opt("TELEGRAM_ALLOWED_CHAT_IDS", "") as string)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    logLevel,
    engineTickMs: Number(opt("PHIRST_ENGINE_TICK_MS", "1000")),
    llmTimeoutMs: Number(opt("PHIRST_LLM_TIMEOUT_MS", "8000")),
    paperStartingBalance: Number(opt("PHIRST_PAPER_BALANCE", "10000")),

    twelveDataApiKey: opt("TWELVE_DATA_API_KEY"),
    marketDataProvider,

    resendApiKey: opt("RESEND_API_KEY"),
    // Resend's shared test sender works without a verified domain. A real deployment sets
    // RESEND_FROM to an address on a domain verified in the Resend dashboard.
    resendFrom: opt("RESEND_FROM", "Wein <onboarding@resend.dev>") as string,
    resendReplyTo: opt("RESEND_REPLY_TO"),

    supabaseUrl,
    supabaseAnonKey: opt("SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: opt("SUPABASE_SERVICE_ROLE_KEY"),
    supabaseJwksUrl,
  };
}
