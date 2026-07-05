// Tests for the AES-256-GCM crypto module used to encrypt stored API keys.
// The module derives a 32-byte key from the input via SHA-256, so the secret
// can be any string (it just needs to be long enough to be safe in practice).

import { describe, expect, it } from "vitest";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { decryptText, encryptText, redact } from "./crypto.js";

const VALID_SECRET = "this-is-a-32+-character-long-test-secret-for-aes-256-gcm";

describe("crypto.encryptText", () => {
  it("produces a payload of the expected envelope shape (iv.tag.encrypted)", () => {
    const ciphertext = encryptText("hello world", VALID_SECRET);
    const parts = ciphertext.split(".");
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      // Each part is non-empty base64.
      expect(Buffer.from(part, "base64").length).toBeGreaterThan(0);
    }
  });

  it("returns a different ciphertext each time (random IV)", () => {
    const a = encryptText("same plaintext", VALID_SECRET);
    const b = encryptText("same plaintext", VALID_SECRET);
    expect(a).not.toBe(b);
  });
});

describe("crypto.decryptText", () => {
  it("round-trips a plaintext message", () => {
    const ciphertext = encryptText("super secret api key", VALID_SECRET);
    expect(decryptText(ciphertext, VALID_SECRET)).toBe("super secret api key");
  });

  it("round-trips unicode content", () => {
    const original = "Café 🚀 résumé — 漢字";
    const ciphertext = encryptText(original, VALID_SECRET);
    expect(decryptText(ciphertext, VALID_SECRET)).toBe(original);
  });

  it("round-trips long content", () => {
    const original = "x".repeat(50_000);
    const ciphertext = encryptText(original, VALID_SECRET);
    expect(decryptText(ciphertext, VALID_SECRET)).toBe(original);
  });

  it("throws when the key is wrong", () => {
    const ciphertext = encryptText("secret", VALID_SECRET);
    expect(() => decryptText(ciphertext, "totally-different-secret-value-here-also-long")).toThrow();
  });

  it("throws on a tampered ciphertext (GCM auth tag catches it)", () => {
    const ciphertext = encryptText("secret", VALID_SECRET);
    // Flip one byte in the ciphertext portion (last segment).
    const parts = ciphertext.split(".");
    const tamperedBuf = Buffer.from(parts[2], "base64");
    tamperedBuf[0] = tamperedBuf[0] ^ 0xff;
    const tampered = `${parts[0]}.${parts[1]}.${tamperedBuf.toString("base64")}`;
    expect(() => decryptText(tampered, VALID_SECRET)).toThrow();
  });

  it("rejects malformed envelopes", () => {
    expect(() => decryptText("not-an-envelope", VALID_SECRET)).toThrow();
    expect(() => decryptText("a.b", VALID_SECRET)).toThrow();
  });
});

describe("crypto.redact", () => {
  it("masks API-key-shaped substrings", () => {
    const text = 'api_key="sk-1234567890abcdef"';
    const result = redact(text);
    expect(result).not.toBe(text);
    // The actual value is masked with asterisks.
    expect(result).toMatch(/\*+/);
  });

  it("masks Bearer tokens", () => {
    const text = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz";
    const result = redact(text);
    expect(result).not.toBe(text);
  });

  it("returns the original string when no secrets are present", () => {
    const text = "just a normal sentence with no secrets";
    expect(redact(text)).toBe(text);
  });
});

// Cross-check: decrypt with a freshly-built cipher using a known IV should
// produce the original plaintext. This guards against the test setup
// accidentally testing the wrong key shape.
describe("crypto regression", () => {
  it("encryptText output is decryptable with an equivalent Node cipher using the same SHA-256 derived key", () => {
    const plaintext = "regression test";
    const ciphertext = encryptText(plaintext, VALID_SECRET);
    const [ivB64, tagB64, ctB64] = ciphertext.split(".");
    const iv = Buffer.from(ivB64, "base64");
    const ct = Buffer.from(ctB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const key = createHash("sha256").update(VALID_SECRET).digest().subarray(0, 32);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    expect(out).toBe(plaintext);
  });

  it("encrypts a value pre-encrypted with Node's aes-256-gcm using the same key derivation", () => {
    const iv = randomBytes(12);
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const key = createHash("sha256").update(VALID_SECRET).digest().subarray(0, 32);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const plaintext = "cross-check plaintext";
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const envelope = `${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`;
    expect(decryptText(envelope, VALID_SECRET)).toBe(plaintext);
  });
});
