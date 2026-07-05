// Centralized environment loading + validation.
// Runs once at startup and refuses to boot with unsafe defaults.
// Per the security audit (P0): placeholder APP_SECRET and weak DATABASE_URL
// credentials must fail loudly rather than silently accept a known-bad config.

import { randomBytes } from "node:crypto";

const PLACEHOLDER_SECRETS = new Set<string>([
  "change-this-secret",
  "change-this-secret-to-a-long-random-value",
  "super-secret-default-key-change-me",
  "GENERATE_A_STRONG_RANDOM_SECRET_AND_REPLACE_THIS_VALUE",
  "rapa_dev_5f8a9c1e3b7d2469af0c1e5b8d2f4a6c_generate_a_new_one_for_prod"
]);

// Known placeholder connection strings that should never reach a
// production server. SQLite is the default for personal-machine use
// (`file:./dev.db`) but the validator also catches common MySQL /
// Postgres placeholders for users who switch the provider.
const PLACEHOLDER_DATABASE_PATTERNS: RegExp[] = [
  /^file:.*placeholder/i,
  /^mysql:.*(user|password):password@/i,
  /^postgres(ql)?:.*(user|password):password@/i,
  /^sqlite:.*placeholder/i
];

export type AppEnv = {
  databaseUrl: string;
  appSecret: string;
  port: number;
  /**
   * Network interface the server binds to. Defaults to `127.0.0.1`
   * (loopback only) because Rapa is a personal-machine app — there is
   * no reason for it to be reachable from other devices on the LAN.
   * Set `HOST=0.0.0.0` in `server/.env` if you want to expose it
   * (e.g. for a second device on the same network), but be aware
   * that the rate limiter currently only exempts loopback.
   */
  host: string;
  defaultProvider: string;
  agentLlmTimeoutMs: number;
  agentTracingEnabled: boolean;
  agentTracingExporter: "console" | "off";
  langfuse: {
    publicKey?: string;
    secretKey?: string;
    baseUrl: string;
    environment: string;
  };
  toolOutputMaxChars: number;
  memoryCompactionThreshold: number;
  corsOrigins: string[];
};

export class EnvValidationError extends Error {
  constructor(message: string, public readonly issues: string[]) {
    super(message);
    this.name = "EnvValidationError";
  }
}

function readString(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value !== undefined && value.trim().length > 0) return value.trim();
  if (fallback !== undefined) return fallback;
  throw new EnvValidationError(
    `Missing required environment variable: ${name}`,
    [`Missing required env var: ${name}`]
  );
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new EnvValidationError(
      `Environment variable ${name} must be a number, got: ${raw}`,
      [`${name} must be a number`]
    );
  }
  return parsed;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw.toLowerCase() !== "false" && raw !== "0";
}

function readList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Generate a cryptographically strong APP_SECRET suitable for AES-256-GCM.
 * Exported so the bootstrap CLI / setup wizard can mint one for the user.
 */
export function generateAppSecret(): string {
  return randomBytes(32).toString("hex");
}

export function loadAndValidateEnv(): AppEnv {
  const issues: string[] = [];

  const databaseUrl = readString("DATABASE_URL");
  const appSecret = readString("APP_SECRET");
  const port = readNumber("PORT", 8787);
  // Safe default: loopback only. The previous default of 0.0.0.0 was
  // a footgun for a personal-machine app — it exposed the API to
  // every device on the LAN by default.
  const host = readString("HOST", "127.0.0.1");
  const defaultProvider = readString("DEFAULT_PROVIDER", "gemini");

  // ---- APP_SECRET checks -------------------------------------------------
  if (appSecret.length < 32) {
    issues.push(`APP_SECRET must be at least 32 characters (current: ${appSecret.length}).`);
  }
  if (PLACEHOLDER_SECRETS.has(appSecret)) {
    issues.push(
      "APP_SECRET is set to a known placeholder. Generate a new one with:\n" +
        "    Node.js :    node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n" +
        "    PowerShell:  $b = New-Object byte[] 32; (New-Object System.Security.Cryptography.RNGCryptoServiceProvider).GetBytes($b); [System.BitConverter]::ToString($b) -replace '-',''\n" +
        "    Bash      :  openssl rand -hex 32"
    );
  }
  if (appSecret === "super-secret-default-key-change-me" || /^(secret|password|change-?me)/i.test(appSecret)) {
    issues.push("APP_SECRET looks like a default/weak value. Replace it before running in production.");
  }

  // ---- DATABASE_URL checks -----------------------------------------------
  for (const pattern of PLACEHOLDER_DATABASE_PATTERNS) {
    if (pattern.test(databaseUrl)) {
      issues.push(
        `DATABASE_URL matches a known placeholder pattern (${pattern}). ` +
          "Replace it with a real connection string (or `file:./dev.db` " +
          "for the default SQLite setup) before booting."
      );
      break;
    }
  }

  // ---- Langfuse (optional) -----------------------------------------------
  const langfusePublicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
  const langfuseSecretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
  const langfuse = {
    publicKey: langfusePublicKey && langfusePublicKey.length > 0 ? langfusePublicKey : undefined,
    secretKey: langfuseSecretKey && langfuseSecretKey.length > 0 ? langfuseSecretKey : undefined,
    baseUrl: readString("LANGFUSE_BASE_URL", "https://cloud.langfuse.com"),
    environment: readString("LANGFUSE_TRACING_ENVIRONMENT", "production")
  };

  // ---- Other settings ----------------------------------------------------
  const agentLlmTimeoutMs = readNumber("AGENT_LLM_TIMEOUT_MS", 180000);
  const agentTracingEnabled = readBoolean("AGENT_TRACING", true);
  const agentTracingExporter =
    process.env.AGENT_TRACING_EXPORTER === "off" ? "off" : "console";
  const toolOutputMaxChars = readNumber("TOOL_OUTPUT_MAX_CHARS", 50000);
  const memoryCompactionThreshold = readNumber("MEMORY_COMPACTION_THRESHOLD", 75);
  const corsOrigins = readList("CORS_ORIGINS", ["http://localhost:5173"]);

  if (memoryCompactionThreshold < 10 || memoryCompactionThreshold > 99) {
    issues.push("MEMORY_COMPACTION_THRESHOLD must be between 10 and 99.");
  }
  if (toolOutputMaxChars < 1000) {
    issues.push("TOOL_OUTPUT_MAX_CHARS must be at least 1000.");
  }

  if (issues.length > 0) {
    throw new EnvValidationError(
      `Refusing to start: ${issues.length} environment issue(s) detected.\n` +
        issues.map((i) => `  - ${i}`).join("\n"),
      issues
    );
  }

  return {
    databaseUrl,
    appSecret,
    port,
    defaultProvider,
    agentLlmTimeoutMs,
    agentTracingEnabled,
    agentTracingExporter,
    langfuse,
    toolOutputMaxChars,
    memoryCompactionThreshold,
    corsOrigins,
    host
  };
}
