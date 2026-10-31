"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiFailure } from "./api";

/**
 * The account-balance service the header reads.
 *
 * Every value here comes from `/api/accounts/active`, which returns the account row the
 * backend has actually selected and the balance the broker last reported for it. Nothing
 * is derived on the client and no demo figure is ever substituted: an unavailable balance
 * is reported as unavailable.
 *
 * State machine:
 *   loading   — first fetch in flight
 *   ready     — a real account with a real balance
 *   no-account— connected, but no account is selected
 *   error     — the request failed (surfaced verbatim)
 */

export interface ActiveAccount {
  id: string;
  accountId: string;
  accountType: string;
  currency: string;
  balance: number | null;
  loginid: string | null;
  label: string | null;
  status: string | null;
  brokerId: string;
  isActive?: boolean;
}

export interface ActiveAccountState {
  status: "loading" | "ready" | "no-account" | "error";
  account: ActiveAccount | null;
  accounts: ActiveAccount[];
  brokerLabel: string | null;
  provider: string | null;
  error: string | null;
  refresh: () => Promise<void>;
  switchAccount: (accountRowId: string, confirm?: boolean) => Promise<void>;
  switching: boolean;
}

export function useActiveAccount(enabled: boolean, pollMs = 15000): ActiveAccountState {
  const [status, setStatus] = useState<ActiveAccountState["status"]>("loading");
  const [account, setAccount] = useState<ActiveAccount | null>(null);
  const [accounts, setAccounts] = useState<ActiveAccount[]>([]);
  const [brokerLabel, setBrokerLabel] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await api.get<{
        selection: { brokerLabel: string | null; provider: string | null };
        account: ActiveAccount | null;
        accounts: ActiveAccount[];
      }>("/api/accounts/active");
      setAccount(res.account);
      setAccounts(res.accounts);
      setBrokerLabel(res.selection.brokerLabel);
      setProvider(res.selection.provider);
      setStatus(res.account ? "ready" : "no-account");
      setError(null);
    } catch (err) {
      // A 401 means the session ended; the shell handles that. Anything else is a real
      // failure and is reported rather than hidden behind a zero.
      if (err instanceof ApiFailure && err.status === 401) {
        setStatus("error");
        setError("Not signed in.");
      } else {
        setStatus("error");
        setError((err as Error).message);
      }
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, pollMs);
    return () => clearInterval(id);
  }, [enabled, load, pollMs]);

  const switchAccount = useCallback(
    async (accountRowId: string, confirm = false) => {
      setSwitching(true);
      try {
        await api.post(`/api/accounts/${encodeURIComponent(accountRowId)}/activate`, { confirm });
        await load();
      } finally {
        setSwitching(false);
      }
    },
    [load],
  );

  return { status, account, accounts, brokerLabel, provider, error, refresh: load, switchAccount, switching };
}

/** Format a balance with its account currency, using locale-aware formatting. */
export function formatMoney(value: number | null | undefined, currency = "USD"): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    // An unknown currency code falls back to a plain grouped number plus the code, so the
    // user still sees the real figure rather than an error.
    return `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
  }
}
