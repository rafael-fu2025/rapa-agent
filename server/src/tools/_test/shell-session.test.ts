import { describe, expect, it, vi } from "vitest";

// Force the native-shell fallback path: a throwing pty.spawn makes
// createSession() fall through to spawnNativeShellSession(), which is
// the code path that used to crash the whole server on spawn errors.
vi.mock("node-pty", () => ({
  spawn: () => {
    throw new Error("pty unavailable in test");
  }
}));

import {
  closeTerminalSession,
  getTerminalSessionOutput,
  listTerminalSessions,
  subscribeToTerminalSession
} from "../shell.js";

describe("native shell session spawn errors", () => {
  it("degrades to a closed session instead of crashing when the cwd does not exist", async () => {
    const sessionId = `test-dead-cwd-${Date.now()}`;
    const ownerId = "test-owner";

    const subscription = await subscribeToTerminalSession(
      {
        sessionId,
        // A directory that cannot exist on any platform.
        cwd: "Z:\\rapa-test-definitely-missing-dir",
        ownerId,
        conversationId: undefined
      },
      () => {}
    );

    // The spawn 'error' event fires asynchronously (next-tick). Give it
    // a moment, then assert the session was marked closed with a
    // readable message in its buffer — and crucially, that the process
    // did not die with an unhandled 'error' event.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const result = getTerminalSessionOutput(sessionId, ownerId);
    expect(result?.output).toContain("[terminal error]");
    expect(result?.output.toLowerCase()).toContain("could not be started");

    const listed = listTerminalSessions(ownerId);
    const session = listed.find((s) => s.sessionId === sessionId);
    expect(session?.closed).toBe(true);

    subscription.unsubscribe();
    closeTerminalSession(sessionId, ownerId);
  });
});
