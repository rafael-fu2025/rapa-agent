# AGENTS.md — Rapa / Recreate UI

> AI Agent guide for working on this repository. Read this entire file before making any changes.

---

## 1. Project Overview

Rapa is a **full-stack AI agent platform** with a React frontend and a Fastify/Node.js backend. Users interact with LLMs through three modes: Chat (direct conversation), Agent (autonomous tool-using agent), and Plan (read-only planning). The backend orchestrates an iterative agent loop that can read/write files, execute shell commands, search the web, and manage Git — all within a user-defined workspace directory.

- **Frontend**: React 18 · Vite 6 · TypeScript · Tailwind CSS 4 · Radix UI · React Router 7
- **Backend**: Fastify 5 · TypeScript · Prisma 6 · Zod
- **Agent Tools**: 30+ registered tools across 6 categories (filesystem, shell, web, git, system, diagnostics)
- **Database**: Prisma ORM with 12 models. Default for personal-machine use is **SQLite** (`file:./dev.db`, no daemon). The same schema also supports MySQL / PostgreSQL by switching the `provider` in `server/prisma/schema.prisma` — see [docs/PERSONAL_DEPLOY.md](docs/PERSONAL_DEPLOY.md) §6.
- **Deployment**: Personal-machine default (Node.js + Vite, two terminals). Docker (Dockerfile + docker-compose.yml) and MySQL are still supported for users who want a hosted / multi-user setup.
- **Testing**: 266 tests (40 frontend + 226 server) via Vitest

---

## 2. Repository Structure

```
Recreate UI/
├── src/                          # Frontend source
│   ├── main.tsx                  # React 18 entry point, KaTeX CSS import
│   ├── app/
│   │   ├── App.tsx               # Root: RouterProvider + Sonner Toaster
│   │   ├── routes.tsx            # All routes & chat UI logic
│   │   └── components/
│   │       ├── ui/               # 40+ Radix UI primitive wrappers (shadcn-style)
│   │       ├── chat/             # Chat-specific components (message-list.tsx)
│   │       ├── top-bar.tsx       # App branding, mode toggle, workspace chip, export
│   │       ├── sidebar.tsx       # Conversation list, workspace modal & switching
│   │       ├── chat-input.tsx    # Message input with attachments, drag-and-drop
│   │       ├── assistant-markdown.tsx  # Renders LLM responses (Markdown + KaTeX + code blocks)
│   │       ├── agent-steps-viewer.tsx  # Tool call trace, reasoning panels, ProgressRing
│   │       ├── agent-run-panel.tsx     # Historical run detail view
│   │       ├── interactive-options.tsx # Ask-user question UI (blueprint checkboxes)
│   │       ├── mode-switch-prompt.tsx  # Mode switch approval prompt
│   │       ├── model-selector.tsx      # Provider + model picker
│   │       ├── settings-page.tsx       # Provider settings management
│   │       ├── service-keys-settings.tsx # API key management
│   │       ├── appearance-page.tsx     # Theme customization
│   │       ├── agent-settings-page.tsx # Agent configuration (auto-approve, rules)
│   │       ├── agent-specialists-page.tsx # Specialist/sub-agent configuration
│   │       ├── usage-analytics-page.tsx  # Token usage charts
│   │       ├── login-page.tsx          # Authentication page
│   │       ├── workspace-selector.tsx  # Workspace dropdown
│   │       ├── terminal-view.tsx       # xterm.js terminal emulator
│   │       ├── diff-view.tsx           # Text diff display
│   │       ├── task-list.tsx           # Agent task progress tracker
│   │       ├── tool-approval-dialog.tsx # Shell command approval
│   │       ├── tool-execution-history.tsx # Historical tool call list
│   │       └── add-custom-provider.tsx # Custom OpenAI-compatible provider form
│   ├── lib/
│   │   ├── api.ts               # Chat API client (SSE streaming, REST)
│   │   ├── agent-api.ts         # Agent API client (SSE streaming, tools, rules)
│   │   ├── workspace-api.ts     # Workspace management client
│   │   ├── tool-history.ts      # Tool call history state management
│   │   └── utils.ts             # cn() utility for Tailwind class merging
│   ├── styles/
│   │   ├── index.css            # Global styles + Tailwind layers
│   │   ├── tailwind.css         # Tailwind v4 import + keyframes
│   │   ├── theme.css            # CSS custom properties (tokens) + @theme inline
│   │   └── fonts.css            # Font face declarations
│   └── assets/                  # Provider logos (SVG), app icon (SVG)
├── server/                       # Backend source
│   ├── src/
│   │   ├── index.ts             # Fastify entry point, route registration, tool init
│   │   ├── lib/
│   │   │   ├── agent.ts         # Core agent loop orchestration
│   │   │   ├── agent/           # Extracted agent modules (see §2.1)
│   │   │   ├── tools.ts         # Tool base class + ToolRegistry + risk levels
│   │   │   ├── agent-run-store.ts   # Persists completed agent runs to DB
│   │   │   ├── conversation-memory.ts # Sliding window + summarization
│   │   │   ├── sub-agents.ts    # Specialist sub-agent orchestration
│   │   │   ├── tool-scopes.ts   # Tool scope/permission management
│   │   │   ├── auto-approve.ts  # Auto-approve category configuration
│   │   │   ├── run-limits.ts    # Iteration and token budget limits
│   │   │   ├── exit-hatch.ts    # Graceful agent loop exit strategies
│   │   │   ├── usage.ts        # Token usage tracking
│   │   │   ├── skill-md.ts     # Skill markdown parsing
│   │   │   ├── db.ts            # Prisma client + auth user helpers
│   │   │   ├── crypto.ts        # AES-256-GCM encrypt/decrypt for API keys
│   │   │   ├── env.ts           # Environment variable validation
│   │   │   ├── constants.ts     # Provider models, base URLs, defaults
│   │   │   └── safety/          # Safety modules (see §2.2)
│   │   ├── routes/
│   │   │   ├── agent.ts         # /api/agent/* — tool listing, execution, approvals, rules
│   │   │   ├── agent-control.ts # /api/agent/control — run management
│   │   │   ├── auth.ts          # /api/auth/* — JWT authentication
│   │   │   ├── chat.ts          # /api/chat/stream — chat SSE streaming
│   │   │   ├── conversations.ts # /api/conversations — CRUD
│   │   │   ├── workspaces.ts    # /api/workspaces — CRUD, file tree, folder picker
│   │   │   ├── settings.ts      # /api/settings — provider config, API keys, analytics
│   │   │   ├── service-keys.ts  # /api/service-keys — API key management
│   │   │   ├── mcp.ts           # /api/mcp — MCP server integration
│   │   │   ├── terminal.ts      # /api/terminal — WebSocket PTY sessions
│   │   │   └── health.ts        # /api/health — liveness check
│   │   ├── tools/
│   │   │   ├── index.ts         # Tool registration (registerAllTools)
│   │   │   ├── filesystem.ts    # read/write/list/search/delete/rename/mkdir
│   │   │   ├── edit-file.ts     # edit_file, replace_in_file, append_file
│   │   │   ├── shell.ts         # execute_command, start/stop/list_process
│   │   │   ├── web.ts           # fetch_url, web_search (Serper API + DuckDuckGo)
│   │   │   ├── git.ts           # git_status, git_diff, git_log, git_branch, git_commit
│   │   │   ├── tasks.ts         # add_task, update_task
│   │   │   ├── agent-tools.ts   # think, ask_user, summarize_progress
│   │   │   └── diagnostics.ts   # read_lints, run_tests
│   │   └── mcp/
│   │       ├── server.ts        # MCP server implementation
│   │       └── client.ts        # MCP client integration
│   └── prisma/
│       ├── schema.prisma        # 12 models (see §7 Database Schema)
│       └── migrations/          # Timestamped migration directories
├── web-dist/                    # Vite production build output
├── index.html                   # Vite HTML entry point
├── vite.config.ts               # Vite config: React plugin, Tailwind plugin, outDir: web-dist
├── Dockerfile                   # Container build (frontend + backend)
├── docker-compose.yml           # Docker Compose stack (app + MySQL)
├── package.json                 # Frontend dependencies + scripts
└── AGENTS.md                    # This file
```

### 2.1 Agent Modules (`server/src/lib/agent/`)

The agent loop is decomposed into focused modules:

| Module | Purpose |
|--------|---------|
| `prompt-builder.ts` | System prompt construction, tool docs injection, broad-analysis detection |
| `response-parser.ts` | Extract JSON tool calls from LLM response, correction nudges |
| `llm-client.ts` | LLM API call with timeout, retry, and circuit breaker |
| `tool-orchestrator.ts` | Batch tool execution (read-only parallel, write sequential), approval flow |
| `tool-docs.ts` | Tool documentation strings injected into the system prompt |
| `supervisor.ts` | Sub-agent delegation and result aggregation |
| `reasoning-budget.ts` | Token budget allocation for reasoning vs. response |
| `tracing.ts` | Execution tracing and observability |
| `langfuse-exporter.ts` | Export traces to Langfuse (optional) |
| `qa-rules.ts` | Response quality validation (API key detection, content checks) |
| `code-validators.ts` | Syntax validation for generated code |
| `schema-correction.ts` | Auto-correction when LLM produces malformed tool call JSON |
| `resilience.ts` | Circuit breaker, retry, and timeout patterns |
| `circuit-breaker.ts` | Circuit breaker implementation for LLM calls |
| `retry.ts` | Exponential backoff retry logic |
| `timeout.ts` | Configurable timeout wrapper |
| `checkpoint.ts` | File checkpointing for rollback |
| `types.ts` | Shared TypeScript types for agent modules |

### 2.2 Safety Modules (`server/src/lib/safety/`)

| Module | Purpose |
|--------|---------|
| `prompt-injection.ts` | Detect and mitigate prompt injection attacks in user input |
| `dangerous-patterns.ts` | Pattern matching for dangerous shell commands and file operations |

### Key Files by Role

| Role | File | Purpose |
|------|------|---------|
| **LLM API call** | `server/src/lib/agent/llm-client.ts` | Calls OpenAI-compatible `/chat/completions` with timeout + retry |
| **Tool execution** | `server/src/lib/agent/tool-orchestrator.ts` | Batch runs tools (read-only parallel, write sequential) |
| **SSE streaming out** | `server/src/routes/agent.ts` | Writes `data: {...}\n\n` to response |
| **SSE streaming in** | `src/lib/api.ts` → `consumeSseStream()` | Parses SSE from fetch Response |
| **Agent prompt** | `server/src/lib/agent/prompt-builder.ts` | System prompt with tool docs, rules, and context |
| **Response parsing** | `server/src/lib/agent/response-parser.ts` | Extracts JSON toolCalls from LLM response |
| **Conversation memory** | `server/src/lib/conversation-memory.ts` | Sliding window + LLM summarization |

---

## 3. Development Workflow

### 3.1 Environment Setup (First-Time)

The default setup targets a **personal-machine, single-user, web-format
deployment** — Node.js + Vite on your local computer, SQLite for
storage, no cloud, no Docker required. For a hosted / multi-user
deployment, see [docs/PERSONAL_DEPLOY.md](docs/PERSONAL_DEPLOY.md) §6.

```bash
# 1. Prerequisites
#    - Node.js 20+ (check with `node -v`)
#    - Git installed and on PATH
#    - That's it. No DB server needed — SQLite is embedded.

# 2. Clone and install
git clone <repo-url>
cd "Recreate UI"
npm install
cd server
npm install

# 3. Configure environment
cp server/.env.example server/.env
# Edit server/.env:
#   DATABASE_URL="file:./dev.db"      <-- SQLite, the default
#   APP_SECRET="generate-a-long-random-string-here"  (>= 32 chars, hex)
#   HOST=127.0.0.1                    <-- loopback only, the default
#   PORT=8787
#   DEFAULT_PROVIDER="gemini"

# 4. Generate APP_SECRET (one-liner, paste into .env):
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 5. Create the SQLite database and run migrations
npx prisma generate
npx prisma migrate dev --name init

# 6. Start development servers (two terminals)
# Terminal 1 — Backend:
cd server && npm run dev       # Fastify on :8787

# Terminal 2 — Frontend:
npm run dev                    # Vite on :5173

# 7. Open http://localhost:5173 in your browser. No login — the first
#    request auto-creates the local user row.
```

### 3.2 Provider Setup

Before using the app, configure at least one AI provider in Settings:
1. Open `http://localhost:5173` → Settings gear icon
2. Select a provider (Gemini recommended for initial setup)
3. Add your API key
4. The key is encrypted with `APP_SECRET` before storage

### 3.3 Workspace Setup

The agent operates on a workspace directory:
1. In the sidebar, click "Add Workspace"
2. Select a project folder (must exist on disk)
3. The agent can now read/write files within that workspace
4. Workspaces are pinned per-conversation at creation time

### 3.4 Available Scripts

#### Frontend (`package.json`)
| Command | Purpose |
|---------|---------|
| `npm run dev` | Start Vite dev server (HMR on :5173) |
| `npm run build` | Production build → `web-dist/` |
| `npm test` | Run frontend tests (Vitest, 40 tests) |

#### Backend (`server/package.json`)
| Command | Purpose |
|---------|---------|
| `npm run dev` | Start Fastify with tsx watch (auto-reload) |
| `npm run build` | Compile TypeScript → `server/dist/` |
| `npm start` | Run compiled production server |
| `npm test` | Run backend tests (Vitest, 226 tests) |
| `npm run prisma:generate` | Regenerate Prisma client from schema |
| `npm run prisma:migrate` | Create and apply migration |

### 3.5 Build Commands (Run Before Committing)

```bash
# Check backend compiles
cd server && npx tsc --noEmit

# Check frontend compiles
npm run build

# Run all tests
npm test                  # Frontend (40 tests)
cd server && npm test     # Backend (226 tests)

# All must pass before committing
```

---

## 4. Coding Standards & Conventions

### 4.1 TypeScript

- **Strict mode enabled** — `server/tsconfig.json` has `"strict": true`
- **No `any`** — Use `unknown` and type narrowing; `as` casts only for FFI boundaries
- **Prefer type over interface** — Project uses `type` for most definitions
- **Return types explicit on public functions** — Private methods may omit
- **No default exports** — Use named exports throughout
- **Import paths**: Backend uses `.js` extensions (NodeNext module resolution); Frontend uses `@/` alias

### 4.2 Naming Conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Files | kebab-case | `agent-steps-viewer.tsx` |
| React components | PascalCase | `AgentStepsViewer` |
| Hooks | `use` prefix + camelCase | `useAutoScroll` |
| Functions | camelCase | `buildSystemPrompt()` |
| Types/interfaces | PascalCase | `AgentExecutionEvent` |
| Constants | UPPER_SNAKE_CASE | `DEFAULT_LLM_TIMEOUT_MS` |
| Tools | PascalCase + "Tool" suffix | `GitStatusTool` |
| Routes | camelCase registration | `registerAgentRoutes()` |
| Database models | PascalCase | `AgentRun` |
| DB columns | camelCase | `workspaceId` |

### 4.3 Tool Creation Pattern

When adding a new tool, follow this template:

```typescript
// server/src/tools/my-tool.ts
import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../lib/tools.js";

export class MyNewTool extends Tool {
  definition: ToolDefinition = {
    name: "my_new_tool",                  // snake_case, unique
    description: "Clear one-line description",
    category: "filesystem",               // filesystem | shell | web | system
    riskLevel: "read",                    // none | read | write | destructive | network
    requiresApproval: false,              // true for dangerous operations
    parameters: {
      myParam: {
        type: "string",
        description: "What this parameter does",
        required: true
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    // 1. Extract and validate params
    // 2. Execute logic
    // 3. Return { success: true, ... } or { success: false, error: "..." }
  }
}
```

Then register in `server/src/tools/index.ts`:
```typescript
import { MyNewTool } from "./my-tool.js";
// inside registerAllTools():
toolRegistry.register(new MyNewTool());
```

### 4.4 API Route Pattern

```typescript
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, getLocalUser } from "../lib/db.js";

export async function registerMyRoutes(app: FastifyInstance) {
  app.get("/resource", async (request, reply) => {
    const user = await getLocalUser();
    // ... fetch from prisma ...
    return { data };
  });

  app.post("/resource", async (request, reply) => {
    const parsed = mySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", issues: parsed.error.issues });
    }
    // ... create ...
  });
}
```

### 4.5 Engineering Blueprint Design System

The frontend uses a cohesive "Engineering Blueprint" visual language across all agent-related components:

- **Corners**: `rounded` (sharp, not `rounded-lg` / `rounded-xl`)
- **Labels**: Monospace uppercase with wide tracking — `font-mono text-[9px] font-semibold uppercase tracking-[0.16em]`
- **Borders**: Thin, semi-transparent — `border-border/60`
- **Backgrounds**: `bg-card-3` for containers, `bg-card` for inner sections
- **Accent colors**: Reserved exclusively for status signaling (blue = running, green = done, red = failed, yellow = approval/pending)
- **ProgressRing**: Custom SVG indicator used as the universal status element (spinning arc for running, check/X for terminal states, pulsing for approval)
- **Status labels**: Lowercase monospace — `running`, `done`, `failed`, `approve`, `pending`
- **Shimmer bars**: `animate-[shimmer_1.5s_ease-in-out_infinite]` gradient bars for active processing
- **Code blocks**: No line numbers, `font-size: 11px`, `line-height: 1.6`, blueprint header with language label + copy/download buttons
- **Tables**: Sharp borders, monospace uppercase headers, `bg-card-3` chrome
- **Inline code**: `rounded border-border/60 bg-card-3 font-mono text-[10px]`

This system applies to: ToolTraceCard, CollapsibleReasoning, InteractiveOptions, ModeSwitchPrompt, ErrorBanner, ApiKeySwitchBanner, ResumableRunBanner, PendingIndicator, and all markdown-rendered content.

---

## 5. Key Architectural Decisions

### 5.1 SSE over WebSocket for Agent Streaming
**Decision**: Use Server-Sent Events for agent execution streaming, WebSocket only for terminal PTY sessions.
**Rationale**: SSE is simpler (HTTP, auto-reconnect, one-directional), sufficient for server→client event streams. WebSocket adds bidirectional complexity unnecessary for chat/agent flows. Terminal sessions need bidirectional I/O.

### 5.2 OpenAI-Compatible Provider Abstraction
**Decision**: All LLM calls go through `/chat/completions` OpenAI-compatible endpoints.
**Rationale**: Single integration surface supports Gemini, NVIDIA, Puter, OpenRouter, and custom providers without provider-specific code. The `baseUrl` setting determines the endpoint.

### 5.3 Workspace-Bound Tool Execution
**Decision**: All filesystem tools are restricted to paths within the configured workspace root via `isWithinWorkspace()`.
**Rationale**: Prevents agent from reading/writing outside the user's approved working directory. Uses `path.resolve()` + `path.relative()` for robust path traversal prevention.

### 5.4 Per-Conversation Workspace Binding
**Decision**: Each conversation pins a `workspaceId` at creation time. Historical conversations restore their original workspace when reopened.
**Rationale**: Prevents context drift — the agent always operates on the workspace the conversation was started with. Workspace switching is blocked while viewing an existing conversation (with toast notification).

### 5.5 Extracted Agent Module Architecture
**Decision**: The core agent loop (`agent.ts`) delegates to focused modules in `server/src/lib/agent/` for LLM calls, response parsing, tool orchestration, tracing, resilience, and validation.
**Rationale**: Separation of concerns — each module has a single responsibility and can be tested independently. The agent loop becomes an orchestration layer rather than a monolith.

### 5.6 No Canned Responses
**Decision**: All user prompts (including greetings, "what can you do", help requests) are routed through the LLM.
**Rationale**: Consistent behavior — the model responds contextually using the system prompt rather than regex-matched hardcoded text. The system prompt instructs the LLM to handle greetings and capability questions in prose.

---

## 6. Agent Loop Architecture

### 6.1 Execution Flow

```
User prompt
  │
  ▼
prepareAgentRequest()         ── DB lookups, workspace resolution, seed history
  │
  ▼
new Agent(context, config)    ── Initialize with system prompt + memory
  │
  ▼
agent.stream(userPrompt)      ── AsyncGenerator<AgentExecutionEvent>
  │
  └── Iteration loop (1..maxIterations)
      │
      ├── callLLM()           ── POST /chat/completions (with timeout + retry)
      │
      ├── parseAssistantResponse()   ── Extract JSON toolCalls
      │   ├── parseError → correction message, continue
      │   ├── expectsToolUse → correction message, continue (max 1 correction)
      │   ├── needsContinuation → similar correction
      │   ├── toolCalls present → execute them
      │   └── no toolCalls → final response
      │
      ├── executeToolCallsInBatches()
      │   ├── resolveToolApproval()   ── Parallel approval checks
      │   ├── Read-only tools         ── Promise.all (parallel)
      │   └── Write/shell tools       ── Sequential + retry on transient errors
      │
      ├── ask_user? → return question to user, end stream
      │
      ├── Stall detection → diversity nudge or force-answer injection
      │
      └── yield events: thinking, tool_call, step
```

### 6.2 Event Types (Frontend Consumption)

| Event Type | Frontend Handler | Purpose |
|-----------|-----------------|---------|
| `start` | Sets `conversationId`, navigates URL | New conversation creation |
| `thinking` | Updates `liveReasoning` on message | Streaming reasoning display |
| `tool_call` | Updates `liveToolCalls` array | Real-time tool status (ProgressRing) |
| `assistant` | Sets message `content` | Streaming final response |
| `step` | Commits step to `agentSteps`, clears live state | Iteration boundary |
| `done` | Finalizes message, persists to DB | Stream completion |
| `error` | Sets error state | Error display (ErrorBanner) |

### 6.3 Tool Approval Flow

```
Agent wants write/shell tool
  │
  ▼
needsToolApproval() = true && tool NOT in autoApproveTools
  │
  ▼
buildApprovalRequiredResult()    ── Returns { requiresApproval: true, approvalId: "..." }
  │
  ▼
waitForToolApproval()            ── Promise held in pendingToolApprovals Map
  │
  ▼
SSE event sent to frontend       ── { type: "tool_call", status: "requires_approval" }
  │
  ▼
Frontend shows approve/reject UI ── ToolTraceCard inline approval prompt
  │
  ▼
POST /api/agent/approvals         ── { approvalId, approved: true/false }
  │
  ▼
Promise resolved → tool executes (or rejected result returned)
```

---

## 7. Database Schema

### 7.1 Core Models

| Model | Table | Key Relations | Indexes |
|-------|-------|--------------|---------|
| `AppUser` | `app_user` | — | `email` (unique) |
| `Workspace` | `workspace` | `-> AppUser` | `[userId]` |
| `ProviderSetting` | `provider_setting` | `-> AppUser`, `-> ProviderApiKey[]` | `[userId, provider]` (unique) |
| `ProviderApiKey` | `provider_api_key` | `-> ProviderSetting` | `[providerSettingId, isActive]` |
| `Conversation` | `conversation` | `-> AppUser`, `-> Workspace?` | `[userId, updatedAt]`, `[workspaceId]` |
| `Message` | `message` | `-> Conversation` | `[conversationId, createdAt]` |

### 7.2 Agent Models

| Model | Table | Key Relations | Purpose |
|-------|-------|--------------|---------|
| `AgentRun` | `agent_run` | `-> Conversation`, `-> Workspace?` | Persisted execution runs |
| `AgentRunStep` | `agent_run_step` | `-> AgentRun` | Per-iteration record with reasoning |
| `AgentToolCall` | `agent_tool_call` | `-> AgentRun`, `-> AgentRunStep?` | Each tool invocation with params/result |
| `AgentCheckpoint` | `agent_checkpoint` | `-> AgentRun`, `-> AgentRunStep?`, `-> AgentToolCall?` | File snapshots for rollback |
| `AgentProcessSession` | `agent_process_session` | `-> AgentRun`, `-> Workspace?` | Long-running shell process tracking |

### 7.3 Extensibility Models

| Model | Purpose |
|-------|---------|
| `AgentRule` | User-defined rules at global/workspace/conversation scope |
| `AgentSkill` | Installable agent skill definitions |
| `AgentIntegration` | External service integrions (deploy, database) |
| `AgentMcpServer` | MCP (Model Context Protocol) server connections |

### 7.4 Migration Guidelines

- **Never edit existing migration files** — Only add new ones
- **Run `npx prisma migrate dev`** after schema changes
- **Always provide a descriptive migration name**: `npx prisma migrate dev --name add_feature_description`
- **Check generated SQL** in the migration file before committing
- **Add `@db.Text` or `@db.LongText`** for fields that may exceed VARCHAR limit

---

## 8. Testing

### 8.1 Current State

**266 tests across 21 test files, all passing.**

| Suite | Files | Tests | Runner |
|-------|-------|-------|--------|
| Frontend | 2 | 40 | Vitest + jsdom |
| Backend | 19 | 226 | Vitest |

Frontend tests cover chat types and utility functions. Backend tests cover the agent loop modules (envelope, response parser, tool docs, tool orchestrator, tracing, supervisor, LLM client, resilience), safety modules (prompt injection, dangerous patterns), and infrastructure (crypto, env, tool scopes, run limits, exit hatch, MCP server).

### 8.2 Running Tests

```bash
# Frontend tests
npm test                    # → npx vitest run

# Backend tests
cd server && npm test       # → npx vitest run

# Both must pass before committing
```

---

## 9. Deployment

**Default: personal-machine (single user, single computer).** See
[docs/PERSONAL_DEPLOY.md](docs/PERSONAL_DEPLOY.md) for the full guide.
Short version: two terminals, one for `server/`, one for the root,
open `http://localhost:5173`.

### 9.1 Docker

```bash
docker-compose up --build
```

### 9.2 Production Build (Standalone)

```bash
# Build frontend
npm run build                              # → web-dist/

# Build backend
cd server && npm run build                 # → server/dist/

# Start backend
cd server && NODE_ENV=production npm start
```

### 9.3 Environment Variables (server/.env)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | DB connection string. Default for personal use: `file:./dev.db` (SQLite). For hosted, switch to `mysql://...` or `postgresql://...` and update `prisma/schema.prisma` provider. |
| `APP_SECRET` | Yes | — | AES-256-GCM key for stored API keys (min 32 chars). Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `HOST` | No | `127.0.0.1` | Network interface the API binds to. Loopback is the safe default; set to `0.0.0.0` to expose the API to your LAN. |
| `PORT` | No | `8787` | API server port. |
| `DEFAULT_PROVIDER` | No | `gemini` | Default AI provider (`gemini`, `openai`, `anthropic`, `nvidia`, `ollama`, `puter`, `custom`). |
| `AGENT_LLM_TIMEOUT_MS` | No | `180000` | LLM call timeout (milliseconds). |
| `SERPER_API_KEY` | No | — | Required for the `web_search` tool (falls back to DuckDuckGo if unset). |
| `DEFAULT_WORKSPACE_ROOT` | No | `process.cwd()` | Fallback workspace directory when no workspace is configured. |
| `CORS_ORIGINS` | No | `http://localhost:5173` | Allowed CORS origins (comma-separated). The default covers the Vite dev server. |

### 9.4 Ports

| Service | Dev | Production |
|---------|-----|------------|
| Frontend | `5173` (Vite) | Served by reverse proxy or Fastify static |
| Backend API | `8787` (loopback by default) | `8787` (or `PORT` env) |
| Database | none (SQLite file) | optional MySQL `3306` or Postgres `5432` |

---

## 10. Common Issues & Solutions

### 10.1 "No agent tools were registered"
**Cause**: `registerAllTools()` failed or was called before tool file imports resolved.
**Fix**: Verify all tool files exist and export their classes. Check for TypeScript compilation errors in `server/src/tools/`.

### 10.2 "Missing API key. Configure provider in Settings first."
**Cause**: No `ProviderApiKey` with `isActive: true` for the selected provider.
**Fix**: Go to Settings → select provider → add API key. Verify key has `isActive: true` in DB.

### 10.3 "Conversation not found"
**Cause**: `conversationId` in request belongs to a different user or was deleted.
**Fix**: Verify the conversation exists for the current user. Check auth token validity.

### 10.4 PTY session not starting (Windows)
**Cause**: `node-pty` requires Windows build tools. May fail to load PowerShell.
**Fix**: Ensure `pwsh` or `powershell` is on PATH. The shell tool falls back to `child_process.exec` if PTY fails.

### 10.5 Prisma "Too many connections"
**Fix**: Add `connection_limit=5` to `DATABASE_URL`. (Only applies to
MySQL / Postgres — SQLite is a single-process embedded engine and
doesn't have this problem.)

### 10.6 Frontend build warning about large chunks
**Expected**: The monolith bundle is ~570 KB gzipped. This is a known issue — consider code-splitting with dynamic `import()` for route-level components.

---

## 11. Commit Conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):
```
feat: add git_status tool
fix: prevent useEffect from clearing in-flight agent messages
refactor: extract llm-client from agent loop
docs: update AGENTS.md for extracted agent modules
chore: update npm dependencies
test: add unit tests for response-parser
```

### Before Merging

1. Both `npm run build` commands pass (root + server)
2. All tests pass (`npm test` in root and `server/`)
3. Manual smoke test: open app, send a chat message, send an agent message
4. No commented-out code or console.log left in
5. Migration files reviewed for correctness

---

## 12. Cross-References

- **Figma design reference**: [Figma — Recreate UI](https://www.figma.com/design/1vyrWlZ8G27nkUD9D3Xv2T/Recreate-UI)
- **Database schema**: [`server/prisma/schema.prisma`](server/prisma/schema.prisma) — Authoritative source for all models
- **Environment configuration**: [`server/.env.example`](server/.env.example) — Template for required variables
- **Tool implementation guide**: See §4.3 above for the complete tool creation pattern

---

*Last updated: 2026-06-14. This file should be reviewed and updated whenever significant architectural changes are made.*
