import { Vault, getActiveBroker, getBroker, listAccounts, getActiveAccount, type Logger, type BrokerRow, type Row } from "@phirst/core";
import { createAdapter, type BrokerAdapter, type BrokerCredentials, BrokerError } from "@phirst/brokers";

export interface ActiveBroker {
  broker: BrokerRow;
  account: Row | null;
  adapter: BrokerAdapter;
}

/**
 * Owns broker adapters and decrypted credentials. Credentials are decrypted only
 * in memory, only when an adapter is built, and are never logged.
 */
export class BrokerManager {
  private cache: ActiveBroker | null = null;

  constructor(private vault: Vault, private log: Logger, private paperStartingBalance: number) {}

  private decodeCredentials(enc: string): BrokerCredentials {
    const json = this.vault.decrypt(enc);
    const parsed = JSON.parse(json) as BrokerCredentials;
    return parsed;
  }

  async buildAdapter(broker: BrokerRow, accountId?: string | null): Promise<BrokerAdapter> {
    const credentials = this.decodeCredentials(broker.credentials_enc);
    if (accountId) credentials.accountId = accountId;
    return createAdapter({
      provider: broker.provider,
      credentials,
      paperStartingBalance: this.paperStartingBalance,
      log: (msg, fields) => this.log.debug(`broker:${broker.provider}`, { msg, ...fields }),
    });
  }

  async loadActive(force = false): Promise<ActiveBroker | null> {
    if (this.cache && !force) return this.cache;
    const broker = await getActiveBroker();
    if (!broker) {
      this.cache = null;
      return null;
    }
    const account = await getActiveAccount();
    const accountId = account && account.broker_id === broker.id ? String(account.account_id) : null;
    const adapter = await this.buildAdapter(broker, accountId);
    this.cache = { broker, account, adapter };
    return this.cache;
  }

  async reload(): Promise<ActiveBroker | null> {
    await this.cache?.adapter.close?.();
    this.cache = null;
    return this.loadActive(true);
  }

  async requireAdapter(): Promise<ActiveBroker> {
    const active = await this.loadActive();
    if (!active) throw new BrokerError("No active broker is configured", "unsupported");
    return active;
  }

  async verifyActive(): Promise<{ ok: boolean; message: string }> {
    const active = await this.loadActive();
    if (!active) return { ok: false, message: "No active broker configured." };
    try {
      const check = await active.adapter.verifyConnection();
      return { ok: check.ok, message: check.message };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  async close(): Promise<void> {
    await this.cache?.adapter.close?.();
    this.cache = null;
  }

  static async accountsFor(brokerId: string): Promise<Row[]> {
    return listAccounts(brokerId);
  }

  static async getBrokerRow(id: string): Promise<BrokerRow | null> {
    return getBroker(id);
  }
}
