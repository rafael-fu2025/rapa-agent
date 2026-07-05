import { describe, it, expect, beforeEach } from "vitest";
import { exitHatchRegistry, buildExitHatchEvent } from "./exit-hatch.js";

describe("exitHatchRegistry", () => {
  beforeEach(() => {
    exitHatchRegistry().reset();
  });

  it("returns continue for a fresh run", () => {
    expect(exitHatchRegistry().check("run-1")).toBe("continue");
  });

  it("pause sets paused flag and returns pause on next check", () => {
    const reg = exitHatchRegistry();
    reg.register("run-1");
    reg.pause("run-1");
    expect(reg.check("run-1")).toBe("pause");
  });

  it("resume clears paused flag and clears redirect state", () => {
    const reg = exitHatchRegistry();
    reg.register("run-1");
    reg.pause("run-1");
    reg.resume("run-1");
    expect(reg.check("run-1")).toBe("continue");
  });

  it("redirect sets paused + redirected + pending prompt", () => {
    const reg = exitHatchRegistry();
    reg.register("run-1");
    reg.redirect("run-1", "new instructions");
    expect(reg.check("run-1")).toBe("redirect");
    expect(reg.consumeRedirect("run-1")).toBe("new instructions");
    expect(reg.check("run-1")).toBe("continue");
  });

  it("abort short-circuits the check", () => {
    const reg = exitHatchRegistry();
    reg.register("run-1");
    reg.abort("run-1");
    expect(reg.check("run-1")).toBe("abort");
  });

  it("emits signals to listeners", () => {
    const reg = exitHatchRegistry();
    const events: string[] = [];
    reg.onSignal((runId, sig) => events.push(`${runId}:${sig}`));
    reg.register("run-1");
    reg.pause("run-1");
    reg.resume("run-1");
    reg.abort("run-1");
    expect(events).toEqual(["run-1:pause", "run-1:resume", "run-1:abort"]);
  });

  it("unregister removes state", () => {
    const reg = exitHatchRegistry();
    reg.register("run-1");
    reg.pause("run-1");
    reg.unregister("run-1");
    expect(reg.check("run-1")).toBe("continue");
  });
});

describe("buildExitHatchEvent", () => {
  it("emits aborted when state is aborted", () => {
    const event = buildExitHatchEvent({
      runId: "run-1", paused: true, aborted: true, redirected: false, pausedAt: 100
    });
    expect(event.type).toBe("aborted");
  });

  it("emits redirected with prompt", () => {
    const event = buildExitHatchEvent({
      runId: "run-1", paused: true, aborted: false, redirected: true, pendingRedirect: "do X", pausedAt: 100
    });
    expect(event.type).toBe("redirected");
    expect(event.data.prompt).toBe("do X");
  });

  it("emits paused for a normal pause", () => {
    const event = buildExitHatchEvent({
      runId: "run-1", paused: true, aborted: false, redirected: false, pausedAt: 100
    });
    expect(event.type).toBe("paused");
  });

  it("emits resumed when not paused/aborted/redirected", () => {
    const event = buildExitHatchEvent({
      runId: "run-1", paused: false, aborted: false, redirected: false, resumeRequestedAt: 100
    });
    expect(event.type).toBe("resumed");
  });
});
