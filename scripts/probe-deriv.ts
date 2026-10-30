import { DerivAdapter } from "../packages/brokers/src/adapters/deriv.ts";

const adapter = new DerivAdapter(
  { token: process.env.Deriv_Api_keys, appId: process.env.DERIV_APP_ID ?? undefined },
  (m, f) => console.log("[log]", m, f ?? ""),
);

console.log("=== capabilities ===");
console.log(JSON.stringify(adapter.capabilities(), null, 1));

console.log("=== verifyConnection (auth path) ===");
const check = await adapter.verifyConnection();
console.log(JSON.stringify(check, null, 1));

console.log("=== listInstruments (public) ===");
const instruments = await adapter.listInstruments();
console.log("count:", instruments.length);
console.log("sample:", instruments.slice(0, 4).map((i) => `${i.symbol}=${i.name} [${i.assetClass}] tradeable=${i.tradeable}`).join("\n        "));

console.log("=== getQuote R_100 ===");
console.log(JSON.stringify(await adapter.getQuote("R_100")));

console.log("=== getCandles R_100 60s x5 ===");
const candles = await adapter.getCandles("R_100", 60, 5);
console.log(JSON.stringify(candles));

console.log("=== contractsFor R_100 (min expiry proof) ===");
const cf = await adapter.contractsFor("R_100");
const riseFall = cf.filter((c) => c.contract_type === "CALL" || c.contract_type === "PUT");
console.log("CALL/PUT entries:", JSON.stringify(riseFall.slice(0, 2)));
await adapter.close();
process.exit(0);
