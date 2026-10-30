/** End-to-end smoke test against a running API. Exercises every core control. */
const BASE = process.env.PHIRST_API_URL ?? "http://localhost:12001";
let cookie = "";
const results: Array<{ step: string; ok: boolean; detail: string }> = [];

function record(step: string, ok: boolean, detail: string): void {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}  ${detail}`);
}

async function call(method: string, path: string, body?: unknown, auth = true): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth && cookie) headers["Cookie"] = cookie;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

const owner = process.env.PHIRST_OWNER ?? "baelay";
const password = process.env.PHIRST_PASSWORD ?? "phirst2-owner-password";

async function main(): Promise<void> {
  const status = await call("GET", "/api/auth/status", undefined, false);
  record("auth status", status.status === 200, `ownerExists=${status.data?.ownerExists}`);

  if (!status.data?.ownerExists) {
    const setup = await call("POST", "/api/auth/setup", { username: owner, password }, false);
    record("owner setup", setup.status === 201, `status=${setup.status} ${setup.data?.error ?? ""}`);
  } else {
    const login = await call("POST", "/api/auth/login", { username: owner, password }, false);
    record("login", login.status === 200, `status=${login.status} ${login.data?.error ?? ""}`);
  }

  const me = await call("GET", "/api/auth/me");
  record("session valid", me.status === 200, `status=${me.status}`);

  const unauth = await call("GET", "/api/engine/status", undefined, false);
  record("unauthenticated request blocked", unauth.status === 401, `status=${unauth.status}`);

  const providers = await call("GET", "/api/brokers/providers");
  record("providers listed", providers.status === 200 && providers.data.providers.length > 0, `${providers.data?.providers?.length} providers`);

  const brokers = await call("GET", "/api/brokers");
  let brokerId = brokers.data?.brokers?.[0]?.id;
  if (!brokerId) {
    const created = await call("POST", "/api/brokers", { provider: "paper", label: "Paper account", credentials: {} });
    brokerId = created.data?.id;
    record("create paper broker", created.status === 201, `verified=${created.data?.verified} ${created.data?.message ?? ""}`);
  } else {
    record("existing broker found", true, `id=${brokerId}`);
  }

  const verify = await call("POST", `/api/brokers/${brokerId}/verify`);
  record("verify broker", verify.status === 200, `verified=${verify.data?.verified} ${verify.data?.message ?? ""}`);

  const accounts = await call("GET", `/api/brokers/${brokerId}/accounts`);
  record("list accounts", accounts.status === 200 && accounts.data.accounts.length > 0, `${accounts.data?.accounts?.length} accounts`);
  const accountRowId = accounts.data?.accounts?.[0]?.id;
  if (accountRowId) {
    const act = await call("POST", `/api/accounts/${accountRowId}/activate`);
    record("activate account", act.status === 200, `status=${act.status}`);
  }

  const instruments = await call("GET", "/api/market/instruments?assetClass=synthetic");
  record("market instruments (live)", instruments.status === 200 && instruments.data.instruments.length > 0, `${instruments.data?.instruments?.length} synthetic instruments`);

  const candles = await call("GET", "/api/market/candles?symbol=R_100&granularity=60&count=50");
  record("market candles (live)", candles.status === 200 && candles.data.candles.length > 0, `${candles.data?.candles?.length} candles, last close ${candles.data?.candles?.at(-1)?.close}`);

  const badGranularity = await call("GET", "/api/market/candles?symbol=R_100&granularity=7");
  record("invalid granularity rejected", badGranularity.status === 400, `status=${badGranularity.status}`);

  const risk = await call("GET", "/api/risk");
  record("risk config read", risk.status === 200 && risk.data.config.riskPerTrade > 0, `riskPerTrade=${risk.data?.config?.riskPerTrade}`);

  const badRisk = await call("PUT", "/api/risk", { lossStreakDeRiskFactor: 2 });
  record("martingale config rejected", badRisk.status === 400, `${badRisk.data?.error}`);

  const goodRisk = await call("PUT", "/api/risk", { ...risk.data.config, riskPerTrade: 0.01, maxTradeAmount: 100 });
  record("risk config updated", goodRisk.status === 200, `status=${goodRisk.status}`);

  const strategies = await call("GET", "/api/strategies");
  record("strategies listed", strategies.status === 200 && strategies.data.strategies.length >= 5, `${strategies.data?.strategies?.length} strategies`);

  const start = await call("POST", "/api/engine/start");
  record("engine start", start.status === 200, `${start.data?.message ?? start.data?.error}`);

  const statusAfter = await call("GET", "/api/engine/status");
  record("engine running", statusAfter.data?.state === "running", `state=${statusAfter.data?.state} mode=${statusAfter.data?.mode}`);

  const buy = await call("POST", "/api/orders", { side: "buy", amount: 10, durationSec: 5 });
  record("manual buy order", buy.status === 201, `${buy.data?.message ?? buy.data?.error}`);

  const tooSmall = await call("POST", "/api/orders", { side: "buy", amount: 10, durationSec: 1 });
  record("below-minimum duration rejected", tooSmall.status === 400, `${tooSmall.data?.message}`);

  const tooBig = await call("POST", "/api/orders", { side: "buy", amount: 99999, durationSec: 60 });
  record("oversized order risk-clamped or rejected", tooBig.status !== 500, `status=${tooBig.status} ${tooBig.data?.message ?? "clamped"}`);

  const orders = await call("GET", "/api/orders?limit=10");
  record("orders listed", orders.status === 200 && orders.data.orders.length > 0, `${orders.data?.orders?.length} orders`);

  // The buy above used a 5s contract. Settlement runs on every tick, including while
  // paused, so poll until the order is settled and its realised P&L is booked.
  let settled: any = null;
  for (let i = 0; i < 30; i++) {
    const list = await call("GET", "/api/orders?limit=10");
    settled = (list.data?.orders ?? []).find((o: any) => o.id === buy.data?.orderId);
    if (settled?.status === "settled") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  record(
    "order settles and books realised P&L",
    settled?.status === "settled" && settled?.profit !== null && settled?.settled_at,
    `status=${settled?.status} profit=${settled?.profit} settledAt=${settled?.settled_at}`,
  );

  const pause = await call("POST", "/api/engine/pause", { reason: "smoke test" });
  record("engine pause", pause.status === 200, `${pause.data?.message}`);

  const resume = await call("POST", "/api/engine/resume");
  record("engine resume", resume.status === 200, `${resume.data?.message}`);

  const stop = await call("POST", "/api/engine/stop", { reason: "smoke test" });
  record("engine stop", stop.status === 200, `${stop.data?.message}`);

  const eStop = await call("POST", "/api/engine/emergency-stop", { reason: "smoke test" });
  record("emergency stop", eStop.status === 200, `${eStop.data?.message}`);

  const blocked = await call("POST", "/api/orders", { side: "buy", amount: 10, durationSec: 5 });
  record("orders blocked by emergency stop", blocked.status === 400 && /emergency/i.test(blocked.data?.message ?? ""), `${blocked.data?.message}`);

  const reset = await call("POST", "/api/engine/reset-emergency");
  record("reset emergency", reset.status === 200, `${reset.data?.message}`);

  const liveBlocked = await call("POST", "/api/engine/mode", { mode: "live" });
  record("live without confirmation blocked", liveBlocked.status === 400, `${liveBlocked.data?.message}`);

  const liveConfirm = await call("POST", "/api/engine/mode", { mode: "live", confirmation: "ENABLE LIVE TRADING" });
  record("live mode requires verified broker", liveConfirm.status !== 200, `status=${liveConfirm.status} ${liveConfirm.data?.message}`);

  const paper = await call("POST", "/api/engine/mode", { mode: "paper", confirmation: "ENABLE LIVE TRADING" });
  record("switch back to paper", paper.status === 200, `${paper.data?.message}`);

  const chat = await call("POST", "/api/phirst/chat", { message: "What is my equity and risk?" });
  record("PHIRST2 chat responds", chat.status === 200 && chat.data.reply.length > 0, `source=${chat.data?.source} reply="${String(chat.data?.reply).slice(0, 90)}"`);

  const memAdd = await call("POST", "/api/phirst/memory", { content: "Smoke test memory entry", importance: 2 });
  record("memory add", memAdd.status === 201, `id=${memAdd.data?.id}`);
  if (memAdd.data?.id) {
    const memDel = await call("DELETE", `/api/phirst/memory/${memAdd.data.id}`);
    record("memory delete", memDel.status === 200, `status=${memDel.status}`);
  }

  const voice = await call("PUT", "/api/phirst/voice", { voice: "male", rate: 1.1, pitch: 0.9, pushToTalk: true });
  record("voice settings update", voice.status === 200, `voice=${voice.data?.voice?.voice}`);

  const badVoice = await call("PUT", "/api/phirst/voice", { voice: "robot" });
  record("invalid voice rejected", badVoice.status === 400, `${badVoice.data?.error}`);

  const perf = await call("GET", "/api/reports/performance");
  record("performance report", perf.status === 200, `trades=${perf.data?.totalTrades} netPnl=${perf.data?.netPnl}`);

  const verdicts = await call("GET", "/api/verdicts");
  record("agent verdicts", verdicts.status === 200, `${verdicts.data?.verdicts?.length} verdicts`);

  const auditLog = await call("GET", "/api/audit?limit=5");
  record("audit log", auditLog.status === 200 && auditLog.data.entries.length > 0, `${auditLog.data?.entries?.length} entries`);

  const tg = await call("GET", "/api/telegram/status");
  record("telegram status", tg.status === 200, `configured=${tg.data?.configured}`);

  const tgCode = await call("POST", "/api/telegram/link-code");
  record("telegram link code refused when unconfigured", tgCode.status === 400, `${tgCode.data?.error}`);

  const recon = await call("POST", "/api/engine/reconcile");
  record("reconciliation runs", recon.status === 200, `positions=${recon.data?.result?.brokerPositions}`);

  const prefs = await call("GET", "/api/preferences");
  record("preferences load", prefs.status === 200 && typeof prefs.data?.preferences?.chartStyle === "string", `style=${prefs.data?.preferences?.chartStyle}`);

  const prefsUpdate = await call("PUT", "/api/preferences", { chartStyle: "line", dashboardTiles: ["equity", "pnl", "open"], soundVolume: 0.5 });
  record("preferences update persists", prefsUpdate.status === 200 && prefsUpdate.data?.preferences?.chartStyle === "line", `style=${prefsUpdate.data?.preferences?.chartStyle}`);

  const prefsReverify = await call("GET", "/api/preferences");
  record("preferences persisted across requests", prefsReverify.data?.preferences?.chartStyle === "line", `style=${prefsReverify.data?.preferences?.chartStyle}`);

  const prefsInvalid = await call("PUT", "/api/preferences", { chartStyle: "rainbow" });
  record("invalid preferences rejected", prefsInvalid.status === 400, `${prefsInvalid.data?.error}`);

  await call("PUT", "/api/preferences", { chartStyle: "candles" });

  const pwShort = await call("POST", "/api/auth/change-password", { currentPassword: "phirst2-owner-password", newPassword: "short" });
  record("short new password rejected", pwShort.status === 400, `${pwShort.data?.error}`);

  const pwWrong = await call("POST", "/api/auth/change-password", { currentPassword: "definitely-not-it", newPassword: "a-sufficiently-long-password" });
  record("wrong current password rejected", pwWrong.status === 401, `${pwWrong.data?.error}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) {
    console.log("FAILURES:");
    for (const f of failed) console.log(` - ${f.step}: ${f.detail}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error("smoke failed:", err); process.exit(1); });
