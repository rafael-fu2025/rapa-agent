import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const KEY_BYTES = 32;
const IV_BYTES = 12;

function getKey(secret: string) {
  return createHash("sha256").update(secret).digest().subarray(0, KEY_BYTES);
}

export function encryptText(value: string, secret: string) {
  const iv = randomBytes(IV_BYTES);
  const key = getKey(secret);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

export function decryptText(payload: string, secret: string) {
  const [ivB64, tagB64, encryptedB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !encryptedB64) {
    throw new Error("Invalid encrypted payload");
  }

  const key = getKey(secret);
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const encrypted = Buffer.from(encryptedB64, "base64");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

const SECRET_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|apikey|secret|token|password|auth)\s*[:=]\s*['"]?[^\s'\"]+['"]?/gi,
  /(?:bearer|basic)\s+[^\s]+/gi,
  /sk-[a-zA-Z0-9]{20,}/g,
  /[a-zA-Z0-9+/]{40,}={0,2}/g,
];

export function redact(value: string): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match) => {
      if (match.length <= 8) return match;
      const visible = match.length <= 12 ? 2 : 4;
      return `${match.slice(0, visible)}${"*".repeat(Math.max(0, match.length - visible))}`;
    });
  }
  return result;
}

export function redactObject<T extends Record<string, unknown>>(obj: T): T {
  const sensitiveKeys = ["apiKey", "api_key", "apikey", "secret", "password", "token", "auth", "authorization"];
  const result = { ...obj } as Record<string, unknown>;

  for (const [key, value] of Object.entries(result)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.some((sk) => lowerKey.includes(sk))) {
      if (typeof value === "string" && value.length > 0) {
        result[key] = redact(value);
      }
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = redactObject(value as Record<string, unknown>);
    }
  }

  return result as T;
}
