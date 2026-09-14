# RecreateUI / Rapa — In-Depth Project Analysis

**Analysis date:** 25 August 2026  
**Scope:** Repository structure, frontend and backend architecture, agent execution model, data persistence, security boundaries, integrations, test/build posture, dependency risk, documentation quality, and current working-tree changes.  
**Method:** Static source review, repository inventory, local runtime probes, quality-gate execution, dependency audit, and inspection of the current uncommitted diff. No source files were modified as part of this analysis.

## Executive assessment

Rapa is an ambitious and unusually complete self-hosted AI-agent product rather than a thin chat wrapper. It combines a React/Vite interface, a Fastify API, Prisma persistence, OpenAI-compatible provider support, a multi-iteration agent loop, workspace-scoped file operations, shell execution, Git, web access, browser automation, scheduling, notifications, documents/media, sub-agents, and MCP connectivity. The design is cohesive enough to support a serious personal-machine coding assistant, and the repository demonstrates strong awareness of agent-specific failure modes such as duplicate submissions, context growth, stalled providers, stale runs, command risk, prompt injection, and partial persistence.

The project’s main limitation is not feature ambition or basic correctness; it is **trust-boundary hardening and operational maturity**. The platform deliberately grants an agent access to local files, processes, browsers, external URLs, API keys, and third-party MCP servers. Several defensive layers exist, but they are predominantly heuristic, configuration-based, or dependent on the operator’s discipline. The code is therefore appropriate for a controlled personal-machine deployment with a loopback bind and trusted workspaces, but it should not yet be treated as a hardened multi-user or internet-facing service without additional isolation, authorization redesign, dependency updates, and integration testing.

| Dimension | Assessment | Rationale |
|---|---:|---|
| Product scope | **Excellent** | Three interaction modes and 58 registered native tools cover a broad assistant/IDE workflow. [1] [24] |
| Architecture | **Strong** | Clear frontend/backend separation, typed tool abstraction, Prisma persistence, SSE streaming, and dedicated agent modules. [2] [5] [9] |
| Agent reliability | **Strong with edge-case risk** | Run limits, retries, compaction, checkpoints, resumability, abort controls, and stream reconnect handling are present. [9] [19] [21] |
| Security posture | **Moderate for local use; insufficient for hostile multi-user use** | Workspace checks, sanitized child environments, approvals, and injection detection are valuable, but browser/MCP/network surfaces remain broad. [11] [12] [13] [14] [15] |
| Test and build discipline | **Strong** | The local frontend suite passed 66 tests and the documented backend suite reports 571 tests; production builds completed successfully. Coverage exists but is not a substitute for end-to-end adversarial testing. [1] [3] [4] |
| Documentation accuracy | **Mixed** | README is current and detailed, while CONTRIBUTING.md still reports an outdated test count and the working tree contains active feature changes. [1] [23] |
| Release readiness | **Conditional** | Good for a trusted local beta; not ready for a security-sensitive hosted deployment without the P0/P1 remediation plan below. |

> **Bottom line:** The repository is a credible, well-engineered local-first agent platform with a strong foundation. The next phase should prioritize reducing trust in heuristics, isolating execution, aligning authentication/data ownership with the advertised deployment modes, and making dependency/security gates release-blocking.

## 1. Product and system shape

The documented product is a local-first AI agent platform with one UI and three modes: Chat for direct provider conversation, Agent for autonomous tool use, and Plan for read-only analysis. The workspace is the central security and UX boundary: conversations can be associated with a selected directory, and the agent is expected to operate inside that directory while using tools for files, shell commands, web research, Git, browser automation, and external integrations. [1]

The backend is organized around a Fastify application that registers authentication, settings, conversations, chat, workspace, agent, terminal, service-key, MCP, and agent-control routes. The server initializes Prisma, environment validation, tracing, rate limiting, compression, WebSocket support, static-file serving, the native tool registry, and the scheduler. [5] This is a sensible composition root, although it currently owns a large amount of cross-cutting behavior and process-global lifecycle state.

The native tool catalog contains exactly **58 registration calls**, matching the README’s headline count. [24] The catalog is broad enough that the product behaves more like an IDE-oriented operating environment than a chat application. That breadth is a major product advantage, but it also multiplies the number of security policies, timeout policies, schemas, audit requirements, and failure modes that must stay synchronized.

## 2. Architecture analysis

### 2.1 Frontend architecture

The frontend uses React 18, Vite, TypeScript, Tailwind CSS, Radix-based UI primitives, and React Router. The route composition concentrates much of the application orchestration in `src/app/routes.tsx`, while the dedicated `use-chat-stream.ts` hook owns the most important live-run state: pending status, abort controllers, reconnection replacement semantics, duplicate-submit protection, agent event projection, approval actions, regeneration, forking, resume behavior, and workspace-tree refreshes. [2] [18] [19]

This is a pragmatic architecture for a feature-rich single-page application. The hook shows thoughtful handling of React-specific concurrency problems: a module-level submit lock supplements React state, a ref-based streaming flag prevents stale closure issues, and reconnects replace rather than append partial assistant text to avoid duplicated output. The code also aborts active streams when the owning component unmounts, which prevents background requests from continuing to call setters after navigation. [19]

The principal maintainability risk is **state concentration**. The same hook coordinates transport, URL history, message projection, provider/model selection, approval state, agent-run metadata, and file-tree refresh events. As new modes and integrations are added, this can become a high-coupling “application controller.” A future refactor should separate transport adapters, run-state reduction, message persistence projection, and UI commands behind smaller interfaces, ideally with a reducer or event-store-like state machine for agent events.

### 2.2 Backend and agent architecture

The backend has a strong conceptual decomposition. The central agent loop delegates to dedicated modules for prompt construction, tool orchestration, LLM transport, response parsing, retries, timeouts, capabilities, tracing, memory, sub-agents, run persistence, and lifecycle observation. The tool registry provides a typed abstraction with parameter validation, category filtering, approval metadata, risk levels, and mode-specific exposure. [2] [9] [10] [24]

The agent loop’s design is especially good in four areas. First, it distinguishes read-only work from writes and can batch read-only operations while serializing mutations. Second, it persists a stable `AgentRun` at run start, allowing live pause/abort/redirect controls to address a known record. Third, it persists the run header and assistant message atomically, then stores steps and tool records in separate transactions so a late history-write failure does not erase the whole run. Fourth, it incorporates limits and verification rather than assuming that a tool-free model response means the task is complete. [9] [17] [21]

The resulting architecture is robust for a single Node process. However, several important mechanisms are process-local: exit-hatch state, terminal sessions, browser pages, MCP connections, profile caches, and scheduler execution. This is compatible with the documented personal-machine deployment, but it is a direct constraint on horizontal scaling, process restarts, and multi-instance hosting. A hosted deployment would need shared run-control state, a queue/worker model, distributed locks, and a clear ownership strategy for browser and terminal sessions.

### 2.3 Streaming and persistence model

Chat and agent interactions use SSE for browser-facing streams, with WebSocket used for terminal PTY behavior. The chat route delays creation of a new conversation until the provider accepts the request, avoiding orphaned sidebar records after upstream failures. It also uses keepalive pings, client-disconnect cancellation, an idle read timeout, usage normalization, and asynchronous title/summary refresh. [1] [19]

This is a strong operational design, but it has a subtle durability tradeoff: the assistant message is persisted only after the upstream stream finishes or the route reaches its persistence path. A process crash or database failure after the provider has emitted substantial content can leave the user with a partial UI response but no durable assistant message. The agent run store mitigates this more effectively for agent history than the plain chat path. Consider periodic stream checkpointing or a durable “in-progress response” record if recovery after process failure is an explicit product requirement.

### 2.4 Memory and context management

Conversation memory uses a bounded replay window, character budgets, persisted `memoryText`, and rolling summaries refreshed from only the overflow transcript. Agent responses additionally retain compact execution context describing steps, tool names, results, and important paths. [20] This is a sensible balance between context continuity, token cost, and database growth.

The main risk is semantic rather than structural. Summaries are generated by the same provider family whose output may already be unreliable, and the system has no explicit confidence, provenance, or user-visible indication that a fact came from a lossy summary. The summary prompt asks for factual compression, but there is no verification layer for contradictions or omission of critical constraints. For coding workflows, a better design would combine model summaries with deterministic state: current workspace path, changed-file list, active task IDs, latest verification status, and checkpoint references should be treated as authoritative structured state rather than only summarized prose.

## 3. Security and trust-boundary analysis

### 3.1 What the project does well

The workspace boundary is implemented with path resolution and symlink-aware checks, and shell commands validate their working directory against the selected workspace. Child processes receive a sanitized environment that removes `APP_SECRET`, database credentials, API-key-like variables, private keys, tokens, and related secrets. [11] [12] Provider keys are encrypted at rest using the application secret, and startup validation rejects weak or known placeholder secrets. [6]

The project also has layered approval semantics. Mutating tools are marked as approval-required, dangerous shell commands are analyzed even when the tool would otherwise be auto-approved, and the browser’s click/type/evaluate actions require approval. Prompt-injection detection scans user, file, and web-like content and can wrap suspicious text in an explicit untrusted-content envelope. These are valuable defense-in-depth measures, particularly for a local assistant that consumes arbitrary repository and web content. [13] [14]

### 3.2 Highest-priority risks

| Priority | Finding | Evidence | Impact | Recommended response |
|---|---|---|---|---|
| **P0** | **Hosted multi-user mode is not a complete identity model.** | `getLocalUser()` always upserts the singleton `local@localhost.com`, while many protected handlers obtain that local user instead of deriving the subject from the verified JWT. [7] [16] [5] | A deployment may authenticate requests but still attribute data and side effects to one shared local identity. This undermines the README’s hosted/multi-user claim and can produce cross-user data exposure or incorrect ownership. | Introduce `request.user` as the sole identity source in protected routes and services. Keep local-user bootstrap behind an explicit local-only mode. Add multi-user integration tests that create two identities and verify isolation across every route family. |
| **P0** | **Remote MCP configuration accepts arbitrary network endpoints, headers, and stdio commands.** | MCP routes persist user-supplied transport configuration; the client creates HTTP transports from arbitrary URLs and stdio transports from arbitrary commands. [15] | A compromised account, malicious workspace instruction, or unsafe hosted configuration can reach internal services, launch arbitrary local programs, or forward sensitive headers. Approval on the model-facing MCP tool does not protect direct remote-management endpoints. | Separate “trusted local operator” from “hosted user” policy. Add URL/IP egress policy, block loopback/link-local/private destinations where appropriate, validate transport-specific fields, restrict stdio commands, and require approval/audit for direct remote calls. |
| **P0** | **Browser navigation has only an `http`/`https` scheme check.** | `browser_navigate` accepts any HTTP(S) URL; there is no origin allowlist or private-network restriction. [15] | Headless browser automation can access intranet services, cloud metadata endpoints, local admin panels, or attacker-controlled pages. Browser state and arbitrary page JavaScript increase the blast radius. | Add configurable navigation and request allowlists, private-address/DNS-rebinding defenses, per-run browser contexts, cookie/storage isolation, download restrictions, and a clear “external side effect” approval policy. |
| **P1** | **Dangerous-command detection is regex-based and bypassable by shell syntax.** | The project explicitly describes normalized regex matching for dangerous patterns. [13] | Obfuscation, alternate utilities, shell expansion, command substitution, aliases, encoded PowerShell, redirection, or chained commands can evade individual patterns. The separate first-word allowlist is also platform- and shell-dependent. | Move from denylist-only matching toward an execution broker: parse commands where possible, run in a constrained OS account/container, deny network and privilege escalation by policy, and log the exact effective command. Keep regexes as supplemental warnings. |
| **P1** | **Process-global resources do not scale or recover cleanly across instances.** | Terminal sessions, browser pages, MCP connections, and exit-hatch state are held in in-memory maps. [12] [15] [17] | Restart loses live control state; load balancing can route follow-up calls to a process without the session; memory leaks or stale resources can accumulate. | Add TTL cleanup, explicit shutdown hooks, resource quotas, and a documented single-process constraint. For hosted deployment, externalize state and use worker affinity or a job/session service. |
| **P1** | **Dependency audit currently reports production-relevant vulnerabilities.** | Local `npm audit --omit=dev` reported 4 frontend and 12 backend vulnerabilities, including direct `react-router@7.13.0`, `@fastify/static@8.3.0`, and `fastify@5.8.4` findings. [25] [26] | Some findings are likely low-exposure in the default loopback deployment, but internet-facing static serving, routing, URI parsing, and server request handling are release risks. | Upgrade to fixed versions, regenerate lockfiles, review transitive fixes, and make a clean audit or documented exception part of release CI. |
| **P1** | **Direct MCP route calls do not visibly share the model-facing approval gate.** | `/mcp/remote/call` invokes a configured remote tool directly after JWT protection; `mcp_call_tool` itself is approval-required, but the route is not an agent approval dialog. [15] | Any caller with a valid session can trigger third-party MCP side effects through the route without the same confirmation semantics. | Treat remote call as a privileged operation: require an explicit user confirmation token, restrict it to trusted local mode, or expose only read-only discovery through unauthenticated automation paths. |
| **P2** | **Plain chat durability is weaker than agent-run durability.** | Chat assistant persistence occurs after stream consumption, whereas agent runs have explicit run-start and chunk persistence. [1] [19] [21] | Crash or DB failure can lose a long partial answer and leave usage/state inconsistent. | Add response checkpoints or a durable stream ledger if crash recovery matters. |
| **P2** | **Working-tree hygiene and documentation drift reduce release confidence.** | Active uncommitted changes include a reasoning-effort feature, a large apparent diff in `agent-run-store.ts` caused largely by line-ending churn, and `git diff --check` reports CRLF/trailing-whitespace issues. [23] CONTRIBUTING.md says 373+ tests while README says 637. [23] | Reviewers may miss substantive changes; automated quality checks become noisy; operational instructions can mislead contributors. | Normalize line endings, isolate the feature into a focused commit, update test-count documentation automatically, and add a clean-tree/reproducibility check to CI. |

### 3.3 Authentication and deployment interpretation

The repository is honest that loopback is the safe default and that local login bootstrapping is restricted to loopback requests. [6] [16] This is appropriate for the personal-machine mode. The problem is that the code and README also describe hosted MySQL/PostgreSQL and multi-user operation, while much of the data-access layer still uses the singleton local user helper. The product should either narrow the documented deployment claim to “single-user only” or complete the identity migration before recommending hosted exposure.

The authentication hook itself is correctly applied to protected route groups, and the health/auth routes are intentionally public. [5] That is a good boundary at the HTTP layer, but authorization must continue through every service call. Authentication proves who sent the request; it does not guarantee that the route’s subsequent query uses that identity.

## 4. Agent behavior, reliability, and UX

The agent harness has several mature characteristics. It supports explicit run statuses, stale-running-run cleanup, live pause/resume/redirect/abort controls, tool-call approval state, resumability, checkpoint previews, process-session records, and run summaries. The run store sanitizes and truncates persisted JSON and text to contain database growth and reduce accidental retention of huge tool outputs. [17] [21]

The frontend complements this with event-specific projection. Thinking, tool calls, assistant messages, step boundaries, completion, reconnects, and file mutations each have distinct handlers. The use of history replacement rather than normal navigation prevents a stream-completion URL update from retriggering conversation loading and duplicating messages. [19] This is a strong example of solving a real SPA race condition rather than merely building the happy path.

The verification model is valuable but should be treated as advisory until backed by stronger tests. The README describes a verify-before-done loop that runs tests and typecheck after code edits and allows a fix round. [1] Verification commands themselves execute within the same workspace and process trust domain as the agent. A malicious or broken repository can influence test scripts, environment behavior, or output. For higher assurance, verification should run with a restricted environment and explicit network/privilege policy, and the UI should clearly distinguish “command exited successfully” from “the code is correct.”

## 5. Integrations and external surfaces

The provider layer supports heterogeneous OpenAI-compatible services and now includes per-model reasoning profiles. The active feature is a positive design improvement: reasoning capabilities are represented centrally, the frontend fetches a profile keyed by provider/model, and the backend can optionally use upstream model metadata with a cache before falling back to local patterns. [2] The work reduces manual frontend/backend drift, although the local model-pattern table remains a heuristic catalog that will require maintenance as providers change.

Browser automation is powerful but intentionally broad. A single cached browser context and per-run page map make multi-step workflows convenient, while screenshots are stored under the workspace. [15] The design should add explicit cleanup TTLs and isolation guarantees; a browser context is a stateful credential and cookie boundary, not merely a page handle.

MCP support is similarly ambitious and structurally clean, with transport abstraction, tool discovery, connection cleanup, and sanitized stdio environment inheritance. [15] The key architectural decision is that MCP tools are dynamically discovered and then represented as synthetic tools. This is flexible, but arbitrary remote schemas and tool descriptions become part of the LLM’s instruction surface. They should be treated as untrusted metadata, constrained in size, logged with provenance, and screened for prompt-injection content before being incorporated into the agent prompt.

## 6. Data model and persistence observations

Prisma is a good fit for the product’s relational state: users, provider settings and keys, conversations/messages, workspaces, agent runs/steps/tool calls, checkpoints, process sessions, scheduled tasks, usage, rules, memories, and integration records. SQLite with WAL, normal synchronous mode, a busy timeout, and cache tuning is a reasonable default for a personal-machine application. [7] [8]

The principal data-model concern is that ownership correctness depends more on calling code than on the schema alone. Foreign keys and composite lookups help, but every route must consistently scope reads and writes to the authenticated principal. The schema should be reviewed for explicit cascade behavior, retention policies, and indexes on the most common user/conversation/run queries. In particular, detailed tool-call results, screenshots, attachments, and memory text can contain secrets or personal data; a production deployment needs retention, deletion, export, and encryption/backup documentation beyond encryption of provider keys.

## 7. Validation and quality-gate results

The local frontend test suite completed successfully with **10 test files and 66 tests passing**. The frontend production build also completed successfully, although Vite emitted a chunk-size warning for bundles larger than 500 kB. The repository’s documented backend suite contains **571 tests**, for a documented total of 637, and the earlier project validation pass reported the backend type-check, lint, tests, coverage, and build gates as green. [1] [3] [4]

A local runtime probe confirmed that the already-running backend responded successfully from `127.0.0.1:8787`, reported a connected database, and rejected a protected agent-tools request with HTTP 401 when no token was supplied. The frontend root responded with HTTP 200. A fresh attempt to start another backend correctly failed with `EADDRINUSE`, confirming that the port was already occupied rather than indicating a boot failure.

The quality posture is therefore strong for compilation and unit/integration-style tests. It is weaker for adversarial integration coverage. There is no evidence from the reviewed surface of a comprehensive test matrix for two-user isolation, SSRF/private-network blocking, DNS rebinding, browser state leakage, command obfuscation, MCP tool-description injection, crash recovery during SSE, or concurrent worker behavior. These should become explicit security and reliability test suites rather than informal manual checks.

The frontend build warning indicates a secondary performance issue. KaTeX and syntax-highlighting assets contribute to a sizeable bundle, and the build recommends manual chunking. This is not a correctness blocker, but route-level lazy loading and vendor chunk separation would improve first-load latency for users who only need the chat shell.

## 8. Current working-tree state

The repository is not clean. The current diff includes documentation updates, reasoning-effort capability work, provider-model parsing changes, route and API changes, model-selector changes, and new tests. Most notably, `server/src/lib/agent-run-store.ts` appears as a 569-line deletion plus 569-line addition in the default diff, while an ignore-end-of-line comparison reduces that to a small substantive change plus feature additions. This is consistent with line-ending churn and should be cleaned before review.

The active reasoning-effort work is directionally good. It introduces a centralized capability profile with `none`, `binary`, `standard`, and `extended` styles, clamps unsupported effort settings, and exposes a backend profile endpoint to the UI. [2] The feature still depends on manually curated model regexes for many providers, so it should be described as **partly data-driven**, not fully authoritative. Upstream metadata is optional and cached; when metadata is absent, the fallback remains heuristic.

The current working tree also has a concrete hygiene issue: `git diff --check` reports trailing-whitespace/CRLF markers in the new provider-model test changes. That does not necessarily affect runtime behavior, but it is a signal that the feature should be normalized and reviewed as an isolated change before merge.

## 9. Prioritized remediation roadmap

| Phase | Focus | Deliverables | Exit criterion |
|---|---|---|---|
| **P0 — before hosted exposure** | Identity and authorization | Replace singleton-user lookups in protected paths; add request-principal service context; add two-user isolation tests for conversations, workspaces, settings, runs, terminal, MCP, schedules, and usage. | No protected operation can read or mutate another user’s records in an integration test. |
| **P0 — before hosted exposure** | Execution isolation | Define a worker/executor policy for shell, browser, MCP, and verification tools; restrict private-network egress; constrain stdio commands; remove secret-bearing headers from arbitrary downstream calls. | Adversarial tests cannot reach forbidden files, interfaces, metadata endpoints, or credentials. |
| **P1** | Dependency and release security | Upgrade audited packages; regenerate lockfiles; add `npm audit`/OSV policy; add SBOM or dependency snapshot; resolve line endings and whitespace. | CI is reproducible and either audit-clean or has reviewed, time-bounded exceptions. |
| **P1** | State/resource lifecycle | Add TTL cleanup for terminal/browser/MCP maps, explicit per-run quotas, and startup reconciliation for stale processes and sessions. | Long-running soak test shows bounded memory and no orphaned resources. |
| **P1** | Adversarial agent testing | Add tests for prompt injection through files/web/MCP descriptions, command obfuscation, shell chaining, redirects, DNS rebinding, browser state isolation, and malicious tool schemas. | Security suite runs in CI and blocks release regressions. |
| **P2** | Frontend decomposition and performance | Split `use-chat-stream.ts` into transport, reducer/state, and command modules; lazy-load settings/IDE-heavy routes; add Vite manual chunks. | Initial chat-shell bundle and interaction complexity are measurably reduced without changing event semantics. |
| **P2** | Durable operations and data lifecycle | Add partial-response recovery where required, retention/deletion/export controls, structured run provenance, and backup/restore procedures including SQLite WAL files. | A documented recovery drill succeeds after process interruption and database restore. |
| **P2** | Documentation automation | Replace hard-coded test counts with generated values; document local-only versus hosted security modes; publish an integration capability matrix. | README, AGENTS.md, CONTRIBUTING.md, and CI output agree on the same supported deployment model. |

## Final conclusion

Rapa has the foundation of a strong local-first AI development environment. Its best qualities are the breadth of the tool system, thoughtful agent lifecycle design, explicit workspace boundary, practical streaming UX, durable run history, and unusually good attention to provider/runtime failure modes. The project is substantially beyond prototype quality in its core architecture.

The decisive next step is to align the **security model with the product’s deployment claims**. If the product remains a trusted single-user local tool, the existing design can be made very effective with dependency updates, cleanup, and adversarial testing. If it is intended to support hosted or multi-user use, identity propagation, execution isolation, outbound network policy, and resource ownership must be treated as architectural work rather than incremental hardening. Until then, the most accurate positioning is: **a capable and thoughtfully engineered personal-machine agent platform, suitable for controlled local use and not yet a hardened general-purpose hosted service.**

## References

[1]: ./README.md "Project README — product scope, agent loop, deployment, and documented test counts"

[2]: ./AGENTS.md "Agent guide — repository structure, modules, workflows, and architectural notes"

[3]: ./package.json "Frontend package manifest and scripts"

[4]: ./server/package.json "Backend package manifest and scripts"

[5]: ./server/src/index.ts "Fastify composition root, authentication hook, middleware, and route registration"

[6]: ./server/src/lib/env.ts "Environment loading and startup validation"

[7]: ./server/src/lib/db.ts "Prisma client, SQLite tuning, and local-user bootstrap"

[8]: ./server/prisma/schema.prisma "Prisma data model"

[9]: ./server/src/lib/agent.ts "Central agent run loop and lifecycle orchestration"

[10]: ./server/src/lib/agent/tool-orchestrator.ts "Tool policy, batching, execution, approvals, and verification"

[11]: ./server/src/tools/filesystem.ts "Workspace path and symlink-boundary enforcement"

[12]: ./server/src/tools/shell.ts "Shell execution, sanitized environment, process sessions, and command policy"

[13]: ./server/src/lib/safety/dangerous-patterns.ts "Dangerous-command heuristic analysis"

[14]: ./server/src/lib/safety/prompt-injection.ts "Prompt-injection detection and untrusted-content wrapping"

[15]: ./server/src/mcp/client.ts "MCP transports, connection lifecycle, and external-server trust boundary"

[16]: ./server/src/routes/auth.ts "Login, local-user provisioning, and JWT issuance"

[17]: ./server/src/routes/agent-control.ts "Pause, resume, redirect, abort, and exit-hatch control routes"

[18]: ./src/app/routes.tsx "Frontend route composition and chat UI state"

[19]: ./src/app/hooks/use-chat-stream.ts "Frontend streaming, reconnect, approval, and run-control orchestration"

[20]: ./server/src/lib/conversation-memory.ts "Replay windows, memory text, and rolling summaries"

[21]: ./server/src/lib/agent-run-store.ts "Agent-run durability, step persistence, checkpoints, and process sessions"

[22]: ./server/src/tools/index.ts "Native tool registration"

[23]: ./CONTRIBUTING.md "Contributor workflow and documented testing/build requirements"

[24]: ./server/src/tools/index.ts "Verified count of 58 native tool registration calls"

[25]: ./.analysis-frontend-audit.json "Local npm audit report for frontend production dependencies"

[26]: ./.analysis-backend-audit.json "Local npm audit report for backend production dependencies"

