import { DerivAdapter } from "./adapters/deriv.ts";
import { PaperAdapter } from "./adapters/paper.ts";
import { BrokerError, type BrokerAdapter, type BrokerCredentials } from "./types.ts";
import { getProvider } from "./providers.ts";

export interface CreateAdapterOptions {
  provider: string;
  credentials: BrokerCredentials;
  paperStartingBalance?: number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

/** Build a live adapter, or the paper simulator backed by real Deriv market data. */
export function createAdapter(opts: CreateAdapterOptions): BrokerAdapter {
  const spec = getProvider(opts.provider);
  if (!spec) throw new BrokerError(`Unknown provider ${opts.provider}`, "unsupported");
  if (!spec.implemented) {
    throw new BrokerError(
      `Provider ${spec.name} is catalogued but no adapter is implemented yet. Required: ${spec.requires.join(", ")}`,
      "unsupported",
    );
  }
  if (opts.provider === "deriv") {
    return new DerivAdapter(opts.credentials, opts.log);
  }
  if (opts.provider === "paper") {
    // Paper fills use the real public Deriv market data stream.
    const market = new DerivAdapter({ appId: opts.credentials.appId ?? "1089" }, opts.log);
    return new PaperAdapter(market, opts.credentials, opts.paperStartingBalance ?? 10_000);
  }
  throw new BrokerError(`No adapter branch for ${opts.provider}`, "unsupported");
}
