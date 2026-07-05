// Lightweight tracing primitives (research O1/O2).
//
// We deliberately avoid the full OpenTelemetry SDK to keep dependencies tight.
// Instead, we provide a minimal span API. The active trace context is tracked
// via AsyncLocalStorage (so nested spans inherit traceId across await points)
// AND a module-level stack as a fallback for the common case where
// `startTrace` is called once at the top of an operation and `withSpan` is
// called inline afterwards. The ALS context is the authoritative source when
// present; the module stack is the fallback.
//
// Spans can be exported to a pluggable sink (no-op by default; the Langfuse
// exporter in `./langfuse-exporter.js` ships OTLP/HTTP). This satisfies the
// Phase 1 observability acceptance criteria from the roadmap without
// requiring a runtime dependency.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type SpanStatus = "ok" | "error" | "cancelled";

export type Span = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: SpanStatus;
  attributes: Record<string, string | number | boolean | undefined>;
  events: Array<{ name: string; timestamp: number; attributes?: Record<string, unknown> }>;
};

export type SpanExporter = {
  export(spans: Span[]): void;
  /**
   * Optional lifecycle hook called once on process shutdown. Implementations
   * that buffer spans in memory (e.g. Langfuse) flush here. Implementations
   * that ship spans synchronously (e.g. console) can omit this method.
   */
  shutdown?(): void | Promise<void>;
};

const noopExporter: SpanExporter = {
  export() {
    // Intentionally empty
  }
};

class TracerState {
  traceId: string;
  currentSpan?: Span;
  completedSpans: Span[] = [];
  exporter: SpanExporter = noopExporter;
  enabled: boolean;

  constructor(traceId: string, enabled: boolean) {
    this.traceId = traceId;
    this.enabled = enabled;
  }
}

const storage = new AsyncLocalStorage<TracerState>();
// Module-level stack so `startTrace`/`withSpan` work without forcing the
// caller to wrap their code in `storage.run`. Pushed on startTrace, popped
// when the trace is ended (manually or via endTrace).
const activeTraces: TracerState[] = [];

let globalEnabled = (process.env.AGENT_TRACING ?? "true") !== "false";
let globalExporter: SpanExporter = noopExporter;

export function configureTracing(options: { enabled?: boolean; exporter?: SpanExporter }): void {
  if (options.enabled !== undefined) globalEnabled = options.enabled;
  if (options.exporter) globalExporter = options.exporter;
}

export function getActiveExporter(): SpanExporter {
  return globalExporter;
}

function currentState(): TracerState | undefined {
  return storage.getStore() ?? activeTraces[activeTraces.length - 1];
}

/**
 * Open a new root trace span. The returned span is also pushed onto the
 * module-level active trace stack so that subsequent `withSpan`/`setSpanAttribute`
 * calls inherit the trace context without the caller having to wrap their
 * code in `storage.run`.
 *
 * If you want to deterministically bound the trace lifetime, use
 * `runWithTrace(span, fn)`. The module-level stack is cleaned up when the
 * trace's root span is ended via `endTrace(span)` or by calling
 * `flushTrace()`.
 */
export function startTrace(name: string, attributes: Record<string, string | number | boolean> = {}): Span {
  const traceId = randomUUID().replace(/-/g, "").slice(0, 16);
  const rootSpan: Span = {
    traceId,
    spanId: randomUUID().replace(/-/g, "").slice(0, 16),
    name,
    startTime: Date.now(),
    status: "ok",
    attributes,
    events: []
  };
  const state = new TracerState(traceId, globalEnabled);
  state.exporter = globalExporter;
  state.currentSpan = rootSpan;
  if (state.enabled) {
    activeTraces.push(state);
    // Also enter the ALS context synchronously so spans survive `await`
    // boundaries started inside the same tick. The ALS context exits as
    // soon as the synchronous function returns, so the module-level stack
    // is the durable source of truth.
    return storage.run(state, () => rootSpan);
  }
  return rootSpan;
}

/**
 * Run `fn` inside the trace's ALS context. Use when you need spans nested
 * across `await` points to inherit the traceId reliably.
 */
export function runWithTrace<T>(span: Span, fn: () => T | Promise<T>): T | Promise<T> {
  const state = activeTraces.find((s) => s.currentSpan === span);
  if (!state) return fn();
  return storage.run(state, fn);
}

export function getCurrentSpan(): Span | undefined {
  return currentState()?.currentSpan;
}

export function getCurrentTraceId(): string | undefined {
  return currentState()?.traceId;
}

export function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean> = {},
  fn: (span: Span) => Promise<T> | T
): Promise<T> | T {
  const state = currentState();
  if (!state || !state.enabled) {
    // Tracing disabled or no context — run without spans.
    return fn({
      traceId: "noop",
      spanId: "noop",
      name,
      startTime: Date.now(),
      status: "ok",
      attributes,
      events: []
    });
  }

  const span: Span = {
    traceId: state.traceId,
    spanId: randomUUID().replace(/-/g, "").slice(0, 16),
    parentSpanId: state.currentSpan?.spanId,
    name,
    startTime: Date.now(),
    status: "ok",
    attributes,
    events: []
  };
  const previous = state.currentSpan;
  state.currentSpan = span;
  try {
    const result = fn(span);
    if (result instanceof Promise) {
      return result.finally(() => {
        endSpan(state, span);
        state.currentSpan = previous;
      });
    }
    endSpan(state, span);
    state.currentSpan = previous;
    return result;
  } catch (error) {
    span.status = "error";
    span.endTime = Date.now();
    span.durationMs = span.endTime - span.startTime;
    state.completedSpans.push(span);
    state.currentSpan = previous;
    throw error;
  }
}

function endSpan(state: TracerState, span: Span): void {
  if (span.endTime !== undefined) return;
  span.endTime = Date.now();
  span.durationMs = span.endTime - span.startTime;
  state.completedSpans.push(span);
  // Drain in batches of 50 to avoid unbounded memory.
  if (state.completedSpans.length >= 50) {
    const drained = state.completedSpans.splice(0, 50);
    state.exporter.export(drained);
  }
}

/**
 * Close a root trace and remove it from the active stack. Returns the spans
 * that were emitted (or rather, schedules them for export).
 */
export function endTrace(rootSpan: Span): Span[] {
  const idx = activeTraces.findIndex((s) => s.currentSpan === rootSpan);
  if (idx === -1) {
    return flushTrace();
  }
  const state = activeTraces[idx];
  endSpan(state, rootSpan);
  activeTraces.splice(idx, 1);
  return flushState(state);
}

export function recordEvent(name: string, attributes?: Record<string, unknown>): void {
  const span = currentState()?.currentSpan;
  if (!span) return;
  span.events.push({ name, timestamp: Date.now(), attributes });
}

export function setSpanAttribute(key: string, value: string | number | boolean | undefined): void {
  const span = currentState()?.currentSpan;
  if (!span) return;
  span.attributes[key] = value;
}

function flushState(state: TracerState): Span[] {
  if (state.completedSpans.length === 0) return [];
  const remaining = state.completedSpans.splice(0, state.completedSpans.length);
  state.exporter.export(remaining);
  return remaining;
}

export function flushTrace(): Span[] {
  // Flush all active traces — used by the Fastify onClose hook.
  const out: Span[] = [];
  for (const state of activeTraces.splice(0)) {
    // If the root span is still "open" (currentSpan never advanced), close
    // it so its events/attributes ship to the exporter.
    if (state.currentSpan && state.currentSpan.endTime === undefined) {
      endSpan(state, state.currentSpan);
    }
    out.push(...flushState(state));
  }
  return out;
}

/**
 * Console exporter — useful for local debugging. Emits a one-line summary
 * per span to stdout.
 */
export const consoleSpanExporter: SpanExporter = {
  export(spans) {
    for (const span of spans) {
      const parent = span.parentSpanId ? ` parent=${span.parentSpanId.slice(0, 8)}` : "";
      // eslint-disable-next-line no-console
      console.log(
        `[trace ${span.traceId.slice(0, 8)}] ${span.name}${parent} ${span.durationMs ?? 0}ms status=${span.status}`
      );
    }
  }
};
