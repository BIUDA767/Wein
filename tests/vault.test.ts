import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { Vault, hashPassword, verifyPassword, decodeMasterKey } from "@phirst/core";

describe("Vault", () => {
  const key = randomBytes(32);
  const vault = new Vault(key);

  it("round-trips a secret", () => {
    const secret = "deriv-pat-abc123:with:colons";
    const enc = vault.encrypt(secret);
    expect(enc).not.toContain(secret);
    expect(vault.decrypt(enc)).toBe(secret);
  });

  it("produces a different ciphertext each time (unique IV)", () => {
    expect(vault.encrypt("same")).not.toBe(vault.encrypt("same"));
  });

  it("rejects a tampered ciphertext", () => {
    const enc = vault.encrypt("sensitive");
    const parts = enc.split(".");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => vault.decrypt(parts.join("."))).toThrow();
  });

  it("rejects a malformed envelope", () => {
    expect(() => vault.decrypt("not-an-envelope")).toThrow(/Malformed/);
  });

  it("fails to decrypt with the wrong key", () => {
    const other = new Vault(randomBytes(32));
    const enc = vault.encrypt("secret");
    expect(() => other.decrypt(enc)).toThrow();
  });

  it("produces a stable fingerprint without revealing the secret", () => {
    const fp = vault.fingerprint("my-token");
    expect(fp).toBe(vault.fingerprint("my-token"));
    expect(fp).not.toContain("my-token");
    expect(fp.length).toBe(16);
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() => new Vault(randomBytes(16))).toThrow(/32 bytes/);
  });
});

describe("password hashing", () => {
  it("verifies the correct password", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
  });
  it("rejects the wrong password", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("wrong password", stored)).toBe(false);
  });
  it("uses a distinct salt per hash", () => {
    expect(hashPassword("same").salt).not.toBe(hashPassword("same").salt);
  });
});

describe("decodeMasterKey", () => {
  it("accepts exactly 32 decoded bytes", () => {
    const raw = randomBytes(32).toString("base64");
    expect(decodeMasterKey(raw).length).toBe(32);
  });
  it("rejects a 48-byte key with a helpful message", () => {
    const raw = randomBytes(48).toString("base64");
    expect(() => decodeMasterKey(raw)).toThrow(/exactly 32 bytes/);
  });
});
