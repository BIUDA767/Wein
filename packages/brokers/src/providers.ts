/**
 * Provider catalog. `implemented` is true only when an adapter exists in this package.
 * Providers marked false are listed so the UI can show what is required to enable them,
 * but selecting one will not pretend to work.
 */
export interface ProviderSpec {
  id: string;
  name: string;
  assetClasses: string[];
  implemented: boolean;
  requires: string[];
  /** Set when the provider can offer a 5-second fixed expiry. */
  fiveSecondExpiry: boolean;
  docsUrl: string;
  notes: string;
}

export const PROVIDERS: ProviderSpec[] = [
  {
    id: "deriv",
    name: "Deriv (Options)",
    assetClasses: ["synthetic", "forex", "crypto", "indices", "commodities"],
    implemented: true,
    requires: ["Personal Access Token", "Deriv-App-ID registered on the Deriv dashboard"],
    fiveSecondExpiry: true,
    docsUrl: "https://developers.deriv.com/docs/",
    notes:
      "Public market data works immediately. Trading needs a PAT plus a Deriv-App-ID registered on the Deriv dashboard.",
  },
  {
    id: "paper",
    name: "Paper Trading",
    assetClasses: ["synthetic", "forex", "crypto", "indices", "commodities"],
    implemented: true,
    requires: [],
    fiveSecondExpiry: true,
    docsUrl: "",
    notes: "Internal simulator using live market data. No orders reach a provider.",
  },
  {
    id: "oanda",
    name: "OANDA",
    assetClasses: ["forex", "commodities", "indices"],
    implemented: false,
    requires: ["Account ID", "API token", "Practice or live host"],
    fiveSecondExpiry: false,
    docsUrl: "https://developer.oanda.com/rest-live-v20/introduction/",
    notes: "REST v20 supports market and limit orders with units-based sizing. No fixed-expiry contracts.",
  },
  {
    id: "binance",
    name: "Binance",
    assetClasses: ["crypto"],
    implemented: false,
    requires: ["API key", "API secret", "IP allowlist recommended"],
    fiveSecondExpiry: false,
    docsUrl: "https://developers.binance.com/docs/binance-spot-api-docs",
    notes: "Spot and futures market orders. No fixed-expiry contracts.",
  },
  {
    id: "alpaca",
    name: "Alpaca",
    assetClasses: ["stocks", "crypto"],
    implemented: false,
    requires: ["API key", "API secret", "Paper or live base URL"],
    fiveSecondExpiry: false,
    docsUrl: "https://docs.alpaca.markets/docs/about-market-data-api",
    notes: "US equities and ETFs. Market and limit orders. No fixed-expiry contracts.",
  },
  {
    id: "ibkr",
    name: "Interactive Brokers",
    assetClasses: ["stocks", "forex", "commodities", "indices"],
    implemented: false,
    requires: ["IB Gateway or TWS running", "Account ID", "Market data subscriptions"],
    fiveSecondExpiry: false,
    docsUrl: "https://www.interactivebrokers.com/campus/ibkr-api-page/",
    notes: "Requires a locally running gateway; the client portal API needs a session keep-alive.",
  },
];

export function getProvider(id: string): ProviderSpec | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
