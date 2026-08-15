import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "vitest";

import { Agent } from "../../agent.js";
import { ReplayLLMClient } from "../snapshot/replay-llm.js";
import { loadFixture } from "../snapshot/runner.js";

describe("_debug-snapshot", () => {
  it("captures the actual event stream", async () => {
    // The debug test picks up the fixture named via env var or defaults
    // to chat-greeter. Set DEBUG_FIXTURE to switch.
    const fixtureName = process.env.DEBUG_FIXTURE ?? "chat-greeter";
    const fixture = await loadFixture(fixtureName);
    const replay = new ReplayLLMClient({ fixture });

    const ctx = {
      workspaceRoot: "",
      conversationId: `snapshot-${fixtureName}`,
      mode: fixture.input.mode,
      autoApproveTools: new Set<string>()
    };

    const cfg = {
      model: "gemini-2.5-pro",
      provider: "gemini",
      seedHistory: [],
      maxIterations: 25,
      isNewConversation: true,
      apiKey: "test",
      primaryApiKeyId: "test",
      primaryApiKeyName: "test"
    };

    const agent = new Agent(ctx as never, cfg as never, replay as never);
    const events: unknown[] = [];
    for await (const ev of agent.stream(fixture.input.userPrompt)) {
      events.push(ev);
    }

    const out = resolve(process.cwd(), ".tmp-snapshot-debug", "agent-events.json");
    writeFileSync(out, JSON.stringify(events, null, 2), "utf-8");
    console.log(`Wrote ${events.length} events to ${out}`);
  }, 30_000);
});