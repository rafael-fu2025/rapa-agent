// Exit Hatch pattern (research UX P2-C).
//
// Lets the user pause a running agent, inspect what it's about to do, and
// either redirect it to a new task or resume the original. This is the
// single most important trust feature for long-running agents — without
// it, users feel locked in and the agent becomes a "fire and forget"
// black box.
//
// Wire model:
//   - The frontend issues `POST /api/agent/runs/:id/pause` to request a
//     pause. The agent loop checks a "shouldPause" flag at the start of
//     every iteration and returns a `paused` event before doing more work.
//   - To redirect, the frontend issues `POST /api/agent/runs/:id/redirect`
//     with a new prompt. The paused run resumes with the new prompt
//     injected at the top of its history.
//   - To abort, the frontend issues `POST /api/agent/runs/:id/abort`. The
//     agent's pending tool approvals are resolved with rejection and the
//     loop exits with status "aborted".
//
// The pattern is deliberately *cooperative* — the agent checks the flag
// at safe points (start of iteration, between tool calls). A truly
// runaway agent (e.g. infinite loop) would need a hard kill switch
// outside the scope of this module.

import { EventEmitter } from "node:events";

export type ExitHatchSignal = "pause" | "resume" | "redirect" | "abort";

export type ExitHatchState = {
  runId: string;
  paused: boolean;
  /** Pending redirect prompt — applied when the run resumes. */
  pendingRedirect?: string;
  /** Set once a `resume` is dispatched. The agent loop clears it. */
  resumeRequestedAt?: number;
  /** When the user requested a pause. */
  pausedAt?: number;
  /** Set true if the run was aborted. The loop MUST exit immediately. */
  aborted: boolean;
  /** Set true if the run was redirected. The loop injects the new prompt. */
  redirected: boolean;
};

class ExitHatchRegistry {
  private readonly emitter = new EventEmitter();
  private readonly states = new Map<string, ExitHatchState>();
  private readonly REDIRECT_NOTE = "[user-redirect]";

  register(runId: string): ExitHatchState {
    const existing = this.states.get(runId);
    if (existing) return existing;
    const state: ExitHatchState = { runId, paused: false, aborted: false, redirected: false };
    this.states.set(runId, state);
    return state;
  }

  get(runId: string): ExitHatchState | undefined {
    return this.states.get(runId);
  }

  unregister(runId: string): void {
    this.states.delete(runId);
  }

  pause(runId: string): ExitHatchState {
    const state = this.register(runId);
    if (!state.paused && !state.aborted) {
      state.paused = true;
      state.pausedAt = Date.now();
      this.emitter.emit("signal", runId, "pause" as ExitHatchSignal);
    }
    return state;
  }

  resume(runId: string): ExitHatchState {
    const state = this.register(runId);
    state.paused = false;
    state.resumeRequestedAt = Date.now();
    state.pendingRedirect = undefined;
    state.redirected = false;
    this.emitter.emit("signal", runId, "resume" as ExitHatchSignal);
    return state;
  }

  redirect(runId: string, newPrompt: string): ExitHatchState {
    const state = this.register(runId);
    state.paused = true;
    state.pendingRedirect = newPrompt;
    state.redirected = true;
    state.pausedAt = Date.now();
    this.emitter.emit("signal", runId, "redirect" as ExitHatchSignal);
    return state;
  }

  abort(runId: string): ExitHatchState {
    const state = this.register(runId);
    state.aborted = true;
    state.paused = true;
    state.pausedAt = Date.now();
    this.emitter.emit("signal", runId, "abort" as ExitHatchSignal);
    return state;
  }

  /**
   * Cooperative check called by the agent loop at the start of each
   * iteration. Returns:
   *   - "continue"   — proceed normally
   *   - "pause"      — wait for the user to resume/redirect/abort
   *   - "abort"      — terminate the loop
   *   - "redirect"   — drain the queued redirect, then continue
   */
  check(runId: string): "continue" | "pause" | "abort" | "redirect" {
    const state = this.states.get(runId);
    if (!state) return "continue";
    if (state.aborted) return "abort";
    if (state.paused) {
      if (state.redirected) return "redirect";
      return "pause";
    }
    return "continue";
  }

  /** Consume the pending redirect — call once the agent has acknowledged it. */
  consumeRedirect(runId: string): string | undefined {
    const state = this.states.get(runId);
    if (!state || !state.redirected) return undefined;
    const prompt = state.pendingRedirect;
    state.pendingRedirect = undefined;
    state.redirected = false;
    state.paused = false;
    return prompt;
  }

  onSignal(listener: (runId: string, signal: ExitHatchSignal) => void): () => void {
    this.emitter.on("signal", listener);
    return () => this.emitter.off("signal", listener);
  }

  /** For tests: clear all state. */
  reset(): void {
    this.states.clear();
  }
}

const globalKey = "__rapaExitHatchRegistry__" as const;

type GlobalWithRegistry = typeof globalThis & {
  [globalKey]?: ExitHatchRegistry;
};

export function exitHatchRegistry(): ExitHatchRegistry {
  const g = globalThis as GlobalWithRegistry;
  if (!g[globalKey]) {
    g[globalKey] = new ExitHatchRegistry();
  }
  return g[globalKey]!;
}

/** Build the SSE event payload for a pause / redirect / abort signal. */
export function buildExitHatchEvent(state: ExitHatchState): {
  type: "paused" | "aborted" | "redirected" | "resumed";
  data: Record<string, unknown>;
} {
  if (state.aborted) {
    return { type: "aborted", data: { runId: state.runId, at: state.pausedAt ?? Date.now() } };
  }
  if (state.redirected) {
    return {
      type: "redirected",
      data: {
        runId: state.runId,
        prompt: state.pendingRedirect,
        at: state.pausedAt ?? Date.now()
      }
    };
  }
  if (state.paused) {
    return { type: "paused", data: { runId: state.runId, at: state.pausedAt ?? Date.now() } };
  }
  return { type: "resumed", data: { runId: state.runId, at: state.resumeRequestedAt ?? Date.now() } };
}
