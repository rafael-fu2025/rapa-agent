// Per-tool scopes (research ASI03, ASI07).
//
// Restricts which tools a sub-agent (or delegated task) can call. Each
// scope is a capability string in the form `tool:<name>` or
// `category:<name>`. The orchestrator verifies the sub-agent's token
// against the requested tool before dispatching.
//
// Token format (compact, JWT-like):
//   header.payload.signature  (all base64url, no dots in the body)
//
// We use HMAC-SHA-256 with the app secret as the key. The payload is
// { sub: agentName, scope: string[], exp: number }.
//
// This is *not* a full OIDC implementation. It is a minimal capability
// token sufficient for our sub-agent delegation model.

import { createHmac, timingSafeEqual } from "node:crypto";

export type ToolScope = `tool:${string}` | `category:${string}` | "*";

export type CapabilityTokenPayload = {
  /** Issuing agent (or "user" for human operators). */
  sub: string;
  /** Granted scopes. */
  scope: ToolScope[];
  /** Expiration (unix seconds). */
  exp: number;
  /** Optional human-readable description. */
  description?: string;
};

export type IssuedCapabilityToken = {
  token: string;
  payload: CapabilityTokenPayload;
  expiresAt: Date;
};

const HEADER = { alg: "HS256", typ: "CAP" };

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf-8") : input;
  return buf.toString("base64url");
}

function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

function hmac(secret: string, data: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

/**
 * Sign a capability token with the given app secret. The resulting string
 * is `header.payload.signature` and can be passed to a sub-agent when
 * delegating a task.
 */
export function issueCapabilityToken(
  payload: CapabilityTokenPayload,
  secret: string
): IssuedCapabilityToken {
  if (!secret || secret.length < 16) {
    throw new Error("Capability tokens require a secret of at least 16 characters");
  }
  const header = b64url(JSON.stringify(HEADER));
  const body = b64url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const sig = b64url(hmac(secret, signingInput));
  return {
    token: `${signingInput}.${sig}`,
    payload,
    expiresAt: new Date(payload.exp * 1000)
  };
}

/**
 * Verify a capability token and return the decoded payload. Throws when
 * the signature is invalid or the token has expired.
 */
export function verifyCapabilityToken(
  token: string,
  secret: string,
  options: { now?: number; clockSkewSeconds?: number } = {}
): CapabilityTokenPayload {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed capability token");
  const [header, body, sig] = parts;
  const expected = hmac(secret, `${header}.${body}`);
  const provided = b64urlDecode(sig);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw new Error("Invalid capability token signature");
  }
  const payload = JSON.parse(b64urlDecode(body).toString("utf-8")) as CapabilityTokenPayload;
  if (typeof payload.exp !== "number") throw new Error("Capability token missing `exp`");
  const now = (options.now ?? Date.now()) / 1000;
  const skew = options.clockSkewSeconds ?? 5;
  if (now > payload.exp + skew) {
    throw new Error("Capability token has expired");
  }
  if (!Array.isArray(payload.scope)) {
    throw new Error("Capability token has invalid `scope`");
  }
  return payload;
}

/**
 * Check whether a token's scope covers a specific tool. Returns true if
 * the token has either a `tool:<name>` scope or a `category:<category>`
 * scope that includes the tool's category.
 */
export function hasToolScope(
  payload: CapabilityTokenPayload,
  toolName: string,
  toolCategory: string
): boolean {
  for (const scope of payload.scope) {
    if (scope === `tool:${toolName}`) return true;
    if (scope === `category:${toolCategory}`) return true;
    if (scope === "*") return true;
  }
  return false;
}

/**
 * Build a default scope set for a sub-agent type. Used by the
 * `DelegateTaskTool` to construct a child token when delegating work.
 */
export function defaultScopesForRole(role: string): ToolScope[] {
  switch (role) {
    case "explorer":
      return ["tool:read_file", "tool:list_directory", "tool:search_files", "tool:search_content", "tool:fetch_url", "tool:web_search"];
    case "editor":
      return ["category:filesystem", "category:code", "tool:read_lints"];
    case "tester":
      return ["category:shell", "tool:read_lints", "tool:run_tests"];
    case "reviewer":
      return ["category:filesystem", "category:git", "tool:read_file", "tool:git_diff", "tool:git_log"];
    case "web":
      return ["tool:fetch_url", "tool:web_search"];
    case "full":
      return ["*"];
    default:
      return ["*"];
  }
}
