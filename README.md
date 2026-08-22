# Rapa — Self-Hosted AI Agent Platform

<img src="https://img.shields.io/badge/Node.js-20%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js 20+" />
<img src="https://img.shields.io/badge/React_18-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React 18" />
<img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
<img src="https://img.shields.io/badge/Fastify_5-000000?style=for-the-badge&logo=fastify&logoColor=white" alt="Fastify 5" />
<img src="https://img.shields.io/badge/Prisma_6-2D3748?style=for-the-badge&logo=prisma&logoColor=white" alt="Prisma 6" />
<img src="https://img.shields.io/badge/License-MIT-22C55E?style=for-the-badge" alt="MIT License" />

A full-stack AI agent platform you run on your own machine. Chat with any
OpenAI-compatible LLM in three modes — **Chat** (direct conversation),
**Agent** (an autonomous tool-using loop), and **Plan** (read-only analysis) —
while the agent reads and writes files, runs shell commands, searches the web,
drives a headless browser, manages Git, and talks to MCP servers, all bounded
to a workspace directory you choose.

SQLite by default — no daemon, no cloud, no Docker required. The same code
runs hosted with MySQL/PostgreSQL by switching the Prisma provider.

## Highlights

- **Three modes, one UI** — Chat, Agent, and a read-only Plan mode with a
  hard tool allowlist.
- **60+ tools, 11 categories** — filesystem, code editing, shell, web,
  browser automation (Playwright), Git, image generation, document
  generation, scheduling, notifications/email, and MCP passthrough.
- **Workspace-scoped by design** — every file and shell action is bounded to
  your workspace; symlink escapes are rejected, secrets are stripped from
  child processes, and write/shell tools require your approval by default.
- **A real agent harness** — parallel read-only batches, sequential writes,
  context compaction with file restoration, loop/stall detection, run
  limits (tokens / cost / duration), circuit breakers, and tracing with
  optional Langfuse export.
- **Isolated sub-agents** — `spawn_agent` runs a fresh-context, read-only
  child agent that investigates and reports back, keeping the parent's
  context clean.
- **Verify-before-done** — when the agent edits code, the harness runs the
  workspace's tests and typecheck; a failing suite bounces the "done"
  answer back for one fix round.
- **AGENTS.md support** — your workspace's `AGENTS.md` / `CLAUDE.md` /
  `.cursorrules` is injected at run start, wrapped injection-safe.
- **Key rotation** — register multiple API keys per provider; Rapa
  auto-rotates when one hits a rate limit.
- **Scheduling** — cron / interval / one-shot agent runs with history.
- **Built-in IDE surface** — file tree with context menu, Go-to-file
  (Ctrl+P), Find-in-files, and an embedded terminal (xterm.js).

## Quick start

Prerequisites: Node.js 20+ and Git. That's it.

```bash
git clone https://github.com/rafael-fu2025/rapa-agent.git
cd rapa-agent

npm install
cd server && npm install && cd ..

cp server/.env.example server/.env
# Optional: edit server/.env — the defaults work out of the box.
# Generate an APP_SECRET (already set in .env.example for local dev):
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

cd server
npx prisma generate
npx prisma migrate dev --name init
cd ..

# Terminal 1 — backend (Fastify on 127.0.0.1:8787)
cd server && npm run dev

# Terminal 2 — frontend (Vite on http://localhost:5173)
npm run dev
```

Then:

1. **Add a provider** — Settings → pick a provider (Gemini recommended) →
   paste your API key. Keys are encrypted (AES-256-GCM) before storage.
2. **Add a workspace** — sidebar → Add Workspace → pick a project folder.
   The agent can now read and write inside it; each conversation pins its
   workspace.

## Configuration

Everything lives in `server/.env` (see [`server/.env.example`](server/.env.example)).

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | `file:./dev.db` | SQLite default; switch to `mysql://` / `postgresql://` when hosted |
| `APP_SECRET` | yes | — | Encryption key for stored API keys (≥ 32 chars) |
| `HOST` | no | `127.0.0.1` | Bind address — loopback is the safe default |
| `PORT` | no | `8787` | API port |
| `DEFAULT_PROVIDER` | no | `gemini` | `gemini`, `openai`, `anthropic`, `nvidia`, `ollama`, `puter`, `custom` |
| `SERPER_API_KEY` | no | — | Serper-backed `web_search` (falls back to DuckDuckGo) |
| `CORS_ORIGINS` | no | `http://localhost:5173` | Allowed CORS origins |

## The agent loop

```text
User prompt
  → seed history (conversation memory, rules, specialists, AGENTS.md)
  → iterate up to maxIterations:
      call LLM → parse tool calls → execute
        read-only tools in parallel (identical re-reads stubbed)
        write/shell tools sequentially, with approval gates
        checkpoint validation: lint + throttled tests/typecheck
      ask_user? → return question to the user
      context >65%? → compact + re-attach recently-read files
  → tool-free answer → verify-before-done gate (tests + typecheck)
  → done event (carries verification status)
```

Events stream to the browser over SSE (WebSocket only for the terminal PTY).
Full architecture, module map, and conventions: [AGENTS.md](AGENTS.md).

## Tools at a glance

61 tools across 11 categories:

| Category | Count | Examples |
|---|---|---|
| Filesystem | 15 | `read_file`, `write_file`, `edit_file`, `search_content` |
| System & tasks | 15 | `think`, `ask_user`, `plan_tasks`, `run_tests`, `run_typecheck` |
| Code & sub-agents | 7 | `delegate_task`, `spawn_agent`, `get_agent_status` |
| Shell | 6 | `execute_command`, `start_process`, `get_process_output` |
| Git | 6 | `git_status`, `git_diff`, `git_commit` |
| Browser (Playwright) | 5 | `browser_navigate`, `browser_click`, `browser_evaluate` |
| Web | 3 | `fetch_url`, `web_search` |
| Scheduler | 3 | `schedule_task`, `list_scheduled_tasks` |
| Documents & media | 4 | `create_document`, `generate_image`, `render_widget` |
| Notifications & email | 3 | `send_notification`, `send_email` |
| MCP | 2 | `mcp_list_servers`, `mcp_call_tool` |

## Development

```bash
npm test                    # frontend (56 tests)
cd server && npm test       # backend (506 tests)

npm run typecheck && cd server && npm run typecheck
npm run lint && npm run lint:server     # zero warnings allowed
cd server && npm run test:coverage      # per-area coverage gate
```

562 tests total, all passing. All four gates (type-check, lint, tests,
coverage) run green before every commit. See [CONTRIBUTING.md](CONTRIBUTING.md)
for the full workflow.

## Deployment

**Personal machine (default)** — two terminals as in Quick Start.

**Docker** — SQLite on a volume, works out of the box:

```bash
export APP_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
docker compose up --build
```

`APP_SECRET` is required — compose refuses to start without it. MySQL is an
opt-in for hosted setups (instructions in `docker-compose.yml`).

**Hosted (multi-user)** — switch the Prisma provider to `mysql` or
`postgresql`, point `DATABASE_URL` at your database, set `HOST=0.0.0.0` and
`CORS_ORIGINS`, then `npx prisma migrate deploy && npm run build && npm start`.

## Security model

- **Workspace boundary** — absolute paths and `..` rejected; `realpath`
  resolves symlinks and re-checks, so links pointing outside the workspace
  are refused.
- **Sanitized shell env** — `APP_SECRET`, `DATABASE_URL`, and every
  `*_API_KEY` / `*_SECRET` / `*_PRIVATE_KEY` are stripped before any child
  process runs.
- **Encrypted at rest** — provider API keys are AES-256-GCM encrypted with
  `APP_SECRET`.
- **Approval gates** — write/shell/destructive tools require explicit
  approval; a dangerous-pattern overlay (e.g. `rm -rf /`) is checked even
  for auto-approved commands.
- **Injection defense** — untrusted tool output and workspace instruction
  files are scanned and wrapped as data, never executed as instructions.
- **JWT auth** — every route except health/auth sits behind token auth,
  with per-IP rate limiting.

## Common issues

- **"No agent tools were registered"** — a tool import failed; check backend
  logs for the missing dependency.
- **"Missing API key"** — Settings → provider → add key → confirm it's active.
- **PTY not starting on Windows** — `node-pty` needs VS Build Tools (C++
  workload); the shell falls back to `child_process.exec` without it.
- **SQLite "database is locked"** — a stray node process holds the file;
  stop it and restart.

## Acknowledgements

The harness design draws on the best of the open agent ecosystem — Claude
Code's compaction and sub-agent patterns, QoderWork's tool catalog,
Odysseus's stall detection, and the Model Context Protocol spec.

## License

[MIT](LICENSE)
