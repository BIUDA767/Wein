import { DerivAdapter } from "../packages/brokers/src/adapters/deriv.ts";
const a = new DerivAdapter({}, () => {});
for (const sym of ["1HZ100V", "R_100", "R_10"]) {
  const cf = await a.contractsFor(sym);
  const tick = cf.filter((c) => c.expiry_type === "tick" && (c.contract_type === "CALL" || c.contract_type === "PUT"));
  console.log(`${sym}: ${cf.length} contracts; tick CALL/PUT:`, JSON.stringify(tick.map((c) => ({ type: c.contract_type, min: c.min_contract_duration, max: c.max_contract_duration })).slice(0, 3)));
  const fiveTick = cf.filter((c) => c.expiry_type === "tick" && c.min_contract_duration === "5t");
  console.log(`   contracts allowing 5t expiry: ${fiveTick.length}`);
}
await a.close();
process.exit(0);
