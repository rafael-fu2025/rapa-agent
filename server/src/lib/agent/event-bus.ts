/**
 * Typed in-process event bus for the agent loop.
 *
 * Three domains (agent/*, tools/*, session/*) and two listener
 * kinds (`on` for serial observation, `intercept` for waterfall
 * modification).
 *
 * See `.agents/notes/implemented/architecture/2026-08-15-in-process-event-bus.md`.
 */

export type AgentEventMap = {
  "agent/turn/start": {
    conversationId: string;
    mode: string;
    iterationBudget: number;
  };
  "agent/turn/end": {
    status: "completed" | "max_iterations" | "failed" | "interrupted";
    iterations: number;
    elapsedMs?: number;
  };
  "agent/step/start": { iteration: number };
  "agent/step/end": { iteration: number };
  "tools/tool/call": { call: { id: string; name: string; parameters: Record<string, unknown> } };
  "tools/tool/result": {
    call: { id: string; name: string; parameters: Record<string, unknown> };
    result: { success: boolean; output?: string; error?: string };
  };
  "session/session/start": { conversationId: string };
  "session/session/end": {
    status: "completed" | "max_iterations" | "failed" | "interrupted";
  };
  "session/session/error": { message: string };
  // Phase 2.3 — plan-mode transitions ride the same bus.
  "plan/enter": {
    mode: "plan";
    conversationId: string;
    reason: "explicit" | "default";
  };
  "plan/step": {
    step: { title: string; status: string };
    index: number;
  };
  "plan/exit": {
    reason: "completed" | "switched_to_agent" | "interrupted";
    finalStepCount: number;
  };
};

export type AgentEventKind = keyof AgentEventMap;

type SerialListener<K extends AgentEventKind> = (payload: AgentEventMap[K]) => void;
type WaterfallListener<K extends AgentEventKind> = (
  payload: AgentEventMap[K],
  next: () => Promise<void> | void
) => Promise<void> | void;

interface ListenerEntry<K extends AgentEventKind = AgentEventKind> {
  serial: SerialListener<K>[];
  waterfall: WaterfallListener<K>[];
}

/**
 * The bus is sync-only. Listeners run in registration order; throws
 * in serial listeners are caught and logged, throws in waterfall
 * listeners propagate.
 */
export class AgentEventBus {
  private listeners: { [K in AgentEventKind]: ListenerEntry<K> } = {
    "agent/turn/start": { serial: [], waterfall: [] },
    "agent/turn/end": { serial: [], waterfall: [] },
    "agent/step/start": { serial: [], waterfall: [] },
    "agent/step/end": { serial: [], waterfall: [] },
    "tools/tool/call": { serial: [], waterfall: [] },
    "tools/tool/result": { serial: [], waterfall: [] },
    "session/session/start": { serial: [], waterfall: [] },
    "session/session/end": { serial: [], waterfall: [] },
    "session/session/error": { serial: [], waterfall: [] },
    "plan/enter": { serial: [], waterfall: [] },
    "plan/step": { serial: [], waterfall: [] },
    "plan/exit": { serial: [], waterfall: [] }
  };

  /** Add a serial (observational) listener for an event. */
  on<K extends AgentEventKind>(kind: K, listener: SerialListener<K>): () => void {
    const entry = this.listeners[kind] as ListenerEntry<K>;
    entry.serial.push(listener);
    return () => {
      const idx = entry.serial.indexOf(listener);
      if (idx >= 0) entry.serial.splice(idx, 1);
    };
  }

  /**
   * Add a waterfall (intercepting) listener for an event.
   * Listeners must call `next()` to delegate to subsequent
   * listeners + serial listeners; returning without `next()`
   * short-circuits the chain.
   */
  intercept<K extends AgentEventKind>(kind: K, listener: WaterfallListener<K>): () => void {
    const entry = this.listeners[kind] as ListenerEntry<K>;
    entry.waterfall.push(listener);
    return () => {
      const idx = entry.waterfall.indexOf(listener);
      if (idx >= 0) entry.waterfall.splice(idx, 1);
    };
  }

  /**
   * Emit an event. Walks waterfall listeners in registration
   * order; each must call `next()` to continue. Serial listeners
   * fire after the waterfall chain completes. Serial listener
   * errors are caught and logged; waterfall errors propagate.
   */
  async emit<K extends AgentEventKind>(kind: K, payload: AgentEventMap[K]): Promise<void> {
    const entry = this.listeners[kind] as ListenerEntry<K>;

    // Walk waterfall chain. Each listener gets a `next` thunk that
    // advances to the next listener. A listener that returns
    // without calling `next()` short-circuits.
    let idx = 0;
    const walk = async (): Promise<void> => {
      if (idx >= entry.waterfall.length) return;
      const listener = entry.waterfall[idx]!;
      idx += 1;
      await listener(payload, walk);
    };
    await walk();

    // Fire serial listeners after the waterfall completes.
    for (const listener of entry.serial) {
      try {
        listener(payload);
      } catch (err) {
        // Log via console.error — the bus is silent by design,
        // but a misbehaving listener should not silently vanish.
        // Phase 3 may route this through tracing.ts.
        // eslint-disable-next-line no-console
        console.error(`[AgentEventBus] serial listener for "${kind}" threw:`, err);
      }
    }
  }

  /** Test helper: number of listeners (serial + waterfall) for an event. */
  listenerCount<K extends AgentEventKind>(kind: K): number {
    const entry = this.listeners[kind] as ListenerEntry<K>;
    return entry.serial.length + entry.waterfall.length;
  }
}