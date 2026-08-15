/**
 * JSON-RPC SDK — SKELETON.
 *
 * See `.agents/notes/proposed/architecture/2026-08-15-json-rpc-sdk.md`
 * (status: proposed). The runtime — WebSocket transport, schema
 * generation, client SDK — is not yet implemented.
 *
 * The intent: a JSON-RPC 2.0 surface for external automation
 * (IDE plugins, CI, scripts) that exposes `agent/invoke`,
 * `agent/cancel`, `agent/list-tools`, and event subscription.
 */

/**
 * JSON-RPC 2.0 envelope (subset used by the proposed SDK).
 */
export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: TParams;
}

export interface JsonRpcResponse<TResult = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  result?: TResult;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification<TParams = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: TParams;
}

/**
 * Schema for the proposed methods. The next contributor will
 * either hand-write this in Zod or generate it via Typert (see
 * dsh's `packages/typert/`).
 */
export interface JsonRpcSchema {
  "agent/invoke": {
    params: {
      conversationId: string;
      prompt: string;
      mode?: "chat" | "plan" | "agent";
    };
    result: { runId: string };
  };
  "agent/cancel": {
    params: { runId: string };
    result: { cancelled: boolean };
  };
  "agent/list-tools": {
    params: Record<string, never>;
    result: { name: string; description: string; riskLevel: string }[];
  };
  "agent/get-run": {
    params: { runId: string };
    result: { status: string; steps: unknown[] };
  };
  "events/subscribe": {
    params: { runId: string };
    result: { subscribed: true };
    notifications: { event: string; payload: unknown };
  };
}

/**
 * `JsonRpcServer` — SKELETON.
 *
 * The real implementation will:
 * 1. Mount a WebSocket route on the existing Fastify server.
 * 2. Decode JSON-RPC envelopes from incoming frames.
 * 3. Route each `method` to a handler in `JsonRpcSchema`.
 * 4. Encode responses and notifications back to the client.
 */
export class JsonRpcServer {
  constructor(/* schema: JsonRpcSchema, dispatcher: Dispatcher */) {
    throw new Error(
      "JsonRpcServer is not yet implemented. " +
      "See `.agents/notes/proposed/architecture/2026-08-15-json-rpc-sdk.md`."
    );
  }

  async handle(_frame: JsonRpcRequest): Promise<JsonRpcResponse> {
    throw new Error("not implemented");
  }
}

/**
 * `JsonRpcClient` — SKELETON.
 *
 * The real implementation will:
 * 1. Open a WebSocket to the SDK endpoint.
 * 2. Provide typed methods for each entry in `JsonRpcSchema`.
 * 3. Surface server-pushed notifications via an `on(event, fn)`
 *    listener API.
 */
export class JsonRpcClient {
  constructor(/* url: string */) {
    throw new Error(
      "JsonRpcClient is not yet implemented. " +
      "See `.agents/notes/proposed/architecture/2026-08-15-json-rpc-sdk.md`."
    );
  }

  async invoke(_params: JsonRpcSchema["agent/invoke"]["params"]): Promise<JsonRpcSchema["agent/invoke"]["result"]> {
    throw new Error("not implemented");
  }
}