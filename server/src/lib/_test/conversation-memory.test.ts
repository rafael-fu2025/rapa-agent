// Tests for idle compaction (Item 13): loadConversationMemory detects a
// stale/missing summary when older turns exist beyond the replay window and
// refreshes it inline (bounded, fail-soft). Matrix:
//   no overflow | fresh summary | missing summary | outdated summary
// plus the self-sourced-credentials fallback used by the chat path.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { encryptText } from "../crypto.js";

vi.mock("../db.js", () => ({
  prisma: {
    conversation: {
      findUnique: vi.fn(),
      update: vi.fn()
    },
    providerSetting: {
      findFirst: vi.fn()
    }
  }
}));

vi.mock("../llm-upstream.js", () => ({
  fetchLlmUpstream: vi.fn()
}));

import { prisma } from "../db.js";
import { fetchLlmUpstream } from "../llm-upstream.js";
import { loadConversationMemory, type MemorySummaryCredentials } from "../conversation-memory.js";

const mockedFindUnique = vi.mocked(prisma.conversation.findUnique);
const mockedUpdate = vi.mocked(prisma.conversation.update);
const mockedProviderFindFirst = vi.mocked(prisma.providerSetting.findFirst);
const mockedFetchLlmUpstream = vi.mocked(fetchLlmUpstream);

const CREDS: MemorySummaryCredentials = { baseUrl: "http://llm.test/v1", apiKey: "sk-test", model: "test-model" };
const REFRESHED_SUMMARY = "idle-refreshed summary";
const OLDEST_OVERFLOW_CREATED_AT = new Date("2026-01-01T00:00:00Z");

/**
 * Messages as Prisma returns them (createdAt desc, newest first). 14
 * short messages guarantee overflow: the replay window keeps at most 12.
 */
function makeConversationRows(count: number) {
  const rows = [];
  for (let i = count; i >= 1; i -= 1) {
    rows.push({
      id: `m${i}`,
      role: i % 2 === 0 ? "assistant" : "user",
      content: `message body ${i} ${"x".repeat(40)}`,
      memoryText: null,
      createdAt: new Date(OLDEST_OVERFLOW_CREATED_AT.getTime() + (i - 1) * 60_000)
    });
  }
  return rows;
}

type ConversationRow = ReturnType<typeof makeConversationRows>[number];

function makeConversation(overrides: {
  memorySummary?: string | null;
  memorySummaryUpdatedAt?: Date | null;
  memorySummaryMessageId?: string | null;
  messageCount?: number;
} = {}) {
  return {
    memorySummary: overrides.memorySummary ?? null,
    memorySummaryUpdatedAt: overrides.memorySummaryUpdatedAt ?? null,
    userId: "user-1",
    messages: makeConversationRows(overrides.messageCount ?? 14)
  };
}

function mockFindUniqueFor(conversation: {
  memorySummary: string | null;
  memorySummaryUpdatedAt: Date | null;
  userId: string;
  messages: ConversationRow[];
  memorySummaryMessageId?: string | null;
}) {
  mockedFindUnique.mockImplementation((async (args: unknown) => {
    const select = (args as { select?: Record<string, unknown> })?.select ?? {};
    if ("memorySummaryMessageId" in select) {
      // refreshConversationSummary's own fetch (full message list)
      return {
        memorySummary: conversation.memorySummary,
        memorySummaryMessageId: conversation.memorySummaryMessageId ?? null,
        messages: conversation.messages
      } as never;
    }
    if ("messages" in select) {
      return conversation as never;
    }
    // Post-refresh re-read
    return { memorySummary: REFRESHED_SUMMARY } as never;
  }) as never);
}

function mockUpstreamSummary(content: string, ok = true) {
  mockedFetchLlmUpstream.mockImplementation(async () =>
    new Response(ok ? JSON.stringify({ choices: [{ message: { content } }] }) : "provider down", {
      status: ok ? 200 : 500
    })
  );
}

beforeEach(() => {
  mockedFindUnique.mockReset();
  mockedUpdate.mockReset();
  mockedProviderFindFirst.mockReset();
  mockedFetchLlmUpstream.mockReset();
  mockedUpdate.mockResolvedValue({ id: "conv-1" } as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadConversationMemory — idle compaction", () => {
  it("does not refresh when everything fits in the replay window", async () => {
    const conversation = makeConversation({ messageCount: 4 });
    mockFindUniqueFor(conversation);
    mockUpstreamSummary(REFRESHED_SUMMARY);

    const memory = await loadConversationMemory("conv-1", CREDS);

    expect(mockedFetchLlmUpstream).not.toHaveBeenCalled();
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(memory.summary).toBeNull();
    expect(memory.recentMessages).toHaveLength(4);
    expect(mockedFindUnique).toHaveBeenCalledTimes(1);
  });

  it("does not refresh when the summary is newer than the oldest overflow turn", async () => {
    const conversation = makeConversation({
      memorySummary: "fresh summary",
      memorySummaryUpdatedAt: new Date("2026-01-05T00:00:00Z")
    });
    mockFindUniqueFor(conversation);
    mockUpstreamSummary(REFRESHED_SUMMARY);

    const memory = await loadConversationMemory("conv-1", CREDS);

    expect(mockedFetchLlmUpstream).not.toHaveBeenCalled();
    expect(memory.summary).toBe("fresh summary");
    expect(memory.recentMessages).toHaveLength(12);
  });

  it("refreshes once when overflow exists and no summary is persisted", async () => {
    const conversation = makeConversation({ memorySummary: null });
    mockFindUniqueFor(conversation);
    mockUpstreamSummary(REFRESHED_SUMMARY);

    const memory = await loadConversationMemory("conv-1", CREDS);

    expect(mockedFetchLlmUpstream).toHaveBeenCalledTimes(1);
    expect(mockedUpdate).toHaveBeenCalledTimes(1);
    expect(mockedUpdate.mock.calls[0]?.[0]).toMatchObject({
      where: { id: "conv-1" },
      data: expect.objectContaining({ memorySummary: REFRESHED_SUMMARY })
    });
    expect(memory.summary).toBe(REFRESHED_SUMMARY);
    // The replay window itself is unchanged by the refresh.
    expect(memory.recentMessages).toHaveLength(12);
  });

  it("refreshes once when the summary predates the oldest overflow turn", async () => {
    const conversation = makeConversation({
      memorySummary: "stale summary",
      memorySummaryUpdatedAt: new Date("2025-12-01T00:00:00Z"),
      memorySummaryMessageId: "m2"
    });
    mockFindUniqueFor(conversation);
    mockUpstreamSummary(REFRESHED_SUMMARY);

    const memory = await loadConversationMemory("conv-1", CREDS);

    expect(mockedFetchLlmUpstream).toHaveBeenCalledTimes(1);
    expect(memory.summary).toBe(REFRESHED_SUMMARY);
  });

  it("falls back silently when the provider call fails", async () => {
    const conversation = makeConversation({ memorySummary: null });
    mockFindUniqueFor(conversation);
    mockUpstreamSummary("", false);

    const memory = await loadConversationMemory("conv-1", CREDS);

    expect(memory.summary).toBeNull();
    expect(memory.recentMessages).toHaveLength(12);
  });

  it("falls back silently when the refresh exceeds the timeout window", async () => {
    const conversation = makeConversation({ memorySummary: null });
    mockFindUniqueFor(conversation);
    mockedFetchLlmUpstream.mockImplementation(
      () => new Promise<Response>(() => {}) // never settles
    );

    const memory = await Promise.race([
      loadConversationMemory("conv-1", CREDS),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("loader hung")), 9000))
    ]);

    expect(memory.summary).toBeNull();
  }, 15000);

  it("self-sources credentials when none are passed (chat path)", async () => {
    vi.stubEnv("APP_SECRET", "a".repeat(64));
    const conversation = makeConversation({ memorySummary: null });
    mockFindUniqueFor(conversation);
    mockUpstreamSummary(REFRESHED_SUMMARY);
    mockedProviderFindFirst.mockResolvedValue({
      id: "ps-1",
      userId: "user-1",
      provider: "openai",
      baseUrl: "http://llm.test/v1",
      models: ["test-model"],
      apiKeys: [
        { apiKeyEncrypted: encryptText("sk-live", "a".repeat(64)) }
      ]
    } as never);

    const memory = await loadConversationMemory("conv-1");

    expect(mockedProviderFindFirst).toHaveBeenCalledTimes(1);
    expect(mockedFetchLlmUpstream).toHaveBeenCalledTimes(1);
    expect(memory.summary).toBe(REFRESHED_SUMMARY);
  });

  it("skips the refresh entirely when no provider credentials can be resolved", async () => {
    const conversation = makeConversation({ memorySummary: null });
    mockFindUniqueFor(conversation);
    mockUpstreamSummary(REFRESHED_SUMMARY);
    mockedProviderFindFirst.mockResolvedValue(null as never);

    const memory = await loadConversationMemory("conv-1");

    expect(mockedFetchLlmUpstream).not.toHaveBeenCalled();
    expect(memory.summary).toBeNull();
    expect(memory.recentMessages).toHaveLength(12);
  });
});
