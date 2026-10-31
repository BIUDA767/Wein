import { type Row } from "./pool.ts";
import {
  getActiveAccount,
  getActiveBroker,
  getBroker,
  listAccounts,
  listBrokers,
  listOpenOrders,
  listProposals,
  setActiveAccount,
  setActiveBroker,
  setBrokerActiveAccount,
  type BrokerRow,
} from "./repo.ts";

/**
 * Smart active trading account selection, shared by every broker integration.
 *
 * The rules this module enforces, in order of precedence:
 *
 *  1. A connection never silently replaces an account the owner already chose. If an
 *     active account exists, connecting a new broker leaves it untouched.
 *  2. If no active account exists, the newly connected one becomes active automatically.
 *  3. Switching the active account while the engine holds open exposure requires an
 *     explicit confirmation, because routing changes mid-flight is how positions get
 *     orphaned.
 *  4. Every trading action reads the active account from here, so "active" has exactly one
 *     meaning for the engine, the UI and the audit log.
 */

export interface ActiveSelection {
  brokerId: string | null;
  /** `accounts.id` row id of the active account, or null when nothing is selected. */
  accountRowId: string | null;
  /** The provider's account identifier, e.g. a Deriv login id. */
  providerAccountId: string | null;
  brokerLabel: string | null;
  provider: string | null;
}

export async function getActiveSelection(): Promise<ActiveSelection> {
  const broker = await getActiveBroker();
  const account = await getActiveAccount();
  // A dangling selection (account row from a different broker) counts as no selection.
  const consistent = broker && account && String(account.broker_id) === broker.id ? account : null;
  return {
    brokerId: broker?.id ?? null,
    accountRowId: consistent ? String(consistent.id) : null,
    providerAccountId: consistent ? String(consistent.account_id) : null,
    brokerLabel: broker?.label ?? null,
    provider: broker?.provider ?? null,
  };
}

/**
 * Choose which of a broker's accounts to make active by default. A demo account is
 * preferred so that connecting a broker can never move the engine onto real money without
 * the owner saying so; if only real accounts exist, the first one is used and the UI says
 * so explicitly.
 */
export function pickDefaultAccount(accounts: Row[]): Row | null {
  if (accounts.length === 0) return null;
  return accounts.find((a) => a.account_type === "demo") ?? accounts[0]!;
}

/**
 * Run after a broker connects and its accounts are stored. Honours rules 1 and 2: it only
 * selects an account when there is no active one, and it reports what it did so the caller
 * can tell the owner instead of changing state invisibly.
 */
export async function ensureActiveAfterConnect(brokerId: string): Promise<{
  changed: boolean;
  message: string;
  selection: ActiveSelection;
}> {
  const existing = await getActiveSelection();
  if (existing.brokerId && existing.accountRowId) {
    return {
      changed: false,
      message: `Existing active account preserved (${existing.brokerLabel ?? existing.brokerId}).`,
      selection: existing,
    };
  }

  const accounts = await listAccounts(brokerId);
  const chosen = pickDefaultAccount(accounts);
  await setActiveBroker(brokerId);
  if (!chosen) {
    await setBrokerActiveAccount(brokerId, null);
    return {
      changed: true,
      message: "Broker set active, but it reported no accounts to select.",
      selection: await getActiveSelection(),
    };
  }
  await setActiveAccount(String(chosen.id));
  await setBrokerActiveAccount(brokerId, String(chosen.account_id));
  return {
    changed: true,
    message: `Set ${chosen.account_type === "real" ? "real" : "demo"} account ${chosen.account_id} active.`,
    selection: await getActiveSelection(),
  };
}

export interface ExposureSummary {
  openOrders: number;
  pendingProposals: number;
  total: number;
}

/** Open orders and pending proposals across both modes. Used to gate account switches. */
export async function getOpenExposure(): Promise<ExposureSummary> {
  const [paper, live, proposals] = await Promise.all([
    listOpenOrders("paper").catch(() => []),
    listOpenOrders("live").catch(() => []),
    listProposals(200, { status: "pending" }).catch(() => []),
  ]);
  const openOrders = paper.length + live.length;
  return {
    openOrders,
    pendingProposals: proposals.length,
    total: openOrders + proposals.length,
  };
}

export interface SwitchResult {
  ok: boolean;
  /** True when the switch is safe to repeat with `confirm: true`. */
  requiresConfirmation: boolean;
  message: string;
  selection?: ActiveSelection;
}

/**
 * Explicitly switch the active trading account. Refuses when open exposure exists unless
 * the caller confirms, so a switch is never a silent mid-trade reroute.
 */
export async function setActiveTradingAccount(
  accountRowId: string,
  opts: { confirm?: boolean } = {},
): Promise<SwitchResult> {
  const all = await listAccounts();
  const acct = all.find((a) => String(a.id) === accountRowId);
  if (!acct) return { ok: false, requiresConfirmation: false, message: "Account not found." };

  const brokerId = String(acct.broker_id);
  const broker = await getBroker(brokerId);
  if (!broker) return { ok: false, requiresConfirmation: false, message: "The account's broker no longer exists." };

  const current = await getActiveSelection();
  const switching = current.accountRowId !== accountRowId;
  if (switching) {
    const exposure = await getOpenExposure();
    if (exposure.total > 0 && !opts.confirm) {
      return {
        ok: false,
        requiresConfirmation: true,
        message:
          `There ${exposure.total === 1 ? "is" : "are"} ${exposure.openOrders} open order(s) and ` +
          `${exposure.pendingProposals} pending proposal(s). Switching the active account now would route new ` +
          `orders to a different account. Confirm to switch anyway.`,
      };
    }
  }

  await setActiveBroker(brokerId);
  await setActiveAccount(accountRowId);
  await setBrokerActiveAccount(brokerId, String(acct.account_id));
  return {
    ok: true,
    requiresConfirmation: false,
    message: `Active account is now ${acct.account_id}.`,
    selection: await getActiveSelection(),
  };
}

export interface ConnectionHealth {
  broker: BrokerRow | null;
  /** True when an OAuth token's recorded expiry has passed. */
  expired: boolean;
  expiresAt: string | null;
  /** Human-readable state for the UI, derived from stored facts only. */
  state: "none" | "connected" | "expired" | "error";
  detail: string;
}

/**
 * The broker fields safe to send to a browser. `credentials_enc` is deliberately excluded:
 * it is ciphertext, but there is no reason for it to leave the server at all.
 */
export interface PublicBroker {
  id: string;
  provider: string;
  label: string;
  status: string;
  credentialFingerprint: string;
  authMethod: string;
  oauthExpiresAt: string | null;
  oauthScope: string | null;
  activeAccountId: string | null;
  lastVerifiedAt: string | null;
  lastError: string | null;
  capabilities: Record<string, unknown>;
}

export function toPublicBroker(b: BrokerRow): PublicBroker {
  return {
    id: b.id,
    provider: b.provider,
    label: b.label,
    status: b.status,
    credentialFingerprint: b.credential_fingerprint,
    authMethod: b.auth_method ?? "pat",
    oauthExpiresAt: b.oauth_expires_at ?? null,
    oauthScope: b.oauth_scope ?? null,
    activeAccountId: b.active_account_id ?? null,
    lastVerifiedAt: b.last_verified_at,
    lastError: b.last_error,
    capabilities: b.capabilities,
  };
}

/**
 * Report whether the active connection is still usable. Deriv issues no refresh token, so
 * the only honest signal is the expiry recorded at connect time; a token that has passed it
 * is reported as expired even before an API call fails.
 */
export async function getActiveConnectionHealth(): Promise<ConnectionHealth> {
  const broker = await getActiveBroker();
  if (!broker) {
    return { broker: null, expired: false, expiresAt: null, state: "none", detail: "No active broker." };
  }
  const expiresAt = broker.oauth_expires_at ?? null;
  const expired = Boolean(expiresAt && new Date(expiresAt).getTime() <= Date.now());
  if (expired) {
    return {
      broker,
      expired: true,
      expiresAt,
      state: "expired",
      detail: "The Deriv authorization has expired. Reconnect to continue trading.",
    };
  }
  if (broker.status === "error") {
    return { broker, expired: false, expiresAt, state: "error", detail: broker.last_error ?? "Connection error." };
  }
  return {
    broker,
    expired: false,
    expiresAt,
    state: "connected",
    detail: broker.status === "connected" ? "Connected." : `Status: ${broker.status}.`,
  };
}

/** Every broker row, for the connection list. Ordered oldest first for stable display. */
export async function listConnections(): Promise<BrokerRow[]> {
  return listBrokers();
}
