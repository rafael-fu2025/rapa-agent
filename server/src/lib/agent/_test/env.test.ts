// Tests for env validation. The startup guard is a security control — these
// tests pin the rejection behavior so we never accidentally let a placeholder
// secret through.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EnvValidationError,
  generateAppSecret,
  loadAndValidateEnv
} from "./env.js";

const REQUIRED_BASE_ENV = {
  DATABASE_URL:
    "mysql://app_user:s3cret@127.0.0.1:3306/recreate_ui?connection_limit=5",
  APP_SECRET: generateAppSecret()
};

describe("env.loadAndValidateEnv", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("APP_") || key.startsWith("DATABASE_") || key.startsWith("LANGFUSE_") || key.startsWith("AGENT_") || key.startsWith("PORT_") || key.startsWith("TOOL_") || key.startsWith("MEMORY_") || key.startsWith("CORS_") || key.startsWith("DEFAULT_")) {
        delete process.env[key];
      }
    }
    process.env.DATABASE_URL = REQUIRED_BASE_ENV.DATABASE_URL;
    process.env.APP_SECRET = REQUIRED_BASE_ENV.APP_SECRET;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  it("returns a populated env when all required vars are set", () => {
    const env = loadAndValidateEnv();
    expect(env.appSecret).toBe(REQUIRED_BASE_ENV.APP_SECRET);
    expect(env.databaseUrl).toBe(REQUIRED_BASE_ENV.DATABASE_URL);
    expect(env.port).toBe(8787);
    expect(env.defaultProvider).toBe("gemini");
    expect(env.langfuse.publicKey).toBeUndefined();
    expect(env.langfuse.secretKey).toBeUndefined();
  });

  it("rejects placeholder APP_SECRET values from the deny list", () => {
    process.env.APP_SECRET = "change-this-secret-to-a-long-random-value";
    expect(() => loadAndValidateEnv()).toThrow(EnvValidationError);
  });

  it("rejects the bootstrap placeholder used in .env.example", () => {
    process.env.APP_SECRET = "GENERATE_A_STRONG_RANDOM_SECRET_AND_REPLACE_THIS_VALUE";
    expect(() => loadAndValidateEnv()).toThrow(EnvValidationError);
  });

  it("rejects APP_SECRET shorter than 32 characters", () => {
    process.env.APP_SECRET = "short-secret";
    try {
      loadAndValidateEnv();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const issues = (err as EnvValidationError).issues;
      expect(issues.some((i) => i.includes("at least 32 characters"))).toBe(true);
    }
  });

  it("rejects weak-looking secrets matching common patterns", () => {
    process.env.APP_SECRET = "change-me-with-something-long-enough-to-pass-32-chars";
    try {
      loadAndValidateEnv();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
    }
  });

  it("rejects placeholder DATABASE_URL credentials", () => {
    process.env.DATABASE_URL = "mysql://user:password@127.0.0.1:3306/recreate_ui";
    try {
      loadAndValidateEnv();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const issues = (err as EnvValidationError).issues;
      expect(issues.some((i) => i.includes("placeholder credentials"))).toBe(true);
    }
  });

  it("rejects out-of-range MEMORY_COMPACTION_THRESHOLD", () => {
    process.env.MEMORY_COMPACTION_THRESHOLD = "5";
    expect(() => loadAndValidateEnv()).toThrow(EnvValidationError);

    process.env.MEMORY_COMPACTION_THRESHOLD = "120";
    expect(() => loadAndValidateEnv()).toThrow(EnvValidationError);
  });

  it("rejects non-numeric PORT", () => {
    process.env.PORT = "not-a-number";
    expect(() => loadAndValidateEnv()).toThrow(EnvValidationError);
  });

  it("accepts a Langfuse configuration when both keys are present", () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
    process.env.LANGFUSE_BASE_URL = "https://langfuse.example.com";
    process.env.LANGFUSE_TRACING_ENVIRONMENT = "staging";
    const env = loadAndValidateEnv();
    expect(env.langfuse.publicKey).toBe("pk-lf-test");
    expect(env.langfuse.secretKey).toBe("sk-lf-test");
    expect(env.langfuse.baseUrl).toBe("https://langfuse.example.com");
    expect(env.langfuse.environment).toBe("staging");
  });

  it("generateAppSecret returns a 64-character hex string", () => {
    const secret = generateAppSecret();
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
  });
});
