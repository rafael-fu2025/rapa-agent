// Tests for the Langfuse exporter. Network calls are mocked via vi.stubGlobal.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLangfuseExporter } from "../langfuse-exporter.js";

type SpanFixture = Parameters<ReturnType<typeof createLangfuseExporter>["export"]>[0][number];

function makeSpan(overrides: Partial<SpanFixture> = {}): SpanFixture {
  return {
    traceId: "abc123",
    spanId: "span-aaa",
    name: "test-span",
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_000_100,
    durationMs: 100,
    status: "ok",
    attributes: { model: "gemini-2.5-pro" },
    events: [],
    ...overrides
  };
}

describe("createLangfuseExporter", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("") });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ships a single span to the configured endpoint with basic auth", async () => {
    const exporter = createLangfuseExporter({
      publicKey: "pk-test",
      secretKey: "sk-test",
      baseUrl: "https://langfuse.example.com/",
      environment: "test"
    });
    exporter.export([makeSpan()]);
    await exporter.shutdown?.();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://langfuse.example.com/api/public/otel/v1/traces");
    expect(init.method).toBe("POST");
    const expectedAuth = Buffer.from("pk-test:sk-test").toString("base64");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${expectedAuth}`);
    const body = JSON.parse(init.body as string);
    expect(body.resourceSpans[0].scopeSpans[0].spans[0].name).toBe("test-span");
  });

  it("trims trailing slashes from baseUrl", async () => {
    const exporter = createLangfuseExporter({
      publicKey: "pk",
      secretKey: "sk",
      baseUrl: "https://langfuse.example.com///"
    });
    exporter.export([makeSpan()]);
    await exporter.shutdown?.();
    const url = (fetchMock.mock.calls[0] as [string, unknown])[0];
    expect(url).toBe("https://langfuse.example.com/api/public/otel/v1/traces");
  });

  it("does not throw when fetch rejects — fails soft", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const exporter = createLangfuseExporter({ publicKey: "pk", secretKey: "sk" });
    exporter.export([makeSpan()]);
    await expect(exporter.shutdown?.()).resolves.toBeUndefined();
  });

  it("does not throw when the server returns a non-2xx response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve("unauthorized") });
    const exporter = createLangfuseExporter({ publicKey: "bad", secretKey: "bad" });
    exporter.export([makeSpan()]);
    await expect(exporter.shutdown?.()).resolves.toBeUndefined();
  });

  it("pads short traceId/spanId to OTLP-required lengths", async () => {
    const exporter = createLangfuseExporter({ publicKey: "pk", secretKey: "sk" });
    exporter.export([makeSpan({ traceId: "short", spanId: "s1" })]);
    await exporter.shutdown?.();
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    const otelSpan = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(otelSpan.traceId).toHaveLength(32);
    expect(otelSpan.spanId).toHaveLength(16);
  });

  it("includes the deployment.environment attribute on the scope", async () => {
    const exporter = createLangfuseExporter({
      publicKey: "pk",
      secretKey: "sk",
      environment: "staging"
    });
    exporter.export([makeSpan()]);
    await exporter.shutdown?.();
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    const scope = body.resourceSpans[0].scopeSpans[0];
    expect(scope.attributes[0]).toEqual({ key: "deployment.environment", value: { stringValue: "staging" } });
  });

  it("shutdown stops further exports", async () => {
    const exporter = createLangfuseExporter({ publicKey: "pk", secretKey: "sk" });
    await exporter.shutdown?.();
    exporter.export([makeSpan()]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
