// Tests for the lightweight tracing primitives.

import { describe, expect, it } from "vitest";
import {
  configureTracing,
  consoleSpanExporter,
  endTrace,
  flushTrace,
  getActiveExporter,
  getCurrentSpan,
  getCurrentTraceId,
  recordEvent,
  setSpanAttribute,
  startTrace,
  withSpan
} from "../tracing.js";

describe("tracing", () => {
  it("exposes the noop exporter by default", () => {
    expect(getActiveExporter()).toBeDefined();
  });

  it("configureTracing replaces the active exporter", () => {
    const collected: string[] = [];
    const capturing = {
      export(spans: Array<{ name: string }>) {
        for (const s of spans) collected.push(s.name);
      }
    };
    configureTracing({ enabled: true, exporter: capturing });
    const span = startTrace("outer");
    expect(span.name).toBe("outer");
    withSpan("inner", {}, () => "done");
    endTrace(span);
    expect(collected).toContain("outer");
    expect(collected).toContain("inner");
  });

  it("startTrace returns a root span that becomes the current span", () => {
    const span = startTrace("root");
    expect(span.name).toBe("root");
    expect(span.parentSpanId).toBeUndefined();
    const current = getCurrentSpan();
    expect(current?.spanId).toBe(span.spanId);
    expect(getCurrentTraceId()).toBe(span.traceId);
    endTrace(span);
  });

  it("withSpan nests child spans and reports them as children of the active span", () => {
    const captured: Array<{ name: string; parent?: string }> = [];
    configureTracing({
      enabled: true,
      exporter: {
        export(spans) {
          for (const s of spans) {
            captured.push({ name: s.name, parent: s.parentSpanId });
          }
        }
      }
    });
    const root = startTrace("outer");
    withSpan("child-a", {}, () => {
      withSpan("grandchild", {}, () => "done");
      return "done-a";
    });
    withSpan("child-b", {}, () => "done-b");
    endTrace(root);
    const grandchild = captured.find((s) => s.name === "grandchild");
    expect(grandchild).toBeDefined();
    expect(grandchild?.parent).toBeDefined();
    // The grandchild's parent must equal one of child-a's spans, not the root.
    expect(grandchild?.parent).not.toBe(root.spanId);
  });

  it("captures errors and marks the span as error", () => {
    const captured: Array<{ name: string; status: string }> = [];
    configureTracing({
      enabled: true,
      exporter: {
        export(spans) {
          for (const s of spans) captured.push({ name: s.name, status: s.status });
        }
      }
    });
    const root = startTrace("error-test");
    expect(() =>
      withSpan("boom", {}, () => {
        throw new Error("kaboom");
      })
    ).toThrow("kaboom");
    endTrace(root);
    const boom = captured.find((s) => s.name === "boom");
    expect(boom?.status).toBe("error");
  });

  it("recordEvent appends to the current span events list", () => {
    const capturedEvents: Array<{ name: string; attributes?: Record<string, unknown> }> = [];
    configureTracing({
      enabled: true,
      exporter: {
        export(spans) {
          for (const s of spans) {
            for (const ev of s.events) capturedEvents.push(ev);
          }
        }
      }
    });
    const root = startTrace("event-test");
    recordEvent("checkpoint", { iteration: 3 });
    endTrace(root);
    expect(capturedEvents.some((e) => e.name === "checkpoint" && e.attributes?.iteration === 3)).toBe(true);
  });

  it("setSpanAttribute updates the current span attributes", () => {
    const captured: Array<{ name: string; attributes: Record<string, unknown> }> = [];
    configureTracing({
      enabled: true,
      exporter: {
        export(spans) {
          for (const s of spans) captured.push({ name: s.name, attributes: s.attributes });
        }
      }
    });
    const root = startTrace("attr-test");
    withSpan("child", {}, (span) => {
      setSpanAttribute("model", "gemini-2.5-pro");
      setSpanAttribute("iteration", 1);
      // setSpanAttribute mutates the *current* span, which inside withSpan
      // is the newly-created child span. The span parameter passed in
      // is the same object, so we should see the attribute on it.
      expect(span.attributes.model).toBe("gemini-2.5-pro");
      return "done";
    });
    endTrace(root);
    const child = captured.find((s) => s.name === "child");
    expect(child?.attributes.model).toBe("gemini-2.5-pro");
    expect(child?.attributes.iteration).toBe(1);
  });

  it("consoleSpanExporter logs each span", () => {
    // We don't assert log output (vitest captures console). We just verify
    // the exporter is callable and doesn't throw.
    const span = {
      traceId: "trace-1",
      spanId: "span-1",
      name: "test",
      startTime: 0,
      endTime: 10,
      durationMs: 10,
      status: "ok" as const,
      attributes: {},
      events: []
    };
    expect(() => consoleSpanExporter.export([span])).not.toThrow();
  });
});
