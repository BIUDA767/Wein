import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHmac,
  randomUUID,
} from "node:crypto";

/**
 * AES-256-GCM envelope encryption for broker credentials.
 * Ciphertext format: v1.<ivB64>.<tagB64>.<cipherB64>
 * The master key never leaves the process; plaintext is never written to disk or logs.
 */
const VERSION = "v1";

export class Vault {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("Vault key must be 32 bytes");
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(".");
  }

  decrypt(payload: string): string {
    const parts = payload.split(".");
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new Error("Malformed ciphertext envelope");
    }
    const iv = Buffer.from(parts[1]!, "base64");
    const tag = Buffer.from(parts[2]!, "base64");
    const data = Buffer.from(parts[3]!, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  }

  /** Stable fingerprint of a secret, safe to store and display for identification. */
  fingerprint(plaintext: string): string {
    return createHmac("sha256", this.key).update(plaintext).digest("hex").slice(0, 16);
  }
}

// --- Password hashing (scrypt, per-user salt) ---------------------------------

export interface PasswordHash {
  salt: string;
  hash: string;
  params: { N: number; r: number; p: number; keylen: number };
}

export function hashPassword(password: string): PasswordHash {
  const params = { N: 16384, r: 8, p: 1, keylen: 64 };
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p });
  return { salt: salt.toString("base64"), hash: hash.toString("base64"), params };
}

export function verifyPassword(password: string, stored: PasswordHash): boolean {
  const salt = Buffer.from(stored.salt, "base64");
  const expected = Buffer.from(stored.hash, "base64");
  const actual = scryptSync(password, salt, stored.params.keylen, {
    N: stored.params.N,
    r: stored.params.r,
    p: stored.params.p,
  });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

// --- Session tokens -----------------------------------------------------------

export interface SessionToken {
  token: string;
  hash: string;
  expiresAt: Date;
}

export function issueSessionToken(ttlHours: number): SessionToken {
  const token = randomBytes(32).toString("base64url");
  const hash = createHmac("sha256", "phirst-session").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
  return { token, hash, expiresAt };
}

export function hashSessionToken(token: string): string {
  return createHmac("sha256", "phirst-session").update(token).digest("hex");
}

export function newId(): string {
  return randomUUID();
}

/** Constant-time string comparison for tokens and shared secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
