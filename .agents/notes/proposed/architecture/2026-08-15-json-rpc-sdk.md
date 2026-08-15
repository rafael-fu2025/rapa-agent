# JSON-RPC SDK for external clients

Status: proposed
Date: 2026-08-15
Scope: architecture

## Context

Recreate UI today exposes two surfaces:

- **REST + SSE** for the browser frontend.
- **(no SDK)** for external automation — IDE plugins, scripts,
  CI jobs.

An external automation user (e.g., "use Recreate UI from a Neovim
plugin") has no first-class API. They'd have to spin up the
Fastify server and consume SSE — coupled, fragile, no schema.

dsh's answer is a JSON-RPC SDK (`packages/sdk/`) with a typed
schema, WebSocket transport, and a TS client. JSON-RPC is the
right shape because:

- One bidirectional connection for events and requests.
- Schema-typed (dsh uses Typert-generated types).
- Language-portable (any language can implement the JSON-RPC
  surface).

## Proposed shape

- `JsonRpcServer` — wraps the Fastify WebSocket endpoint,
  implements the JSON-RPC 2.0 envelope.
- `JsonRpcClient` — a TS client that exposes `agent.stream(...)`
  with typed request/response.
- Schema: `agent/invoke`, `agent/cancel`, `agent/list-tools`,
  `agent/get-run`, `events/subscribe`.

This ADR is **proposed**. The actual implementation requires:

1. Choosing the schema source (Typert or hand-written Zod).
2. WebSocket route on the existing Fastify server.
3. Client SDK that wraps the schema.

## Consequences (when implemented)

**Easier:**

- External IDE / editor plugins can drive the agent natively.
- CI / batch workflows can invoke runs over RPC.
- The protocol is testable in isolation (no Fastify needed for
  unit tests).

**Harder:**

- JSON-RPC adds a second transport to maintain alongside REST.
- Schema versioning becomes a real concern.

## Alternatives considered

- **gRPC.** Rejected: harder to consume from browsers; dsh picked
  JSON-RPC for browser-friendliness.
- **Plain WebSocket without JSON-RPC.** Rejected: schema-less
  WebSocket drifts; JSON-RPC gives us request IDs and errors for
  free.
- **REST only.** Rejected: REST is request/response, not
  streaming; SSE alone forces clients to manage reconnect state.