// Per-tool rich documentation used in the agent system prompt.
//
// Each entry is a complete doc block rendered into the prompt in place of
// the old flat "TOOL CHEAT SHEET". This mirrors the TOOL_SECTIONS approach
// used by the Odysseus agent platform: each tool owns its own usage rules,
// anti-patterns, and a concrete call example. The LLM gets a single,
// structured reference per tool instead of guessing from a one-liner.
//
// To document a new tool: add a key here matching `tool.definition.name`.
// The renderer falls back to the tool's `description` for any tool that
// is not in this map, so a missing entry is non-fatal (just less helpful).

export type ToolDoc = {
  /** One-line "what this tool is for" — printed as the section header. */
  summary: string;
  /** When to reach for this tool. Print as a lead-in. */
  whenToUse: string;
  /** Function-call shape: name({required, optional}). */
  signature: string;
  /** Concrete call example. */
  example: string;
  /** Bullet list of "do this / not that" rules. */
  rules: string[];
};

export const TOOL_DOCS: Record<string, ToolDoc> = {
  // Doc blocks for the new tools in the upgrade plan are defined in
  // `NEW_TOOL_DOCS` below and merged in via `Object.assign` at the
  // bottom of the file. Keeping them out of this main map avoids a
  // single unreadably long section.

  // -----------------------------------------------------------------------
  // Filesystem
  // -----------------------------------------------------------------------
  read_file: {
    summary: "Read file contents (or a line slice) from the workspace.",
    whenToUse: "First call before any `edit_file` or `write_file`. Use `offset`/`limit` for large files; never `read_file` the whole repo in one go.",
    signature: "read_file({ path: string, offset?: number, limit?: number })",
    example: `{"toolCalls":[{"id":"r1","name":"read_file","parameters":{"path":"server/src/index.ts","offset":1,"limit":120}}]}`,
    rules: [
      "`path` is RELATIVE to the workspace root, never absolute. Use `list_directory` to discover paths.",
      "`offset` is 1-based. `limit` is the number of LINES, not bytes.",
      "For huge files, read in slices of 200-400 lines, not the whole file.",
      "If the file doesn't exist, the error tells you the closest matching path — re-check the spelling, don't re-read the parent."
    ]
  },

  write_file: {
    summary: "Create a new file, or fully overwrite an existing one.",
    whenToUse: "For NEW files only, or for full overwrites the user explicitly asked for. Prefer `edit_file` for surgical changes to existing files.",
    signature: "write_file({ path: string, content: string })",
    example: `{"toolCalls":[{"id":"w1","name":"write_file","parameters":{"path":"src/utils/format.ts","content":"export const fmt = (n: number) => n.toLocaleString();\\n"}}]}`,
    rules: [
      "Make sure the parent directory exists. If unsure, call `mkdir({recursive: true})` first.",
      "`content` is the FULL file content. The tool overwrites without warning.",
      "If the file already exists and you only want to change a small part, use `edit_file` instead — it shows a diff.",
      "Don't write_file a 2000-line file when a 3-line `edit_file` would do — that wastes tokens and is harder to review."
    ]
  },

  list_directory: {
    summary: "List files and directories in a folder.",
    whenToUse: "When you don't know what files exist in a folder, or to confirm a path before reading it.",
    signature: "list_directory({ path?: string, recursive?: boolean })",
    example: `{"toolCalls":[{"id":"l1","name":"list_directory","parameters":{"path":"server/src/routes","recursive":false}}]}`,
    rules: [
      "Omit `path` (or use `.`) to list the workspace root.",
      "`recursive: true` returns a tree. Skip it when a non-recursive listing will do — recursive output can be huge.",
      "Ignored by default: `.git`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `.nuxt`, `.turbo`."
    ]
  },

  search_files: {
    summary: "Glob for filenames matching a wildcard pattern.",
    whenToUse: "When you know a filename (or extension) but not its location. Pair with `read_file` once you find a match.",
    signature: "search_files({ pattern: string, path?: string, recursive?: boolean })",
    example: `{"toolCalls":[{"id":"sf1","name":"search_files","parameters":{"pattern":"**/*.test.ts","path":"server/src"}}]}`,
    rules: [
      "Use `*.ext` for a single folder, `**/*.ext` for recursive.",
      "Returns paths relative to the search root. If results are empty, broaden the pattern or search from the workspace root."
    ]
  },

  search_content: {
    summary: "Regex/needle search across file contents with pagination and output modes.",
    whenToUse: "First tool to reach for when hunting a symbol, function name, error string, or config key across the codebase. Use regex mode for patterns, contextLines for surrounding code.",
    signature: "search_content({ query: string, path?: string, caseSensitive?: boolean, recursive?: boolean, fileExtensions?: string[], maxResults?: number, regex?: boolean, multiline?: boolean, contextLines?: number, headLimit?: number, offset?: number, outputMode?: 'content'|'files_only'|'count' })",
    example: `{"toolCalls":[{"id":"sc1","name":"search_content","parameters":{"query":"isWithinWorkspace","path":"server/src","fileExtensions":[".ts"],"maxResults":20,"contextLines":2}}]}`,
    rules: [
      "Pass `fileExtensions` to scope by language — much faster than searching everything.",
      "Set `regex: true` for pattern matching (e.g. `function\\s+\\w+`, `import.*from`).",
      "Use `multiline: true` with regex for patterns spanning lines (requires `regex: true`).",
      "`contextLines: N` includes N lines before and after each match (like `rg -C`).",
      "`outputMode: 'files_only'` returns just file paths. `'count'` returns match counts per file.",
      "Paginate with `offset` and `headLimit` for large result sets.",
      "Empty results usually mean the wrong path or too-narrow a query. Drop `fileExtensions`, broaden the path."
    ]
  },

  edit_file: {
    summary: "Surgical find-and-replace inside an existing file.",
    whenToUse: "The default for modifying existing files. Use `replace_in_file` (alias) if you prefer that name.",
    signature: "edit_file({ path, oldText, newText, startLine?, endLine?, replaceGlobally?: boolean })",
    example: `{"toolCalls":[{"id":"e1","name":"edit_file","parameters":{"path":"src/app.tsx","oldText":"const x = 1;\\n","newText":"const x = 2;\\n","replaceGlobally":false}}]}`,
    rules: [
      "`oldText` MUST be a BYTE-EXACT, UNIQUE substring. Include 3+ lines of context above and below to guarantee uniqueness.",
      "If \"not found\", the error points at the closest line — re-read that section and adjust. Whitespace, indentation, and line endings cause most failures.",
      "Use `startLine`/`endLine` to scope the search to a known line range (useful for big files).",
      "`replaceGlobally: true` to rename a symbol across the file in ONE call (prefer this over looping one match at a time).",
      "If the same edit fails twice in a row, switch strategy: `read_file` then `write_file` the full corrected content."
    ]
  },

  replace_in_file: {
    summary: "Alias of `edit_file`. Same parameters, same behavior.",
    whenToUse: "Identical to `edit_file`. Use whichever name reads better for the change you're making.",
    signature: "replace_in_file({ path, oldText, newText, startLine?, endLine?, replaceGlobally?: boolean })",
    example: `{"toolCalls":[{"id":"r1","name":"replace_in_file","parameters":{"path":"README.md","oldText":"## Old Title\\n","newText":"## New Title\\n"}}]}`,
    rules: [
      "Functionally identical to `edit_file`. The alias exists for familiarity with other coding agents."
    ]
  },

  append_file: {
    summary: "Append text to the end of an existing file.",
    whenToUse: "For GROWING a file (adding a new export, new test case, new log line). Avoids reading and rewriting the whole file.",
    signature: "append_file({ path, content, insertNewline?: boolean })",
    example: `{"toolCalls":[{"id":"a1","name":"append_file","parameters":{"path":"server/src/index.ts","content":"\\napp.listen(8787);\\n"}}]}`,
    rules: [
      "`insertNewline` defaults to true — the tool ensures the new content starts on a fresh line.",
      "Use this for appends. For inserts in the MIDDLE of a file, use `edit_file`."
    ]
  },

  delete_file: {
    summary: "Delete a file or directory from the workspace.",
    whenToUse: "Destructive. Always confirm via the user's request before calling.",
    signature: "delete_file({ path, recursive?: boolean })",
    example: `{"toolCalls":[{"id":"d1","name":"delete_file","parameters":{"path":"src/old-feature","recursive":true}}]}`,
    rules: [
      "For directories, set `recursive: true`. Without it, the tool refuses non-empty directories.",
      "All deletions are workspace-confined — you cannot delete files outside the workspace root."
    ]
  },

  rename_file: {
    summary: "Rename or move a file/directory within the workspace.",
    whenToUse: "When the user asks to rename, move, or relocate a file/folder.",
    signature: "rename_file({ oldPath: string, newPath: string })",
    example: `{"toolCalls":[{"id":"mv1","name":"rename_file","parameters":{"oldPath":"src/old.ts","newPath":"src/new.ts"}}]}`,
    rules: [
      "Both paths are workspace-relative. You can move across folders (e.g. `src/a.ts` → `lib/a.ts`).",
      "If you need to move many files at once, prefer a single `execute_command` with a shell `mv` loop over one `rename_file` per file."
    ]
  },

  mkdir: {
    summary: "Create a directory (with optional parents).",
    whenToUse: "Before `write_file` if the parent folder doesn't exist yet.",
    signature: "mkdir({ path: string, recursive?: boolean })",
    example: `{"toolCalls":[{"id":"m1","name":"mkdir","parameters":{"path":"src/components/new-folder","recursive":true}}]}`,
    rules: [
      "`recursive: true` is the usual choice — creates intermediate parent folders and is idempotent.",
      "Idempotent: calling `mkdir` on an existing path is a no-op (no error)."
    ]
  },

  read_image: {
    summary: "Read an image file and return it as base64-encoded data for visual processing.",
    whenToUse: "When you need to inspect an image file (PNG, JPG, GIF, WebP, SVG, BMP, ICO). The result includes base64 data that multimodal LLMs can process visually.",
    signature: "read_image({ path: string })",
    example: `{"toolCalls":[{"id":"ri1","name":"read_image","parameters":{"path":"src/assets/logo.png"}}]}`,
    rules: [
      "Supports: .png, .jpg, .jpeg, .gif, .webp, .svg, .bmp, .ico — up to 10MB.",
      "Returns `base64Data`, `mediaType`, and a `content` array for multimodal LLM processing.",
      "For SVG files, also returns `textContent` (the XML source) since SVGs are text-based.",
      "Use `read_file` for text files, `read_image` for binary image files."
    ]
  },

  // -----------------------------------------------------------------------
  // Web
  // -----------------------------------------------------------------------
  fetch_url: {
    summary: "Fetch the contents of a URL with optional AI-powered processing.",
    whenToUse: "When the user gives you a concrete URL (or you just got one from `web_search`) and you need the page contents. Add a `prompt` to get a processed summary instead of raw content.",
    signature: "fetch_url({ url: string, method?: string, headers?: object, body?: string, prompt?: string })",
    example: `{"toolCalls":[{"id":"f1","name":"fetch_url","parameters":{"url":"https://docs.example.com/api","prompt":"Extract all API endpoints and their parameters"}}]}`,
    rules: [
      "GET by default. POST/PUT/PATCH accept `headers` and `body`.",
      "HTML content is automatically converted to clean text. Raw JSON is preserved.",
      "When `prompt` is provided, the fetched content is processed by the LLM with your prompt. Returns both `body` (raw/truncated) and `processedContent` (AI-processed).",
      "Content is truncated to 80K chars in the body. The LLM receives up to 60K chars for processing.",
      "If no `prompt` is given, you get the raw content — use `search_content` or your own reasoning to process it."
    ]
  },

  web_search: {
    summary: "Search the web for current information.",
    whenToUse: "For one-shot factual lookups. NOT for multi-source deep research (the user should ask for that explicitly and it requires a different pipeline).",
    signature: "web_search({ query: string, maxResults?: number })",
    example: `{"toolCalls":[{"id":"s1","name":"web_search","parameters":{"query":"React 19 useActionState best practices 2026","maxResults":5}}]}`,
    rules: [
      "ALWAYS include the current year in the query when the user wants 'latest' or 'current' information.",
      "`maxResults` defaults to 5, max 10. Keep it bounded — context budget is finite.",
      "If a search gives you URLs, follow up with `fetch_url` on the most relevant one or two, not all of them."
    ]
  },

  // -----------------------------------------------------------------------
  // Shell
  // -----------------------------------------------------------------------
  execute_command: {
    summary: "Run a shell command in a persistent terminal session (PTY when available). Supports background mode.",
    whenToUse: "For builds, tests, installs, `ls`, `cat`, `grep`, `git status`, and any other one-shot shell invocation. Use `background: true` for long-running commands.",
    signature: "execute_command({ command: string, cwd?: string, timeoutMs?: number, sessionId?: string, input?: string, closeSession?: boolean, background?: boolean })",
    example: `{"toolCalls":[{"id":"x1","name":"execute_command","parameters":{"command":"npm run build","timeoutMs":180000}}]}`,
    rules: [
      "Pass `--yes` / `-y` / `--non-interactive` to package managers and installers upfront — never let the command wait for a prompt.",
      "Use `cwd` for sub-folders (e.g. `server/`) when the project has multiple package.json files.",
      "Set `background: true` for long-running commands — returns immediately with a session ID. Monitor with `get_process_output`.",
      "If a command is LONG-RUNNING and you don't need `background` flag, use `start_process` instead.",
      "If the command fails with 'waiting for input' / 'interactive prompt', re-run with `input` set to your answer.",
      "DO NOT use shell to create or modify files (no `>`/`>>`, no `sed -i`, no heredoc writes). Use `write_file` / `edit_file` — they show a diff and are the only allowed write path.",
      "`timeoutMs` default is 30s. Raise it for builds (180000+)."
    ]
  },

  start_process: {
    summary: "Start a long-running process in a background terminal session.",
    whenToUse: "For dev servers, watchers, training jobs, file-tail processes, and anything that doesn't return within a few seconds.",
    signature: "start_process({ command: string, cwd?: string, sessionId?: string })",
    example: `{"toolCalls":[{"id":"sp1","name":"start_process","parameters":{"command":"npm run dev","sessionId":"dev-server"}}]}`,
    rules: [
      "Returns a `sessionId`. Use it to read output via `get_process_output` and to stop the process via `stop_process`.",
      "Reuse an existing `sessionId` to keep state (env vars, cwd, shell history) across commands.",
      "Always remember to `stop_process` when you're done — leaked processes eat ports and memory."
    ]
  },

  stop_process: {
    summary: "Stop a previously-started background process.",
    whenToUse: "When you're done with a `start_process` session, or the user asks to kill a running process.",
    signature: "stop_process({ sessionId: string })",
    example: `{"toolCalls":[{"id":"k1","name":"stop_process","parameters":{"sessionId":"dev-server"}}]}`,
    rules: [
      "You need the exact `sessionId` from `start_process` (or from `list_processes`).",
      "Stopping is best-effort; the OS may need a few hundred ms to free the port."
    ]
  },

  list_processes: {
    summary: "List active background processes and terminal sessions.",
    whenToUse: "When you need to find a running `sessionId`, or to confirm a process is still alive.",
    signature: "list_processes()",
    example: `{"toolCalls":[{"id":"lp1","name":"list_processes","parameters":{}}]}`,
    rules: [
      "No parameters. Returns one row per active session with its id, command, and status."
    ]
  },

  get_process_output: {
    summary: "Read recent output from a background terminal session with optional regex filtering.",
    whenToUse: "After `start_process` or `execute_command` with `background: true` to peek at logs, check status, or extract specific lines.",
    signature: "get_process_output({ sessionId: string, maxChars?: number, filter?: string, block?: boolean, timeout?: number })",
    example: `{"toolCalls":[{"id":"gp1","name":"get_process_output","parameters":{"sessionId":"dev-server","maxChars":2000,"filter":"error|warn","block":true,"timeout":10000}}]}`,
    rules: [
      "Returns the TRAILING chunk of stdout/stderr by default.",
      "`filter` is a regex — only matching lines are returned. Great for extracting errors, warnings, or specific log patterns.",
      "`block: true` (default) waits briefly for new output if buffer is empty. `block: false` returns immediately.",
      "`timeout` sets max wait time in ms when blocking (default 5000, max 30000).",
      "If you need earlier output, log to a file and `read_file` it.",
      "`maxChars` defaults small; raise it when debugging startup logs."
    ]
  },

  // -----------------------------------------------------------------------
  // Tasks
  // -----------------------------------------------------------------------
  add_task: {
    summary: "Add an item to the in-run task list.",
    whenToUse: "At the start of multi-step work, register the phases (inspect, implement, verify, polish) so the user can see progress.",
    signature: "add_task({ taskId: string, description: string, status?: \"pending\"|\"in_progress\"|\"completed\"|\"failed\" })",
    example: `{"toolCalls":[{"id":"t1","name":"add_task","parameters":{"taskId":"inspect","description":"Read current login.tsx and routes","status":"in_progress"}}]}`,
    rules: [
      "`taskId` is a stable, kebab-case identifier you choose. Reuse the same id if you need to update.",
      "Mark the first task `in_progress` immediately, the rest `pending`.",
      "The task list is shown in the UI — keep `description` short and human-readable."
    ]
  },

  update_task: {
    summary: "Update a task's description or status.",
    whenToUse: "As you complete each task in the list, mark it `completed`. If blocked, mark `failed` with a note.",
    signature: "update_task({ taskId: string, description?: string, status?: \"pending\"|\"in_progress\"|\"completed\"|\"failed\" })",
    example: `{"toolCalls":[{"id":"t2","name":"update_task","parameters":{"taskId":"inspect","status":"completed"}}]}`,
    rules: [
      "Move tasks in this order: pending → in_progress → completed.",
      "Update in the same turn you finish the work — don't batch task updates at the end.",
      "If a task is `failed`, the description should briefly explain why."
    ]
  },

  plan_tasks: {
    summary: "Create or replace the entire task plan in one call. Preferred over add_task for multi-step work.",
    whenToUse: "At the start of any task with more than 2-3 steps. Call ONCE to create the plan, then START EXECUTING IMMEDIATELY. Do not call plan_tasks again unless the plan fundamentally changes.",
    signature: "plan_tasks({ tasks: string[] | {description: string, status?: string}[] })",
    example: `{"toolCalls":[{"id":"p1","name":"plan_tasks","parameters":{"tasks":["Read existing login flow","Implement JWT auth","Update tests","Verify with manual test"]}}]}`,
    rules: [
      "Each task can be a plain string OR an object with a `description` field. Both formats work.",
      "Task IDs are auto-generated: task-1, task-2, task-3, etc. Use these IDs with `update_task`.",
      "Always include a final verification/testing task.",
      "After calling plan_tasks, IMMEDIATELY start executing task-1. Do NOT use the `think` tool to plan further.",
      "After completing each task, call `update_task({ id: \"task-N\", status: \"completed\" })` BEFORE moving to the next task.",
      "Do NOT call plan_tasks multiple times to refine the plan — just execute the tasks you created."
    ]
  },

  update_working_memory: {
    summary: "Track files you create or modify during this run. Called 'mandatory' in the system prompt.",
    whenToUse: "After EVERY file write or edit operation. This ensures you remember which files you created/modified, even after context compaction.",
    signature: "update_working_memory({ addFile?: string, removeFile?: string, note?: string })",
    example: `{"toolCalls":[{"id":"wm1","name":"update_working_memory","parameters":{"addFile":"server/src/routes/auth.ts"}}]}`,
    rules: [
      "Call after EVERY `write_file`, `edit_file`, `replace_in_file`, or `append_file`.",
      "`addFile` takes a workspace-relative path of the file you just created or modified.",
      "Files tracked here are YOUR files — you own them and should reference them in your final response.",
      "The working memory persists to `.rapa/working-memory.md` and survives context compaction.",
      "Use `note` to add brief context about what you did to the file (optional)."
    ]
  },

  // -----------------------------------------------------------------------
  // Agent reasoning
  // -----------------------------------------------------------------------
  think: {
    summary: "Private scratchpad for hard reasoning.",
    whenToUse: "When a decision is genuinely hard (multi-step planning, debugging a non-obvious failure, weighing tradeoffs).",
    signature: "think({ thought: string })",
    example: `{"toolCalls":[{"id":"k1","name":"think","parameters":{"thought":"The error says 'cannot read property foo of undefined' at line 42. Looking at the call site, foo is from props.user.profile, which is missing because the API returned 401. So either auth is broken, or the user is unauthenticated. Let me check the network tab…"}}]}`,
    rules: [
      "Do NOT overuse. The `reasoning` field in your normal tool-call JSON already covers most needs.",
      "Use it when you need to think longer than a sentence, or when you want the thought persisted for later reference.",
      "Output of this tool is private to the run — the user does not see it directly."
    ]
  },

  ask_user: {
    summary: "Ask the user one or more structured multiple-choice questions.",
    whenToUse: "True blockers only — broad requests, destructive actions, conflicting constraints, or choices that change the approach.",
    signature: "ask_user({ questions: [{ question, header, options: [{label, description?, preview?, defaultOption?}], multiSelect: boolean }] })",
    example: `{"toolCalls":[{"id":"q1","name":"ask_user","parameters":{"questions":[{"question":"Which auth provider?","header":"Auth","options":[{"label":"Auth.js","description":"Drop-in for Next.js / Vite, broadest provider coverage","defaultOption":true},{"label":"Custom JWT","description":"Hand-rolled, no extra deps, more code to maintain"}],"multiSelect":false}]}}]}`,
    rules: [
      "1-4 questions per call. 2-4 options per question. `header` is a 1-12 char chip label.",
      "Set `defaultOption: true` on ONE option per question to mark it as the recommended choice.",
      "Labels must be non-empty and under 80 chars. Questions under 500 chars.",
      "If the answer lives in the workspace (file content, package.json, git log), FIND IT with a tool call — don't ask.",
      "If the user already gave clear direction in the prompt, proceed — don't ask again.",
      "For greetings, meta-questions, and 'what can you do', answer in prose, not with this tool.",
      "Reserve this for genuine decisions where guessing wrong wastes more time than asking."
    ]
  },

  summarize_progress: {
    summary: "Checkpoint the current state of a long-running task.",
    whenToUse: "Every ~8 iterations on long tasks, or when you want to give the user a clear progress update mid-flow.",
    signature: "summarize_progress({ summary: string })",
    example: `{"toolCalls":[{"id":"sum1","name":"summarize_progress","parameters":{"summary":"Implemented the three new API routes. Verified with curl. Still TODO: write tests for the failure paths."}}]}`,
    rules: [
      "Markdown is allowed in `summary`.",
      "Mention: what was done, key findings, what remains (if anything)."
    ]
  },

  summarize_conversation: {
    summary: "Generate a structured summary of the conversation so far.",
    whenToUse: "When the user asks for a recap, when context is getting long, or before delegating to a sub-agent.",
    signature: "summarize_conversation({ format?: \"structured\"|\"concise\" })",
    example: `{"toolCalls":[{"id":"sc1","name":"summarize_conversation","parameters":{"format":"structured"}}]}`,
    rules: [
      "`structured` (default) gives sections (requests, decisions, files, errors, remaining).",
      "`concise` gives a one-paragraph overview."
    ]
  },

  delegate_task: {
    summary: "Activate a focused specialist mode for a subtask (no child agent spawned).",
    whenToUse: "When you want specialist guidance for research, debugging, planning, or codebase analysis — without the overhead of a full sub-agent.",
    signature: "delegate_task({ specialist: string, task: string, context?: string })",
    example: `{"toolCalls":[{"id":"d1","name":"delegate_task","parameters":{"specialist":"debug","task":"Find the root cause of the failing CI test","context":"Test added in commit abc123, fails on Node 20 only"}}]}`,
    rules: [
      "Specialist stays inside the current agent — it shares your context and tools.",
      "Keep the `task` bounded and specific. Vague tasks get vague answers.",
      "Use this for focused dives, not for end-to-end implementations (do those yourself).",
      "For true parallel work, use `spawn_agent` instead."
    ]
  },

  spawn_agent: {
    summary: "Spawn an independent child agent to perform a task in parallel.",
    whenToUse: "When a subtask is complex enough to benefit from its own conversation loop and tool access. The child runs independently — you can continue other work.",
    signature: "spawn_agent({ task: string, taskContext?: string, maxIterations?: number })",
    example: `{"toolCalls":[{"id":"sa1","name":"spawn_agent","parameters":{"task":"Refactor the auth module to use JWT tokens instead of session cookies. Update all tests accordingly.","taskContext":"The auth module is in server/src/auth/. Tests are in server/src/auth/__tests__/.","maxIterations":20}}]}`,
    rules: [
      "Child agents are independent — they have NO access to your conversation history. Include all necessary context in `task` and `taskContext`.",
      "Task description must be at least 20 chars. Be specific and self-contained.",
      "Use `get_agent_status` to check progress and retrieve results.",
      "Use `send_message_to_agent` for follow-up instructions, `cancel_agent` to terminate.",
      "Prefer `delegate_task` for quick analytical tasks that don't need isolation.",
      "`maxIterations` defaults to 15, max 30. Keep bounded to prevent runaway agents."
    ]
  },

  send_message_to_agent: {
    summary: "Send a follow-up message or instruction to a running child agent.",
    whenToUse: "When a spawned child agent needs additional instructions, corrections, or context mid-execution.",
    signature: "send_message_to_agent({ agentId: string, message: string })",
    example: `{"toolCalls":[{"id":"sm1","name":"send_message_to_agent","parameters":{"agentId":"child-agent-1-abc123","message":"Also make sure to update the README with the new API format."}}]}`,
    rules: [
      "Only works for agents in 'pending' or 'running' state.",
      "You can only message agents spawned by the current conversation.",
      "Messages are queued — the child agent picks them up on its next iteration."
    ]
  },

  cancel_agent: {
    summary: "Cancel a running child agent immediately.",
    whenToUse: "When a spawned child agent is going off-track, taking too long, or is no longer needed.",
    signature: "cancel_agent({ agentId: string })",
    example: `{"toolCalls":[{"id":"ca1","name":"cancel_agent","parameters":{"agentId":"child-agent-1-abc123"}}]}`,
    rules: [
      "Cancellation is immediate. Partial results are discarded.",
      "You can only cancel agents spawned by the current conversation.",
      "Already-completed agents cannot be cancelled (the tool returns their final status)."
    ]
  },

  get_agent_status: {
    summary: "Check the status and progress of a spawned child agent.",
    whenToUse: "After `spawn_agent` to check if the child has finished, see its results, or monitor its progress.",
    signature: "get_agent_status({ agentId?: string })",
    example: `{"toolCalls":[{"id":"gs1","name":"get_agent_status","parameters":{"agentId":"child-agent-1-abc123"}}]}`,
    rules: [
      "Omit `agentId` to list ALL child agents for the current conversation.",
      "Returns: status, iteration count, tool call count, result (if completed), error (if failed).",
      "Completed agents are auto-cleaned after 30 minutes.",
      "Check status before assuming a child is done — it may still be running."
    ]
  },

  // -----------------------------------------------------------------------
  // Diagnostics
  // -----------------------------------------------------------------------
  read_lints: {
    summary: "Run lint diagnostics on a path or the whole workspace.",
    whenToUse: "After substantive edits, or when something looks off but isn't a runtime error.",
    signature: "read_lints({ cwd?: string, timeoutMs?: number })",
    example: `{"toolCalls":[{"id":"l1","name":"read_lints","parameters":{"cwd":"server","timeoutMs":120000}}]}`,
    rules: [
      "Default timeout is 120s. Raise it for monorepos.",
      "Faster than `run_tests` for catching surface-level mistakes."
    ]
  },

  run_tests: {
    summary: "Run the project's test suite.",
    whenToUse: "After non-trivial changes — before declaring done. The user expects green tests.",
    signature: "run_tests({ cwd?: string, timeoutMs?: number })",
    example: `{"toolCalls":[{"id":"t1","name":"run_tests","parameters":{"cwd":"server","timeoutMs":180000}}]}`,
    rules: [
      "Default timeout is 180s. Raise it for large projects.",
      "If a test fails, read the failure carefully — fix the root cause, don't paper over it.",
      "Don't run the FULL test suite for a 2-line change. If your test runner supports `-t name` or filtering, use `execute_command` directly with a narrower invocation."
    ]
  },

  // -----------------------------------------------------------------------
  // Git
  // -----------------------------------------------------------------------
  git_status: {
    summary: "Show the working tree status (staged / unstaged / untracked).",
    whenToUse: "Always run before `git_commit`. Also useful for an overview of what's changed in the workspace.",
    signature: "git_status({ path?: string })",
    example: `{"toolCalls":[{"id":"gs1","name":"git_status","parameters":{}}]}`,
    rules: [
      "Pass `path` to scope to a specific file or folder (handy after multi-area work).",
      "Default is the workspace root."
    ]
  },

  git_diff: {
    summary: "Show what changed (working tree vs index, or vs a commit).",
    whenToUse: "Before committing — to review the change set. Also useful when you forgot what you edited.",
    signature: "git_diff({ staged?: boolean, path?: string, ref?: string })",
    example: `{"toolCalls":[{"id":"gd1","name":"git_diff","parameters":{"staged":false,"path":"server/src/routes/agent.ts"}}]}`,
    rules: [
      "Default: unstaged changes. Set `staged: true` to see what's in the index.",
      "Pass `ref` (e.g. `HEAD~1`, `main`) to diff against a specific commit/branch.",
      "If the diff is huge, narrow it with `path`."
    ]
  },

  git_log: {
    summary: "Show recent commit history (one-line format).",
    whenToUse: "When you need context on what changed recently, or to see commit message conventions in this repo.",
    signature: "git_log({ limit?: number, path?: string, author?: string })",
    example: `{"toolCalls":[{"id":"gl1","name":"git_log","parameters":{"limit":10,"path":"server/src"}}]}`,
    rules: [
      "Default limit is 15. Raise it for sweeps; lower it for a quick glance.",
      "Filter by `path` to see history of a single file (great before a risky refactor)."
    ]
  },

  git_branch: {
    summary: "List local (and optionally remote) branches.",
    whenToUse: "When you need to know which branch you're on or what branches exist.",
    signature: "git_branch({ all?: boolean })",
    example: `{"toolCalls":[{"id":"gb1","name":"git_branch","parameters":{"all":true}}]}`,
    rules: [
      "The current branch is marked with a star in the output.",
      "`all: true` includes remote branches."
    ]
  },

  git_commit: {
    summary: "Create a commit with staged changes.",
    whenToUse: "When logically complete work should be saved. Don't commit mid-task unless the user asks.",
    signature: "git_commit({ message: string, files?: string[] })",
    example: `{"toolCalls":[{"id":"gc1","name":"git_commit","parameters":{"message":"feat: add user search endpoint with cursor pagination","files":["server/src/routes/users.ts"]}}]}`,
    rules: [
      "ALWAYS run `list_changed_files` first to confirm what would be committed (or use git_status for a quick porcelain dump).",
      "Use Conventional Commits prefixes when the repo follows them: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`.",
      "If `files` is omitted, ALL staged changes are committed. Pass it to scope to a specific set.",
      "Don't commit `package-lock.json` or other auto-generated files unless the user wants them."
    ]
  }
};

// §4.x — Doc blocks for the new tools added in the upgrade plan.
// LLM-rendered documentation for: present_file, list_changed_files,
// add_task/update_task/list_tasks (now persistent), read_lints/run_tests
// (configurable), scheduler tools, render_widget, generate_image,
// create_document/read_document, browser_*, send_notification,
// send_email, mcp_list_servers/mcp_call_tool.

/**
 * Render the per-tool documentation section of the system prompt.
 *
 * Groups tools by category (using the ToolDefinition's `category` field),
 * prints the rich `TOOL_DOCS` entry for each, and falls back to the tool's
 * plain `description` for any tool not yet documented here.
 *
 * The output is intentionally a list of fenced code blocks + rule lists —
 * it stays scannable for the LLM and survives prompt caching well.
 */
export function renderToolDocs(
  tools: ReadonlyArray<{ name: string; description: string; category: string }>
): string {
  // Group by category, preserving the order categories first appear.
  const byCategory = new Map<string, Array<{ name: string; description: string }>>();
  for (const tool of tools) {
    const bucket = byCategory.get(tool.category) ?? [];
    bucket.push({ name: tool.name, description: tool.description });
    byCategory.set(tool.category, bucket);
  }

  const blocks: string[] = [];
  for (const [category, categoryTools] of byCategory) {
    blocks.push(`### ${category}`);
    blocks.push("");
    for (const tool of categoryTools) {
      const doc = TOOL_DOCS[tool.name];
      if (doc) {
        blocks.push(formatDoc(tool.name, doc));
      } else {
        // Fallback for undocumented tools — keeps the prompt working
        // even when a new tool ships before this map is updated.
        blocks.push(`- **${tool.name}** — ${tool.description}`);
      }
      blocks.push("");
    }
  }
  return blocks.join("\n").trimEnd();
}

function formatDoc(name: string, doc: ToolDoc): string {
  const lines: string[] = [];
  lines.push(`#### \`${name}\` — ${doc.summary}`);
  lines.push("");
  lines.push(`**When to use**: ${doc.whenToUse}`);
  lines.push("");
  lines.push("**Signature**: `" + doc.signature + "`");
  lines.push("");
  lines.push("**Example**:");
  lines.push("```json");
  lines.push(doc.example);
  lines.push("```");
  lines.push("");
  lines.push("**Rules**:");
  for (const rule of doc.rules) {
    lines.push(`- ${rule}`);
  }
  return lines.join("\n");
}

// §4.x — Doc blocks for the new tools added in the upgrade plan.
// LLM-rendered documentation for: present_file, list_changed_files,
// add_task/update_task/list_tasks (now persistent), read_lints/run_tests
// (configurable), scheduler tools, render_widget, generate_image,
// create_document/read_document, browser_*, send_notification,
// send_email, mcp_list_servers/mcp_call_tool.

const NEW_TOOL_DOCS: Record<string, ToolDoc> = {
  // §4.2
  present_file: {
    summary: "Surface workspace files as interactive cards in the chat.",
    whenToUse: "When you've produced or modified a file the user should examine. Pairs naturally with write_file / edit_file — call present_file in the same turn as the file operation so the user sees the result.",
    signature: "present_file({ files: [{ path, label?, description? }] })",
    example: `{"toolCalls":[{"id":"p1","name":"present_file","parameters":{"files":[{"path":"scripts/migrate.ts","label":"Migration script","description":"One-shot script that ports users to the new schema"}]}}]}`,
    rules: [
      "`path` is relative to the workspace root.",
      "Limit to ~12 files per call — split into multiple calls if you have more.",
      "Each card has open / copy-path action buttons. The user clicks them; you don't need to add anything else."
    ]
  },

  // §4.1
  add_task: {
    summary: "Add a task to the persistent agent task list (survives server restarts).",
    whenToUse: "When breaking down a multi-step task. Tasks persist in the database so the agent can resume across restarts.",
    signature: "add_task({ id: string, content: string, status?: \"pending\"|\"in_progress\"|\"completed\"|\"cancelled\" })",
    example: `{"toolCalls":[{"id":"t1","name":"add_task","parameters":{"id":"task-1","content":"Read existing auth handler","status":"in_progress"}}]}`,
    rules: [
      "`id` is opaque to you — use \"task-1\", \"task-2\", etc. The store auto-prefixes bare numbers.",
      "Pair with plan_tasks when creating the full plan in one go, or add_task incrementally as you discover sub-tasks."
    ]
  },
  update_task: {
    summary: "Update a task in the persistent task list.",
    whenToUse: "Mark a task in_progress when you start it, completed when done, or cancelled if it's no longer relevant.",
    signature: "update_task({ id: string, content?: string, status?: TaskStatus })",
    example: `{"toolCalls":[{"id":"t1","name":"update_task","parameters":{"id":"task-1","status":"completed"}}]}`,
    rules: [
      "Pass at least one of `content` or `status`.",
      "If the task id is unknown the error lists the available task ids — don't guess."
    ]
  },
  list_tasks: {
    summary: "List all tasks in the current conversation's task list.",
    whenToUse: "When resuming work or confirming what's left. Use the optional `status` filter to focus on a subset.",
    signature: "list_tasks({ status?: \"pending\"|\"in_progress\"|\"completed\"|\"cancelled\"|\"all\" })",
    example: `{"toolCalls":[{"id":"l1","name":"list_tasks","parameters":{"status":"pending"}}]}`,
    rules: [
      "Read-only. Does not modify any state.",
      "Returns a `summary` block with totals for each status — use that for the system context injection rather than counting the list yourself."
    ]
  },

  // §4.4
  list_changed_files: {
    summary: "List files that have been modified, added, deleted, or renamed in the workspace's git repo.",
    whenToUse: "Pre-commit workflow: instead of running `git status` and parsing output, call this for a structured list of changes. Pairs with git_commit for a complete commit workflow.",
    signature: "list_changed_files({ path?: string, includeUntracked?: boolean })",
    example: `{"toolCalls":[{"id":"l1","name":"list_changed_files","parameters":{"path":"src","includeUntracked":true}}]}`,
    rules: [
      "Returns `{ changes, summary }` — the `summary` has totals for staged / unstaged / untracked.",
      "Each change has `path`, `changeType` (\"modified\"|\"added\"|\"deleted\"|\"renamed\"|\"copied\"|\"untracked\"|\"type-changed\"), and `side` (\"staged\"|\"unstaged\"|\"untracked\")."
    ]
  },

  // §4.3 — updated docs
  read_lints: {
    summary: "Run lint diagnostics for the workspace.",
    whenToUse: "Before declaring a task done, run read_lints to surface any issues. Auto-detects the project type; pass `command` or `framework` to override.",
    signature: "read_lints({ workdir?: string, timeout?: number, command?: string, framework?: \"eslint\"|\"biome\"|\"ruff\"|\"flake8\"|\"pylint\"|\"rubocop\"|\"clippy\"|\"go-vet\" })",
    example: `{"toolCalls":[{"id":"l1","name":"read_lints","parameters":{"workdir":"server/src","framework":"eslint"}}]}`,
    rules: [
      "Returns a structured `parsed` summary (errors / warnings / firstErrors) alongside the raw output.",
      "The child process runs in a SANITIZED environment — database credentials and API keys are stripped."
    ]
  },
  run_tests: {
    summary: "Run the workspace's tests.",
    whenToUse: "After making changes, run tests to confirm nothing regressed. Auto-detects the project type and runner.",
    signature: "run_tests({ workdir?: string, timeout?: number, command?: string, framework?: \"vitest\"|\"jest\"|\"pytest\"|\"unittest\"|\"cargo\"|\"go\"|\"rspec\"|\"rake\"|\"maven\"|\"gradle\" })",
    example: `{"toolCalls":[{"id":"t1","name":"run_tests","parameters":{"workdir":"server","framework":"vitest"}}]}`,
    rules: [
      "Returns a structured `parsed` summary (pass/fail counts, first error lines) alongside raw output.",
      "The child process runs in a SANITIZED environment."
    ]
  },

  // §2.5
  render_widget: {
    summary: "Render an inline HTML/SVG widget in the chat (sandboxed iframe).",
    whenToUse: "When you want to show the user a visualization, table, or interactive diagram directly in the chat instead of describing it in prose.",
    signature: "render_widget({ title: string, html: string, data?: object })",
    example: `{"toolCalls":[{"id":"w1","name":"render_widget","parameters":{"title":"Migration plan","html":"<h2>Migration plan</h2><ol><li>...</li></ol>","data":{"steps":3}}}]}`,
    rules: [
      "The HTML is sanitized: <script> tags, on* event handlers, <iframe>/<object>/<embed>, and javascript: URLs are stripped.",
      "Inline styles work. CSS-only interaction is fine; for JS interaction the iframe is sandboxed so it can't reach the parent page.",
      "Pass `data` for any structured payload the widget needs — it's exposed as `window.__WIDGET_DATA__`."
    ]
  },

  // §2.4
  schedule_task: {
    summary: "Create a scheduled agent run (one-shot, interval, or cron).",
    whenToUse: "When the user wants a recurring check (\"every morning, run the linter and ping me if anything breaks\") or a delayed run.",
    signature: "schedule_task({ name, schedule: { kind: \"at\"|\"every\"|\"cron\", at?, everyMs?, expr?, tz? }, payload: { message, model?, mode? } })",
    example: `{"toolCalls":[{"id":"s1","name":"schedule_task","parameters":{"name":"daily-lint","schedule":{"kind":"cron","expr":"0 9 * * *","tz":"America/Los_Angeles"},"payload":{"message":"Run the linter and report failures","model":"gemini-2.5-pro"}}}]}`,
    rules: [
      "`schedule.expr` for cron is 5 fields (minute hour dom month dow). The scheduler ticks every minute.",
      "`schedule.kind: \"at\"` is one-shot — disabled after firing.",
      "Each fire creates a new conversation. The user can browse them in the sidebar."
    ]
  },
  list_scheduled_tasks: {
    summary: "List the user's scheduled tasks with their schedules and run history.",
    whenToUse: "Before creating a new one, to check name uniqueness. Anytime the user asks \"what's scheduled?\"",
    signature: "list_scheduled_tasks({ includeDisabled?: boolean })",
    example: `{"toolCalls":[{"id":"l1","name":"list_scheduled_tasks","parameters":{}}]}`,
    rules: [
      "Read-only. Includes run count, last run time, last error."
    ]
  },
  cancel_scheduled_task: {
    summary: "Permanently delete a scheduled task.",
    whenToUse: "When the user wants to stop a recurring task.",
    signature: "cancel_scheduled_task({ name: string })",
    example: `{"toolCalls":[{"id":"c1","name":"cancel_scheduled_task","parameters":{"name":"daily-lint"}}]}`,
    rules: [
      "Destructive — the task is deleted from the database, not just disabled."
    ]
  },

  // §2.3
  generate_image: {
    summary: "Generate an image from a text prompt and save it to the workspace.",
    whenToUse: "When the user asks for an image (logo, illustration, placeholder). Requires IMAGE_API_KEY or OPENAI_API_KEY; without one, a 1x1 placeholder PNG is written so the workflow can be tested end-to-end.",
    signature: "generate_image({ prompt, size?: \"256x256\"|\"512x512\"|\"1024x1024\"|\"1792x1024\"|\"1024x1792\", n?: 1|2|3|4, outputPath?: string })",
    example: `{"toolCalls":[{"id":"i1","name":"generate_image","parameters":{"prompt":"a serene mountain landscape at sunset","size":"1024x1024","outputPath":"assets/landscape.png"}}]}`,
    rules: [
      "`outputPath` is relative to the workspace root.",
      "The result is an OpenAI-compatible `/images/generations` call; works with DALL-E, Stability, and any compatible provider."
    ]
  },

  // §2.2
  create_document: {
    summary: "Generate a Word / HTML / plain-text document from Markdown.",
    whenToUse: "When the user wants a deliverable they can email or print — reports, READMEs, technical specs.",
    signature: "create_document({ title, content, format?: \"html\"|\"docx\"|\"txt\", outputPath?: string })",
    example: `{"toolCalls":[{"id":"d1","name":"create_document","parameters":{"title":"Q3 architecture review","content":"## Summary\\n...","format":"html","outputPath":"docs/q3-review.html"}}]}`,
    rules: [
      "Markdown subset: headings, bold, italic, lists, code, blockquotes, links.",
      "HTML output is self-contained (inline CSS) — opens in any browser without external dependencies."
    ]
  },
  read_document: {
    summary: "Read a text file from the workspace, with truncation.",
    whenToUse: "When you need to read a large file but want a hard cap on the response size.",
    signature: "read_document({ path, maxChars?: number })",
    example: `{"toolCalls":[{"id":"r1","name":"read_document","parameters":{"path":"docs/spec.md","maxChars":20000}}]}`,
    rules: [
      "Returns UTF-8 text only. .pdf / .docx return an error — convert with create_document or use a dedicated tool."
    ]
  },

  // §2.1
  browser_navigate: {
    summary: "Open a URL in a headless Chromium browser.",
    whenToUse: "When fetch_url is blocked or returns HTML you can't parse — the browser handles JS-rendered pages, auth redirects, etc.",
    signature: "browser_navigate({ url, waitUntil?: \"load\"|\"domcontentloaded\"|\"networkidle\"|\"commit\" })",
    example: `{"toolCalls":[{"id":"b1","name":"browser_navigate","parameters":{"url":"https://example.com/dashboard","waitUntil":"networkidle"}}]}`,
    rules: [
      "Page state is kept between calls in the same agent run — subsequent browser_click / browser_type act on this page.",
      "Requires `playwright` and chromium installed (`npx playwright install chromium`)."
    ]
  },
  browser_read: {
    summary: "Read content from the current browser page (text / HTML / title / screenshot).",
    whenToUse: "After browser_navigate, to extract the page content. `format: \"screenshot\"` saves a PNG to the workspace for visual review.",
    signature: "browser_read({ format?: \"text\"|\"html\"|\"title\"|\"screenshot\", selector?: string, maxChars?: number })",
    example: `{"toolCalls":[{"id":"b1","name":"browser_read","parameters":{"format":"text","selector":"main","maxChars":50000}}]}`,
    rules: [
      "Screenshots are saved to `.browser-screenshots/` in the workspace.",
      "CSS selector uses standard syntax. If no element matches, the error tells you."
    ]
  },
  browser_click: {
    summary: "Click an element on the current page.",
    whenToUse: "Driving a web UI: login, form submission, navigation.",
    signature: "browser_click({ selector, timeout?: number })",
    example: `{"toolCalls":[{"id":"b1","name":"browser_click","parameters":{"selector":"button[type='submit']"}}]}`,
    rules: [
      "If multiple elements match, the first is clicked. Use a more specific selector for precision."
    ]
  },
  browser_type: {
    summary: "Type text into an input or textarea on the current page.",
    whenToUse: "Filling out forms. Pass `submit: true` to press Enter after typing.",
    signature: "browser_type({ selector, text, submit?: boolean })",
    example: `{"toolCalls":[{"id":"b1","name":"browser_type","parameters":{"selector":"input[name='email']","text":"alice@example.com","submit":true}}]}`,
    rules: [
      "Clears the field first, then types. For appending use the underlying `fill()` via browser_evaluate."
    ]
  },
  browser_evaluate: {
    summary: "Run arbitrary JavaScript in the current page and return the result.",
    whenToUse: "For things the high-level tools can't do — read computed styles, interact with framework state, manipulate the DOM.",
    signature: "browser_evaluate({ expression: string })",
    example: `{"toolCalls":[{"id":"b1","name":"browser_evaluate","parameters":{"expression":"document.querySelectorAll('a').length"}}]}`,
    rules: [
      "The expression's last value is returned. For complex queries, assign to a variable: `const links = [...]; links.length`."
    ]
  },

  // §3.3
  send_notification: {
    summary: "Send a webhook notification to Slack / Discord / Teams / Telegram / a custom URL.",
    whenToUse: "When the user wants to be pinged on completion of a long-running task, or when the agent is done with a step they want to know about.",
    signature: "send_notification({ message, channel?: string, webhookUrl?: string, format?: \"plain\"|\"markdown\" })",
    example: `{"toolCalls":[{"id":"n1","name":"send_notification","parameters":{"message":"Migration complete. 12 files updated.","channel":"#engineering","format":"markdown"}}]}`,
    rules: [
      "Either `channel` (pre-configured name) or `webhookUrl` (one-off URL) is required.",
      "Slack / Discord / Teams payloads are auto-formatted; for custom URLs, a generic `{ message, format }` shape is used."
    ]
  },
  list_notification_channels: {
    summary: "List the user's configured webhook channels (names + metadata; URLs are not exposed).",
    whenToUse: "Before send_notification, to confirm the channel name. Also for the user to audit which channels exist.",
    signature: "list_notification_channels({})",
    example: `{"toolCalls":[{"id":"l1","name":"list_notification_channels","parameters":{}}]}`,
    rules: [
      "URLs are deliberately omitted from the response to avoid leaking them into the LLM context."
    ]
  },

  // §3.2
  send_email: {
    summary: "Send an email through a pre-configured SMTP account.",
    whenToUse: "When the user wants to email content (status update, file, summary) to one or more recipients.",
    signature: "send_email({ account, to, subject, body, isHtml?: boolean })",
    example: `{"toolCalls":[{"id":"e1","name":"send_email","parameters":{"account":"work","to":"alice@example.com","subject":"Status update","body":"All tests passing.","isHtml":false}}]}`,
    rules: [
      "SMTP credentials must be pre-registered in Settings → Integrations (provider=\"smtp\").",
      "No attachments in v1. Use a download link in the body if the user needs to receive a file."
    ]
  },

  // §3.1
  mcp_list_servers: {
    summary: "List the user's configured MCP servers and the tools each one exposes.",
    whenToUse: "Before mcp_call_tool, to discover the (server, tool) pairs available.",
    signature: "mcp_list_servers({ serverName?: string })",
    example: `{"toolCalls":[{"id":"m1","name":"mcp_list_servers","parameters":{}}]}`,
    rules: [
      "Returns per-server `tools` arrays (name + description + inputSchema).",
      "If a server is unreachable, it appears in the result with an `error` field and an empty `tools` list — not a hard failure."
    ]
  },
  mcp_call_tool: {
    summary: "Invoke a tool exposed by an MCP server.",
    whenToUse: "When you've identified a useful MCP tool (from mcp_list_servers) and need to call it.",
    signature: "mcp_call_tool({ server, tool, arguments?: object })",
    example: `{"toolCalls":[{"id":"m1","name":"mcp_call_tool","parameters":{"server":"github","tool":"list_issues","arguments":{"repo":"vercel/next.js","state":"open"}}}]}`,
    rules: [
      "`arguments` shape comes from the tool's `inputSchema` in mcp_list_servers.",
      "MCP servers can be flaky — wrap in `update_task` so retries are visible to the user."
    ]
  }
};

// Merge NEW_TOOL_DOCS into TOOL_DOCS so `renderToolDocs` picks them up.
// Done after the main map is defined to keep the file readable.
Object.assign(TOOL_DOCS, NEW_TOOL_DOCS);
