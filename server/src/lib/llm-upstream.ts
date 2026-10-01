// ---------------------------------------------------------------------------
// Shared upstream LLM transport.
//
// Every LLM call in the server funnels through `fetchLlmUpstream`. For all
// providers except Puter this is a plain `fetch` against the configured
// OpenAI-compatible base URL.
//
// Puter is special. Its vendor-compatible wire surface
// (`/puterai/openai/v1/*`) is a PAID feature — the Puter backend answers
// HTTP 402 `subscription_required` for free accounts there *by design*
// (the route is registered with `requireSubscription: true`, per Puter's
// PuterAIController: "an account on a free plan reaches the same models
// through `/drivers/call` (and puter.js) without it"). Free accounts pay
// with AI credits on the "user pays" model via the drivers dispatch:
//
//   POST {origin}/drivers/call
//   Content-Type: text/plain;actually=json
//   {
//     "interface": "puter-chat-completion",
//     "driver": "ai-chat",
//     "method": "complete",
//     "args": { "model": "...", "messages": [...], "tools": [...], "stream": true },
//     "auth_token": "<puter token>"
//   }
//
//   non-streaming → 200 application/json  { success, result: { message, finish_reason, usage } }
//   streaming     → 200 application/x-ndjson, one JSON object per line:
//                     {"type":"text","text":"..."}
//                     {"type":"reasoning","text":"..."}
//                     {"type":"tool_use","id":"...","name":"...","input":{...}}
//                     {"type":"usage","usage":{...}}
//
// This module translates both directions so every downstream consumer
// (routes/chat.ts SSE relay, lib/agent/llm-client.ts stream parser,
// non-streaming helpers) keeps speaking OpenAI shape unchanged.
// ---------------------------------------------------------------------------

const PUTER_CALL_CONTENT_TYPE = "text/plain;actually=json";
const PUTER_CHAT_INTERFACE = "puter-chat-completion";
const PUTER_CHAT_DRIVER = "ai-chat";

// Args Puter's ai-chat driver understands. Everything else in an
// OpenAI-shaped request body (notably `stream_options`) is dropped rather
// than forwarded, so unknown OpenAI fields can't trip the dispatch.
const PUTER_ARG_KEYS = [
  "model",
  "messages",
  "tools",
  "tool_choice",
  "temperature",
  "top_p",
  "max_tokens",
  "reasoning_effort"
] as const;

function isPuterHost(hostname: string): boolean {
  return hostname === "api.puter.com" || hostname.endsWith(".puter.com");
}

export function resolveLlmTransport(provider: string | undefined, baseUrl: string): "puter" | "openai" {
  if (provider) return provider === "puter" ? "puter" : "openai";
  try {
    return isPuterHost(new URL(baseUrl).hostname) ? "puter" : "openai";
  } catch {
    return "openai";
  }
}

// Loopback/private/reserved targets are refused for the Puter dispatch: the
// auth token would be sent there. Ordinary provider base URLs are unaffected.
function assertPublicHttpsHost(hostname: string): void {
  const blocked =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname === "::1" ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    /^169\.254\./.test(hostname) ||
    /^0\./.test(hostname);
  if (blocked) {
    throw new Error(`Refusing to send Puter credentials to a non-public host: ${hostname}`);
  }
}

function puterDriversUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:") {
    throw new Error(`Puter base URL must use https (got ${parsed.protocol})`);
  }
  assertPublicHttpsHost(parsed.hostname);
  return `${parsed.origin}/drivers/call`;
}

function extractBearerToken(init: RequestInit): string {
  const headers = (init.headers ?? {}) as Record<string, string>;
  const auth = headers.Authorization ?? headers.authorization ?? "";
  return auth.replace(/^Bearer\s+/i, "").trim();
}

function buildPuterCallBody(openaiBody: Record<string, unknown>, authToken: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const key of PUTER_ARG_KEYS) {
    if (openaiBody[key] !== undefined && openaiBody[key] !== null) {
      args[key] = openaiBody[key];
    }
  }
  args.stream = openaiBody.stream === true;
  return {
    interface: PUTER_CHAT_INTERFACE,
    driver: PUTER_CHAT_DRIVER,
    method: "complete",
    args,
    auth_token: authToken
  };
}

type PuterCompleteResult = {
  message?: {
    content?: string | Array<{ type?: string; text?: string }>;
    reasoning?: string;
    tool_calls?: unknown[];
    role?: string;
  };
  finish_reason?: string;
  usage?: Record<string, unknown>;
};

function flattenPuterContent(content: PuterCompleteResult["message"]): string {
  const raw = content?.content;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw.map((block) => (typeof block?.text === "string" ? block.text : "")).join("");
  }
  return "";
}

function puterResultToOpenAICompletion(result: PuterCompleteResult): Record<string, unknown> {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: flattenPuterContent(result.message)
  };
  // Extended-thinking output on normalized responses arrives as
  // `message.reasoning`; surface it under the DeepSeek-convention field the
  // stream parsers already understand.
  if (typeof result.message?.reasoning === "string" && result.message.reasoning) {
    message.reasoning_content = result.message.reasoning;
  }
  if (Array.isArray(result.message?.tool_calls) && result.message.tool_calls.length > 0) {
    message.tool_calls = result.message.tool_calls;
  }
  return {
    id: `chatcmpl-puter-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    choices: [{ index: 0, message, finish_reason: result.finish_reason ?? "stop" }],
    usage: result.usage
  };
}

// Convert Puter's NDJSON chunk stream into standard OpenAI `data:` SSE so the
// existing SSE relays and stream parsers need no per-provider branches.
function puterNdjsonToSse(upstreamBody: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const chunkId = `chatcmpl-puter-${Date.now()}`;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstreamBody.getReader();
      let buffer = "";
      let toolCallIndex = 0;

      const emitDelta = (delta: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({
            id: chunkId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            choices: [{ index: 0, delta }]
          })}\n\n`
        ));
      };

      const handleLine = (line: string) => {
        let parsed: {
          type?: string;
          text?: string;
          reasoning?: string;
          id?: string;
          name?: string;
          input?: unknown;
          usage?: Record<string, unknown>;
          message?: string;
        };
        try {
          parsed = JSON.parse(line);
        } catch {
          return; // partial/garbage line — ignore
        }

        switch (parsed.type) {
          case "text":
            if (typeof parsed.text === "string" && parsed.text) {
              emitDelta({ content: parsed.text });
            }
            break;
          case "reasoning": {
            // Reasoning chunks carry their text in `reasoning` (verified
            // live against qwen3-*-thinking via the ai-chat dispatch);
            // fall back to `text` in case a vendor uses it.
            const reasoningDelta = (typeof parsed.reasoning === "string" && parsed.reasoning)
              ? parsed.reasoning
              : (typeof parsed.text === "string" ? parsed.text : "");
            if (reasoningDelta) {
              emitDelta({ reasoning_content: reasoningDelta });
            }
            break;
          }
          case "tool_use":
            if (typeof parsed.name === "string" && parsed.name) {
              emitDelta({
                tool_calls: [{
                  index: toolCallIndex,
                  id: parsed.id,
                  type: "function",
                  function: {
                    name: parsed.name,
                    arguments: typeof parsed.input === "string" ? parsed.input : JSON.stringify(parsed.input ?? {})
                  }
                }]
              });
              toolCallIndex += 1;
            }
            break;
          case "usage":
            // Terminal usage chunk: OpenAI convention is an empty-choices
            // chunk carrying top-level `usage`.
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({
                id: chunkId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                choices: [],
                usage: parsed.usage
              })}\n\n`
            ));
            break;
          case "error":
            console.warn(`[Puter] stream error chunk: ${parsed.message ?? line.slice(0, 300)}`);
            break;
          default:
            break; // unknown chunk types are ignored
        }
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let lineEnd = buffer.indexOf("\n");
          while (lineEnd !== -1) {
            const line = buffer.slice(0, lineEnd).trim();
            buffer = buffer.slice(lineEnd + 1);
            if (line) handleLine(line);
            lineEnd = buffer.indexOf("\n");
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    }
  });
}

async function fetchPuterUpstream(url: string, init: RequestInit): Promise<Response> {
  const authToken = extractBearerToken(init);
  if (!authToken) {
    throw new Error("Puter provider requires an access token (Settings → Puter → save key)");
  }

  const rawBody = typeof init.body === "string" ? init.body : "";
  let openaiBody: Record<string, unknown>;
  try {
    openaiBody = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new Error("Puter transport expects a JSON string request body");
  }

  const callBody = buildPuterCallBody(openaiBody, authToken) as {
    args: Record<string, unknown>;
  };
  const response = await fetch(puterDriversUrl(url), {
    method: "POST",
    headers: { "Content-Type": PUTER_CALL_CONTENT_TYPE },
    body: JSON.stringify(callBody),
    signal: init.signal
  });

  if (!response.ok) {
    // Pass provider errors through untouched — callers already parse the
    // {error: {message, code}} envelope for their user-facing messages.
    return response;
  }

  if (callBody.args.stream === true) {
    if (!response.body) {
      throw new Error("No stream body from Puter");
    }
    return new Response(puterNdjsonToSse(response.body), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    });
  }

  const data = await response.json() as { result?: PuterCompleteResult };
  return Response.json(puterResultToOpenAICompletion(data.result ?? {}));
}

// Single entry point for every upstream LLM call. Non-Puter providers get a
// verbatim fetch; Puter gets the drivers-dispatch translation described above.
export async function fetchLlmUpstream(provider: string | undefined, url: string, init: RequestInit): Promise<Response> {
  if (resolveLlmTransport(provider, url) === "puter") {
    return fetchPuterUpstream(url, init);
  }
  return fetch(url, init);
}

// Puter account validation for the Settings "test key" flow. Puter has no
// `{base}/models` endpoint on the dispatch surface — the catalog
// (`GET /puterai/chat/models`) is public and validates nothing, so the token
// is checked against `GET /whoami`, which requires auth.
export function puterKeyTestUrl(baseUrl: string): string {
  return `${new URL(baseUrl).origin}/whoami`;
}
