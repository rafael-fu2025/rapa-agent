/**
 * ReplayLLMClient — a deterministic replacement for `LLMClient` that
 * emits the fixture's recorded model responses in order, never
 * touching the network.
 *
 * Emits the canonical `LLMStreamEvent` shape:
 *   `{ type: "chunk"; reasoningDelta?: string; contentDelta?: string }`
 * and returns an `AgentMessage` as the async-generator return value.
 *
 * See `.agents/notes/implemented/testing/2026-08-15-snapshot-harness-for-agent-loop.md`.
 */

import type {
  AgentMessage,
  AgentTokenUsage,
  ProviderChatMessage
} from "../types.js";
import type { SnapshotFixture } from "./types.js";

/** Mirrors `LLMStreamEvent` in `../llm-client.ts`. */
export type LLMStreamEvent = {
  type: "chunk";
  reasoningDelta?: string;
  contentDelta?: string;
};

export interface ReplayLLMClientOptions {
  fixture: SnapshotFixture;
}

interface QueueItem {
  reasoning?: string;
  content?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

/**
 * Build a queue of model responses — one per `step` event in the
 * fixture (i.e. one per agent iteration). Each item is enriched by
 * the immediately-preceding `thinking` event's reasoning and the
 * matching `assistant` event's content, plus any `tool_call` events
 * that fall within that step.
 */
export class ReplayLLMClient {
  private queue: QueueItem[];
  private cursor = 0;

  constructor(options: ReplayLLMClientOptions) {
    this.queue = this.buildQueue(options.fixture);
  }

  private buildQueue(fixture: SnapshotFixture): QueueItem[] {
    const steps = fixture.events.filter((e) => e.type === "step");
    const items: QueueItem[] = steps.map(() => ({}));

    let stepIdx = -1;
    for (const ev of fixture.events) {
      if (ev.type === "step") {
        stepIdx += 1;
        continue;
      }
      if (stepIdx < 0) continue;
      const target = items[stepIdx];
      if (!target) continue;

      if (ev.type === "thinking" && !target.reasoning) {
        target.reasoning = ev.reasoning ?? "";
        continue;
      }
      if (ev.type === "assistant" && !target.content && !ev.interactive) {
        target.content = ev.content;
        continue;
      }
      if (ev.type === "tool_call" && ev.call && !target.toolCalls) {
        target.toolCalls = [{
          id: ev.call.id,
          name: ev.call.name,
          arguments: JSON.stringify(ev.call.parameters ?? {})
        }];
      }
    }

    return items;
  }

  /**
   * Drop-in replacement for `LLMClient.streamChat`.
   * Emits one or more `chunk` events per call; returns the assembled
   * `AgentMessage`.
   */
  async *streamChat(
    _messages: ProviderChatMessage[],
    _timeoutMs: number,
    _openAITools: unknown
  ): AsyncGenerator<LLMStreamEvent, AgentMessage, unknown> {
    if (this.cursor >= this.queue.length) {
      // Safety net: queue exhausted. Yield an empty chunk so the
      // agent receives a well-formed message with no content/tool calls.
      const message: AgentMessage = { role: "assistant", content: "" };
      yield { type: "chunk" };
      return message;
    }

    const item = this.queue[this.cursor];
    this.cursor += 1;

    if (item.reasoning) {
      yield { type: "chunk", reasoningDelta: item.reasoning };
    }
    if (item.content) {
      yield { type: "chunk", contentDelta: item.content };
    }
    if (item.toolCalls && item.toolCalls.length > 0) {
      // Encode tool calls inside a content delta as JSON so the
      // existing `response-parser` extracts them. Matches the format
      // dsh-style agents conventionally use.
      const toolCallsJson = JSON.stringify({
        toolCalls: item.toolCalls.map((c) => ({
          id: c.id,
          name: c.name,
          parameters: safeJsonParse(c.arguments)
        }))
      });
      yield { type: "chunk", contentDelta: toolCallsJson };
    }

    const message: AgentMessage = {
      role: "assistant",
      content: item.content ?? "",
      toolCalls: item.toolCalls?.map((c) => ({
        id: c.id,
        name: c.name,
        parameters: safeJsonParse(c.arguments)
      }))
    };
    return message;
  }

  /** Test helper: how many responses remain. */
  remaining(): number {
    return Math.max(0, this.queue.length - this.cursor);
  }
}

function safeJsonParse(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// Suppress unused-type warning for AgentTokenUsage (kept for shape parity).
export type _ = AgentTokenUsage;