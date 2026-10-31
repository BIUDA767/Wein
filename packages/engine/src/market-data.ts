/**
 * The engine's market-data facade now lives in `@phirst/marketdata` so that the
 * market-data provider (Twelve Data or the broker feed) is decoupled from order
 * execution. This module re-exports it so existing engine imports keep working.
 */
export { MarketDataService, resolveMarketDataProvider } from "@phirst/marketdata";
export type { MarketDataProvider, ProviderId, ProviderStatus, BrokerFeed } from "@phirst/marketdata";
