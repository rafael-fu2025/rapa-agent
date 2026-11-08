import { describe, expect, it } from "vitest";
import { detectIntentWithoutAction } from "../../agent.js";

describe("detectIntentWithoutAction — greeting false positives (live: 'hi' → 3 wasted rounds)", () => {
  it("ignores a no-tools meta statement echoing the system prompt", () => {
    expect(
      detectIntentWithoutAction("I'll just respond in plain prose, no tool calls needed.")
    ).toBeNull();
  });

  it("ignores 'let me know' — a question to the user, not a promise", () => {
    expect(
      detectIntentWithoutAction("Let me know what you'd like to build or fix.")
    ).toBeNull();
  });

  it("ignores a short greeting with both patterns", () => {
    expect(
      detectIntentWithoutAction(
        "Hi! I'll just respond in plain prose, no tool calls needed. Let me know what you'd like to build or fix."
      )
    ).toBeNull();
  });

  it("ignores a trailing question — a legitimate turn end", () => {
    expect(detectIntentWithoutAction("Should I go ahead and read the file?")).toBeNull();
  });

  it("ignores deliberation verbs", () => {
    expect(detectIntentWithoutAction("I should probably check the logs first.")).toBeNull();
  });

  it("still catches real stalls", () => {
    expect(detectIntentWithoutAction("Let me read the file.")).toMatch(/let me read the file/i);
    expect(detectIntentWithoutAction("I'll create the component now.")).toMatch(/I'll create/i);
    expect(detectIntentWithoutAction("I'm going to run the tests.")).toMatch(/going to run/i);
  });

  it("catches a stall even when 'let me know' appears earlier in the text", () => {
    expect(
      detectIntentWithoutAction("Let me know if you want details. I'll now implement the parser.")
    ).toMatch(/I'll now implement/i);
  });

  it("keeps the long-answer and code-fence guards", () => {
    expect(detectIntentWithoutAction("Let me read the file. ".repeat(40))).toBeNull();
    expect(detectIntentWithoutAction("```\nLet me read the file.\n```")).toBeNull();
  });
});
