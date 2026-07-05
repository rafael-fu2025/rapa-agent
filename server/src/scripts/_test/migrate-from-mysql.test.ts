// Unit tests for the MySQL → SQLite migration script.
//
// The critical claim this file defends: AES-256-GCM ciphertexts
// encrypted by Rapa survive being copied byte-for-byte from a
// MySQL row to a SQLite row. The encryption is engine-agnostic
// (only depends on APP_SECRET + random IV per row), so this is
// a structural property — but verifying it with a real
// round-trip test means a future change to `encryptText` (e.g.
// switching to AES-CBC or changing the IV size) will fail loudly
// instead of silently corrupting every migrated key.

import { describe, expect, it } from "vitest";
import { encryptText, decryptText } from "../../lib/crypto.js";

describe("ciphertext portability", () => {
  it("encrypts and decrypts a typical API key round-trip", () => {
    const secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const plaintext = "sk-live-abc123def456ghi789";

    const cipher = encryptText(plaintext, secret);
    expect(typeof cipher).toBe("string");
    expect(cipher).not.toContain(plaintext); // must not leak the key

    const decrypted = decryptText(cipher, secret);
    expect(decrypted).toBe(plaintext);
  });

  it("produces different ciphertext for the same plaintext (random IV)", () => {
    const secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const plaintext = "sk-test-1234";

    const a = encryptText(plaintext, secret);
    const b = encryptText(plaintext, secret);
    expect(a).not.toBe(b); // IV is random per call
  });

  it("rejects a tampered ciphertext (GCM auth tag)", () => {
    const secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const cipher = encryptText("hello world", secret);

    // Flip one character in the body
    const [iv, tag, body] = cipher.split(".");
    const tamperedBody = body!.slice(0, -1) + (body!.endsWith("A") ? "B" : "A");
    const tampered = `${iv}.${tag}.${tamperedBody}`;

    expect(() => decryptText(tampered, secret)).toThrow();
  });

  it("rejects a ciphertext encrypted with a different secret", () => {
    const secretA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const secretB = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    const cipher = encryptText("secret key", secretA);
    expect(() => decryptText(cipher, secretB)).toThrow();
  });

  it("handles unicode and long strings", () => {
    const secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const plaintext = "🔥".repeat(500) + "—".repeat(100) + "中文字符";
    const cipher = encryptText(plaintext, secret);
    expect(decryptText(cipher, secret)).toBe(plaintext);
  });

  it("preserves the format that the migration script depends on", () => {
    // The migration script reads the ciphertext as a single string
    // from the source DB and re-inserts it verbatim. The format
    // is `iv.tag.body` in base64. Lock that in so a future change
    // to `encryptText` can't silently break the migration path.
    const secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const cipher = encryptText("hello", secret);
    const parts = cipher.split(".");
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(part).toMatch(/^[A-Za-z0-9+/=]+$/); // valid base64
    }
  });
});
