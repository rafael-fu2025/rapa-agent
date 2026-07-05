// Langfuse exporter for the agent tracing system.
//
// We use Langfuse's OTLP/HTTP ingestion endpoint (recommended since 2025) so
// the exporter doesn't depend on the Langfuse Node SDK and works with any
// OpenTelemetry-compatible backend (e.g. self-hosted Langfuse, Grafana
// Tempo, Honeycomb).
//
// The exporter is fail-soft: any network or auth error is logged to stderr
// but never propagates, so a broken observability backend can never crash
// the agent.

import { randomUUID } from "node:crypto";
import type { Span, SpanExporter } from "./tracing.js";

export type LangfuseExporterOptions = {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
  environment?: string;
  flushIntervalMs?: number;
};

const DEFAULT_BASE_URL = "https://cloud.langfuse.com";
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const MAX_BATCH_SIZE = 100;

type OtelAttributeValue =
  | { stringValue: string }
  | { intValue: string }
  | { boolValue: boolean };

type OtelSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 1;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: OtelAttributeValue }>;
  status: { code: 1 | 2; message: string };
};

function resolveOtelEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return `${trimmed}/api/public/otel/v1/traces`;
}

function otelAttributeValue(value: unknown): OtelAttributeValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number" && Number.isFinite(value)) {
    return { intValue: String(Math.trunc(value)) };
  }
  if (typeof value === "boolean") return { boolValue: value };
  return { stringValue: JSON.stringify(value) };
}

/**
 * Map a provider identifier to the OTel GenAI `gen_ai.system` enum value
 * (https://opentelemetry.io/docs/specs/semconv/gen-ai/). Unknown providers
 * pass through verbatim so proprietary systems still get useful attributes.
 */
function mapGenAiSystem(provider: string | undefined): string | undefined {
  if (!provider) return undefined;
  const normalized = provider.toLowerCase();
  if (normalized.includes("openai") || normalized === "gpt") return "openai";
  if (normalized.includes("anthropic") || normalized.includes("claude")) return "anthropic";
  if (normalized.includes("gemini") || normalized.includes("google") || normalized.includes("vertex")) return "vertex_ai";
  if (normalized.includes("cohere")) return "cohere";
  if (normalized.includes("mistral")) return "mistral_ai";
  if (normalized.includes("deepseek")) return "deepseek";
  if (normalized.includes("groq")) return "groq";
  if (normalized.includes("ollama")) return "ollama";
  if (normalized.includes("azure")) return "azure_openai";
  if (normalized.includes("bedrock")) return "aws_bedrock";
  if (normalized.includes("nvidia") || normalized.includes("nim")) return "nvidia";
  if (normalized.includes("puter")) return "puter";
  if (normalized.includes("openrouter")) return "openrouter";
  return provider;
}

/**
 * Translate the agent's own span attribute names into the OTel GenAI
 * semantic convention namespace. Unknown keys are passed through unchanged
 * so we don't lose information.
 */
const GENAI_KEY_MAP: Record<string, string> = {
  provider: "gen_ai.system",
  model: "gen_ai.request.model",
  responseModel: "gen_ai.response.model",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  totalTokens: "gen_ai.usage.total_tokens",
  cachedTokens: "gen_ai.usage.cached_tokens",
  cacheReadTokens: "gen_ai.usage.cached_read_tokens",
  cacheWriteTokens: "gen_ai.usage.cached_write_tokens",
  reasoningTokens: "gen_ai.usage.reasoning_tokens",
  temperature: "gen_ai.request.temperature",
  topP: "gen_ai.request.top_p",
  topK: "gen_ai.request.top_k",
  maxTokens: "gen_ai.request.max_tokens",
  frequencyPenalty: "gen_ai.request.frequency_penalty",
  presencePenalty: "gen_ai.request.presence_penalty",
  stopSequences: "gen_ai.request.stop_sequences",
  finishReason: "gen_ai.response.finish_reasons",
  agentName: "gen_ai.agent.name",
  agentMode: "gen_ai.agent.mode",
  conversationId: "gen_ai.conversation.id",
  userId: "gen_ai.user.id",
  toolName: "gen_ai.tool.name",
  toolCallId: "gen_ai.tool.call.id",
  toolResult: "gen_ai.tool.result",
  promptTokens: "gen_ai.usage.input_tokens",
  completionTokens: "gen_ai.usage.output_tokens"
};

function translateGenAiAttributes(
  attrs: Record<string, string | number | boolean | undefined>
): Array<{ key: string; value: OtelAttributeValue }> {
  const out: Array<{ key: string; value: OtelAttributeValue }> = [];
  for (const [rawKey, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    let key = GENAI_KEY_MAP[rawKey] ?? rawKey;
    if (key === "gen_ai.system" && typeof value === "string") {
      const mapped = mapGenAiSystem(value);
      if (mapped) key = "gen_ai.system";
      out.push({ key, value: otelAttributeValue(mapped ?? value) });
      continue;
    }
    // Comma-split finish reasons into an array per spec.
    if (key === "gen_ai.response.finish_reasons" && typeof value === "string") {
      out.push({ key, value: { stringValue: value } });
      continue;
    }
    out.push({ key, value: otelAttributeValue(value) });
  }
  return out;
}

function toOtelSpan(span: Span): OtelSpan {
  const startMs = span.startTime ?? Date.now();
  const endMs = span.endTime ?? startMs;
  return {
    traceId: span.traceId.padStart(32, "0"),
    spanId: span.spanId.padStart(16, "0"),
    parentSpanId: span.parentSpanId ? span.parentSpanId.padStart(16, "0") : undefined,
    name: span.name,
    kind: 1, // INTERNAL
    startTimeUnixNano: String(BigInt(Math.max(0, startMs)) * 1_000_000n),
    endTimeUnixNano: String(BigInt(Math.max(0, endMs)) * 1_000_000n),
    attributes: translateGenAiAttributes(span.attributes ?? {}),
    status: {
      code: span.status === "error" ? 2 : 1,
      message: ""
    }
  };
}

/**
 * Build a SpanExporter that ships finished spans to Langfuse over OTLP/HTTP.
 * Spans are buffered in-memory and flushed on an interval so we don't issue
 * a request per span.
 */
export function createLangfuseExporter(options: LangfuseExporterOptions): SpanExporter {
  const endpoint = resolveOtelEndpoint(options.baseUrl ?? DEFAULT_BASE_URL);
  const environment = options.environment ?? "production";
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const auth = Buffer.from(`${options.publicKey}:${options.secretKey}`).toString("base64");

  const buffer: Span[] = [];
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let closed = false;

  function scheduleFlush() {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, flushIntervalMs);
  }

  async function flush(): Promise<void> {
    if (buffer.length === 0) return;
    if (inFlight) {
      // Coalesce — a flush is already in progress; new spans will be picked
      // up by the next scheduled flush.
      return;
    }
    const batch = buffer.splice(0, buffer.length);
    inFlight = send(batch).finally(() => {
      inFlight = null;
      if (buffer.length > 0) scheduleFlush();
    });
    await inFlight;
  }

  async function send(batch: Span[]): Promise<void> {
    if (batch.length === 0) return;
    const scopes = [
      {
        scope: { name: "rapa.agent", version: "0.1.0" },
        spans: batch.map(toOtelSpan),
        attributes: [
          { key: "deployment.environment", value: { stringValue: environment } }
        ]
      }
    ];
    const body = JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "rapa-agent" } },
              { key: "service.version", value: { stringValue: "0.1.0" } },
              { key: "telemetry.sdk.language", value: { stringValue: "nodejs" } },
              { key: "telemetry.sdk.name", value: { stringValue: "rapa.agent" } }
            ]
          },
          scopeSpans: scopes
        }
      ]
    });
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${auth}`
        },
        body
      });
      if (!res.ok) {
        // Don't retry — fail soft and log. Spans are best-effort.
        const text = await res.text().catch(() => "");
        // eslint-disable-next-line no-console
        console.warn(`[langfuse-exporter] non-2xx response (${res.status}): ${text.slice(0, 200)}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[langfuse-exporter] failed to send spans:`, (err as Error).message);
    }
  }

  const exporter: SpanExporter = {
    export(spans: Span[]): void {
      if (closed) return;
      for (const span of spans) buffer.push(span);
      if (buffer.length >= MAX_BATCH_SIZE) {
        void flush();
      } else {
        scheduleFlush();
      }
    },
    async shutdown(): Promise<void> {
      closed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      await flush();
    }
  };

  return exporter;
}

export function generateSpanId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}
