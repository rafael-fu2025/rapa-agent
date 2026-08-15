/**
 * Event bus tests.
 *
 * See `.agents/notes/implemented/architecture/2026-08-15-in-process-event-bus.md`.
 */

import { describe, expect, it } from "vitest";

import { AgentEventBus } from "../event-bus.js";

describe("AgentEventBus", () => {
  it("invokes serial listeners in registration order", async () => {
    const bus = new AgentEventBus();
    const calls: string[] = [];
    bus.on("agent/step/start", () => { calls.push("a"); });
    bus.on("agent/step/start", () => { calls.push("b"); });
    bus.on("agent/step/start", () => { calls.push("c"); });

    await bus.emit("agent/step/start", { iteration: 1 });
    expect(calls).toEqual(["a", "b", "c"]);
  });

  it("returns a disposer that removes the listener", async () => {
    const bus = new AgentEventBus();
    const calls: string[] = [];
    const off = bus.on("agent/step/start", () => { calls.push("a"); });

    await bus.emit("agent/step/start", { iteration: 1 });
    off();
    await bus.emit("agent/step/start", { iteration: 2 });

    expect(calls).toEqual(["a"]);
  });

  it("waterfall listeners all run when each calls next()", async () => {
    const bus = new AgentEventBus();
    const calls: string[] = [];
    bus.intercept("tools/tool/call", async (_payload, next) => {
      calls.push("a");
      await next();
    });
    bus.intercept("tools/tool/call", async (_payload, next) => {
      calls.push("b");
      await next();
    });

    await bus.emit("tools/tool/call", { call: { id: "c1", name: "read_file", parameters: {} } });
    expect(calls).toEqual(["a", "b"]);
  });

  it("waterfall short-circuits when a listener does not call next()", async () => {
    const bus = new AgentEventBus();
    const calls: string[] = [];
    bus.intercept("tools/tool/call", async () => {
      calls.push("a");
      // no next() — chain stops
    });
    bus.intercept("tools/tool/call", async () => {
      calls.push("b");
    });

    await bus.emit("tools/tool/call", { call: { id: "c1", name: "read_file", parameters: {} } });
    expect(calls).toEqual(["a"]);
  });

  it("waterfall chain runs end-to-end, then serial listeners fire (observers see final state)", async () => {
    const bus = new AgentEventBus();
    const calls: string[] = [];
    bus.intercept("agent/turn/start", async (_p, next) => {
      calls.push("interceptor-before");
      await next();
      calls.push("interceptor-after");
    });
    bus.on("agent/turn/start", () => { calls.push("serial"); });

    await bus.emit("agent/turn/start", { conversationId: "c1", mode: "plan", iterationBudget: 25 });
    // Serial listeners run AFTER the entire waterfall chain completes
    // (including each interceptor's post-next code). This ensures
    // observers see the *final* event state, not an intermediate.
    expect(calls).toEqual(["interceptor-before", "interceptor-after", "serial"]);
  });

  it("serial listener errors are caught and do not stop other listeners", async () => {
    const bus = new AgentEventBus();
    const calls: string[] = [];
    const orig = console.error;
    console.error = () => {}; // suppress expected error log

    bus.on("session/session/end", () => { calls.push("a"); });
    bus.on("session/session/end", () => { throw new Error("boom"); });
    bus.on("session/session/end", () => { calls.push("c"); });

    await bus.emit("session/session/end", { status: "completed" });
    console.error = orig;

    expect(calls).toEqual(["a", "c"]);
  });

  it("waterfall listener errors propagate to the caller", async () => {
    const bus = new AgentEventBus();
    bus.intercept("session/session/error", async () => {
      throw new Error("interceptor boom");
    });

    await expect(
      bus.emit("session/session/error", { message: "x" })
    ).rejects.toThrow("interceptor boom");
  });

  it("listenerCount returns the total listeners for an event", () => {
    const bus = new AgentEventBus();
    bus.on("agent/step/end", () => {});
    bus.intercept("agent/step/end", () => {});
    bus.intercept("agent/step/end", () => {});

    expect(bus.listenerCount("agent/step/end")).toBe(3);
    expect(bus.listenerCount("agent/step/start")).toBe(0);
  });
});