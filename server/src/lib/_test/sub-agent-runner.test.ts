import { describe, expect, it } from "vitest";
import { buildChildConfig, buildChildSystemPrompt, CHILD_SAFE_TOOLS } from "../sub-agent-runner.js";
import type { ChildAgentHandle } from "../../tools/sub-agents.js";

// Test fixtures only — values are constructed at runtime so no usable
// credential literal ever appears in source.
const FIXTURE_KEY = ["fixture", "inherited", "key"].join("-");
const FIXTURE_SECRET = ["fixture", "encryption", "secret"].join("-");

function makeHandle(overrides: Partial<ChildAgentHandle> = {}): ChildAgentHandle {
  return {
    id: "child-agent-1-test",
    parentConversationId: "conv-1",
    parentRunId: "conv-1",
    task: "Investigate the workspace layout and report findings.",
    agentType: "general",
    breadth: "medium",
    status: "pending",
    createdAt: new Date(),
    toolCallCount: 0,
    iterationCount: 0,
    maxIterations: 15,
    abortController: new AbortController(),
    ...overrides
  };
}

describe("buildChildConfig", () => {
  it("sets primaryApiKeyId so the inherited key is actually usable", () => {
    // Regression: without primaryApiKeyId, resolveKeysToTry() dropped the
    // parent's key and every child LLM call failed with "no keys available".
    const config = buildChildConfig(
      {
        provider: "puter",
        model: "gpt-5-nano",
        baseUrl: "https://api.puter.com/puterai/openai/v1/",
        apiKey: FIXTURE_KEY
      },
      makeHandle(),
      [],
      ["read_file"]
    );

    expect(config.provider).toBe("puter");
    expect(config.apiKey).toBe(FIXTURE_KEY);
    expect(config.primaryApiKeyId).toBeTruthy();
    expect(config.primaryApiKeyName).toBe("inherited from parent");
  });

  it("omits primaryApiKeyId when there is no inherited key", () => {
    const config = buildChildConfig(undefined, makeHandle(), [], ["read_file"]);

    // No inherited key — nothing should pretend to be a usable primary key.
    expect(config.primaryApiKeyId).toBeUndefined();
    expect(config.fallbackApiKeys).toBeUndefined();
  });

  it("carries fallback keys and the encryption secret through", () => {
    const config = buildChildConfig(
      {
        provider: "openai",
        model: "gpt-5",
        baseUrl: "https://api.openai.com/v1",
        apiKey: FIXTURE_KEY,
        fallbackApiKeys: [{ apiKeyEncrypted: ["fixture", "encrypted", "blob"].join("."), id: "key-2" }],
        encryptionSecret: FIXTURE_SECRET
      },
      makeHandle(),
      [],
      ["read_file"]
    );

    expect(config.encryptionSecret).toBe(FIXTURE_SECRET);
    expect(config.fallbackApiKeys).toEqual([
      { apiKeyEncrypted: ["fixture", "encrypted", "blob"].join("."), id: "key-2", name: "key-2" }
    ]);
  });
});

describe("buildChildSystemPrompt — agent types", () => {
  it("explore prompt: locate-and-cite discipline, breadth guidance, no specialist block", () => {
    const prompt = buildChildSystemPrompt(makeHandle({ agentType: "explore", breadth: "quick" }), null);

    expect(prompt).toContain("EXPLORE child agent");
    expect(prompt).toContain("Locate, don't audit");
    expect(prompt).toContain("QUICK breadth");
    expect(prompt).toContain("file.ts:line");
    expect(prompt).not.toContain("Operating mode");
  });

  it("explore very_thorough prompt instructs an exhaustive sweep", () => {
    const prompt = buildChildSystemPrompt(makeHandle({ agentType: "explore", breadth: "very_thorough" }), null);
    expect(prompt).toContain("VERY THOROUGH breadth");
  });

  it("general prompt keeps the specialist methodology block", () => {
    const prompt = buildChildSystemPrompt(
      makeHandle({ agentType: "general" }),
      { name: "research_specialist", instructions: "Investigate systematically." }
    );

    expect(prompt).toContain("isolated child agent");
    expect(prompt).toContain("Operating mode — research_specialist");
    expect(prompt).toContain("Investigate systematically.");
    // Children never get the ask tool — matches ZCode (AskUserQuestion is
    // filtered out of subagents).
    expect(prompt).toContain("cannot ask the user questions");
  });
});

describe("CHILD_SAFE_TOOLS", () => {
  it("never includes write, shell, or ask tools", () => {
    for (const tool of CHILD_SAFE_TOOLS) {
      expect(tool).not.toMatch(/^(write_|edit_|append_|execute_|ask_user|git_commit)/);
    }
  });
});
