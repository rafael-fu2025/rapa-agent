import { describe, it, expect } from "vitest";
import {
  issueCapabilityToken,
  verifyCapabilityToken,
  hasToolScope,
  defaultScopesForRole,
  type CapabilityTokenPayload
} from "./tool-scopes.js";

const SECRET = "test-secret-with-enough-entropy-32chars";

describe("issueCapabilityToken / verifyCapabilityToken", () => {
  it("issues and verifies a token round-trip", () => {
    const issued = issueCapabilityToken(
      { sub: "explorer-1", scope: ["tool:read_file"], exp: Math.floor(Date.now() / 1000) + 60 },
      SECRET
    );
    const payload = verifyCapabilityToken(issued.token, SECRET);
    expect(payload.sub).toBe("explorer-1");
    expect(payload.scope).toContain("tool:read_file");
  });

  it("throws on a tampered token", () => {
    const issued = issueCapabilityToken(
      { sub: "x", scope: ["tool:read_file"], exp: Math.floor(Date.now() / 1000) + 60 },
      SECRET
    );
    // Tamper with the body segment (the middle of the three dot-separated
    // parts) — flipping a base64 character invalidates the signature.
    const parts = issued.token.split(".");
    const tamperedBody = parts[1].slice(0, -1) + (parts[1].slice(-1) === "A" ? "B" : "A");
    const tampered = `${parts[0]}.${tamperedBody}.${parts[2]}`;
    expect(() => verifyCapabilityToken(tampered, SECRET)).toThrow();
  });

  it("throws on an expired token", () => {
    const issued = issueCapabilityToken(
      { sub: "x", scope: ["tool:read_file"], exp: Math.floor(Date.now() / 1000) - 100 },
      SECRET
    );
    expect(() => verifyCapabilityToken(issued.token, SECRET)).toThrow(/expired/);
  });

  it("throws on a malformed token", () => {
    expect(() => verifyCapabilityToken("not-a-token", SECRET)).toThrow(/Malformed/);
  });

  it("throws on a token signed with a different secret", () => {
    const issued = issueCapabilityToken(
      { sub: "x", scope: ["tool:read_file"], exp: Math.floor(Date.now() / 1000) + 60 },
      "different-secret"
    );
    expect(() => verifyCapabilityToken(issued.token, SECRET)).toThrow();
  });

  it("rejects weak secrets", () => {
    expect(() =>
      issueCapabilityToken(
        { sub: "x", scope: ["*"], exp: Math.floor(Date.now() / 1000) + 60 },
        "short"
      )
    ).toThrow();
  });
});

describe("hasToolScope", () => {
  const payload: CapabilityTokenPayload = {
    sub: "x",
    scope: ["tool:read_file", "category:filesystem"],
    exp: Math.floor(Date.now() / 1000) + 60
  };

  it("matches a tool:<name> scope", () => {
    expect(hasToolScope(payload, "read_file", "filesystem")).toBe(true);
  });

  it("matches a category:<name> scope for any tool in that category", () => {
    expect(hasToolScope(payload, "write_file", "filesystem")).toBe(true);
  });

  it("rejects a tool that is in neither scope", () => {
    expect(hasToolScope(payload, "execute_command", "shell")).toBe(false);
  });

  it("accepts the wildcard scope", () => {
    expect(hasToolScope({ ...payload, scope: ["*"] }, "anything", "anything")).toBe(true);
  });
});

describe("defaultScopesForRole", () => {
  it("returns a small read-only scope set for explorer", () => {
    const scopes = defaultScopesForRole("explorer");
    expect(scopes).toContain("tool:read_file");
    expect(scopes).not.toContain("tool:write_file");
  });

  it("returns a wildcard for the full role", () => {
    expect(defaultScopesForRole("full")).toContain("*");
  });
});
