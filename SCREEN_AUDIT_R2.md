# Rapa — Screen & Feature Audit, Round 2 (Enriched)

**Date:** 13 September 2026
**Method:** Per-module cycle — code audit (bug re-check + *improvement opportunity* lens) → targeted web research against industry practice → notes. Builds on `SCREEN_AUDIT.md` (Round 1); R1 bug citations are referenced, not re-derived. Round 2 adds the layer R1 didn't cover: **gaps and room for improvement**, grounded in how comparable products solve the same problem.

Legend: 🔴 bug (from R1, still open) · 🟡 gap vs. industry practice · 🟢 improvement opportunity · 💎 quick win

---

## R2-1 · Login & auth

**Surface:** `login-page.tsx`, `hooks/use-auth.tsx`, `lib/http.ts` (+ server `auth.ts`).

**What exists:** JWT login with prefilled local account, zod error banner, animated brand layer, `autoComplete` attributes set correctly; token persisted in `localStorage` (`auth_token`); `GET /auth/me` verification on mount; 401 → logout + redirect in `api.ts`/`agent-api.ts`.

**Findings**

- 🔴 **No silent refresh.** Server exposes `POST /auth/refresh` (`auth.ts:66`) — zero frontend callers. 7-day JWT expiry hard-logs the user out mid-session; workspace API paths (`workspace-api.ts`, raw fetches in the file tree) don't even redirect on 401, they just toast generic errors. *(R1 §5/§3)*
- 🔴 **Boot verification logs out on transient failure.** `use-auth.tsx:39` — `.catch(() => logout())` destroys a valid token when `/auth/me` hiccups (server restarting, offline laptop). Industry pattern treats "can't verify" ≠ "invalid"; Rapa conflates them.
- 🟡 **Login friction without value in single-user mode.** The form ships prefilled with `local@localhost.com` — the app *knows* there is exactly one user. Every comparable local-first dev tool (Ollama, LM Studio, Backyard AI) skips credentials entirely or offers a one-click "continue" — a password field on a loopback-only app is pure friction and trains users to store a password they'll never need.
- 🟡 **Token in `localStorage`.** Standard XSS-exfiltration vector; `httpOnly` cookie or at minimum `sessionStorage` + short expiry would match the threat model of a personal tool. Low priority for loopback, but it contradicts the "hardening" posture documented elsewhere.
- 🟢 **Improvements, in order of impact:** (1) single-flight 401-interceptor refresh — on 401 call `/auth/refresh` once, queue concurrent retries, only redirect if refresh fails ([canonical pattern](https://stackoverflow.com/questions/51646853/automating-access-token-refreshing-via-interceptors-in-axios)); (2) proactive refresh on a timer keyed to JWT `exp` with clock-skew buffer, so mid-stream 401s never happen; (3) boot verification that distinguishes network-down (retry banner, keep token) from 401 (logout); (4) "Continue as local user" one-click button that autosubmits the prefilled credentials; (5) redirect authenticated users away from `/login`; (6) show-password toggle.

💎 Quick wins: the one-click local sign-in and the network-vs-auth distinction in `use-auth.tsx` are each ~10 lines.

---

## R2-2 · Chat message list + assistant markdown

**Surface:** `chat/message-list.tsx`, `assistant-markdown.tsx`.

**What exists:** Streaming with auto-scroll + scroll anchoring, per-message actions (copy/edit/fork/delete/regenerate), token stats, thought-tag collapsible, KaTeX math, GFM tables, code blocks with language label + copy + download, reconnect banner, pending indicator. Raw HTML is not enabled in react-markdown (default-safe against markdown XSS).

**Findings**

- 🔴 Carried from R1: "0 tok/s" on all restored history (`chat-utils.ts:247-252`); aborted chat messages lose their action footer; single-line fenced code demoted to inline (`assistant-markdown.tsx:29,51-57`); greedy `toolCalls` regex truncates trailing content (`:194-197`); thought panel expand changes height by only 32px (`h-40` vs `max-h-48`); banners undismissable; plan-handoff mode race.
- 🟡 **Whole-list re-render per stream chunk.** `MessageList` is `memo`'d but each chunk replaces the `messages` array, so *every* historical message re-diffs on every token. Sub-components (`UserMessageBubble`, `AssistantMessage`) are not individually memoized. [Chrome's LLM-rendering guidance](https://developer.chrome.com/docs/ai/render-llm-responses) and the [React community consensus](https://www.reddit.com/r/reactjs/comments/1nh05xb/) both call out "memoize completed blocks so only the streaming tail updates" as the baseline. At 50+ messages this is perceptible jank; the fix is per-item `React.memo` + splitting the live message into its own component fed by a separate state slot.
- 🟡 **Full markdown re-parse per chunk.** `assistant-markdown.tsx` re-parses the entire growing document on every `content` change. Purpose-built streaming parsers ([Streamdown](https://www.youtube.com/watch?v=y49LLJ1xFjU), incremental parsers) handle unterminated blocks (open ` ``` ` fences, half-written tables) gracefully — Rapa currently renders a streaming code fence as broken/inline text until it closes, which visually "jumps".
- 🟡 **No virtualization / pagination of long conversations.** Server caps restore at 500 messages; all render at once. Chat-scale products virtualize ([theme across sources](https://tigerabrodi.blog/how-to-build-a-performant-ai-markdown-renderer)). Rapa has "Load more" nowhere in the message area — old messages are simply unreachable beyond the cap.
- 🟢 **Regenerate with model switch.** R1 noted regenerate preserves the original model/provider. Every major chat UI (ChatGPT, Claude, Cursor) lets you regenerate *with a different model* — Rapa's model picker is right there; wiring `handleRegenerate(prompt, {model})` is low-effort, high-value.
- 🟢 **"Apply code block" action.** This is an IDE-adjacent product with workspace-bound writes, yet code blocks only offer copy/download. An "Apply to file…" affordance (choose file → `edit_file`-style insert/replace) would be a genuine differentiator and matches the product's own agent workflow.
- 🟢 **Honest stats:** show "≈" on estimated tokens (R1: `estimateTokens` presented as authoritative), and persist real usage from the server's `usage` object where available.
- 🟢 **Edit UX:** editing an assistant message is local-only with a bare "Save" — either remove assistant-message editing or label it clearly as a local annotation.

💎 Quick wins: per-message `React.memo` (one afternoon), model-override on regenerate, "≈" prefix on estimates.

---

## R2-3 · Composer (chat input, attachments, model/reasoning picker)

**Surface:** `chat-input.tsx`, `model-selector.tsx`.

**What exists:** Auto-growing textarea with drag-resize (min 120 / max 450px, ARIA separator), attachments via menu/paste/drag-drop with progress + size caps (12 files, 10MB each), image thumbs, send→stop morph, model dropdown with provider tiles + search + per-model reasoning-effort picker (verified working end-to-end in R1 runtime).

**Findings**

- 🔴 Carried from R1: input/attachments not cleared until the stream finishes (`handleSend` awaits `onSubmit` — freezes the composer for the whole generation); IME composition premature-send (no `isComposing` check); fabricated "Please analyze the uploaded files and images." pseudo-message; model-selector reset race can silently swap the selected model before the saved list loads.
- 🟡 **Latent 413 on multi-attachment.** Attachments are base64-inlined into the `/chat/stream` JSON; `bodyLimit` is 25MB (`server/src/index.ts:54`) but 12×10MB files ≈ 36MB base64 → Fastify rejects with a raw `FST_ERR_CTP_BODY_TOO_LARGE` the UI doesn't map to a friendly message. Either compute base64 size client-side and warn, or (better) move to a real upload endpoint with workspace-scoped storage.
- 🟡 **No `@`-mentions of workspace files.** [assistant-ui's mentions pattern](https://www.assistant-ui.com/docs/guides/mentions) and the [AI chat playbook](https://aiuxplayground.com/guides/ai-chat-playbook) both treat `@`-context (files, prior chats) as the standard way to scope a prompt in coding products. Rapa has a *workspace* + file tree + go-to-file index — the raw material for `@src/lib/api.ts`-style context pinning exists but isn't wired into the composer.
- 🟡 **No slash commands.** Mode switching (chat/agent/plan) lives only in the top bar; [`/plan`, `/agent` slash commands](https://www.aydesign.ai/blog/ai-prompt-input-ui-design-patterns-2026) with a popover would make mode reachable without leaving the keyboard.
- 🟢 **Queued prompts while streaming.** Today submits are locked during a run (R1's quadruple guard). Standard practice is a visible "queue" state — the message renders dimmed under the streaming one and fires on completion — instead of a silent no-op.
- 🟢 **Prompt history recall** (↑ / ↓ through recently sent prompts) — cheap, expected by power users.
- 🟢 **Attachment thumbnails** for images (chips exist; thumbnails would match [ShapeofAI's attachments pattern](https://www.shapeof.ai/patterns/attachments) of making scope visible).
- 🟢 Reasoning picker: show a one-line explanation of the *hovered* level (currently describes only the selected one) and persist per-conversation (it does persist via `reasoningEffort` column — good; document it).

💎 Quick wins: clear-before-await in `handleSend`, `isComposing` guard, client-side base64 size guard with friendly error, ↑ recall.

---

## R2-4 · Sidebar (conversations, workspaces, settings nav)

**Surface:** `sidebar.tsx` (1,318 lines: history list, Workspaces modal, provider/settings nav, theme toggle, logout).

**What exists:** Cursor-paginated history ("Load More"), client-side title filter, per-row rename/delete dropdown, Delete-All with confirm, running-agent pulse dot + "running" pill, message-count tooltips, Workspaces modal (list/create via native folder picker/remove/switch with conversation-bound guard), running/pending-approval badges.

**Findings**

- 🔴 Carried from R1: rename/delete/delete-all have **no catch** — silent failures with the dialog stuck; a transient poll error **wipes the visible history list**; Delete-All confirm shows the loaded page count (≤50), not the true total, for a non-undoable action; search covers only loaded pages and hides "Load More" while searching; pagination position resets after any mutation.
- 🟡 **Search should be server-side.** Rapa's search filters loaded titles only — conversations beyond page 1 are unreachable while searching, which is precisely the moment users need them. [UX research on chat history](https://trevorcalabro.substack.com/p/the-rules-of-ai-chat-history) frames history as "scannable interaction records"; [the permalink-problem essay](https://uxdesign.cc/the-permalink-problem-in-ai-chat-1f1579ec991c) adds that retrieval is the whole point. The server has Prisma `contains` available; a `GET /conversations?q=` endpoint + debounced query is the standard fix.
- 🟡 **No time grouping.** Every major chat product groups by Today / Yesterday / Previous 7 days / Older. Rapa renders a flat list with only message-count badges — cheap win, big scanability gain.
- 🟡 **No pinning/favorites and no per-workspace filter.** With workspaces as a core boundary, a "this workspace only" toggle on history would let the sidebar answer "what have I done on project X" — currently only the Workspaces modal shows per-workspace conversation counts.
- 🟢 **Infinite scroll vs. Load More:** [current practice favors](https://www.reddit.com/r/webdev/comments/1r8tu0g/ux_dilemma_pagination_vs_infinite_scroll_for_a/) auto-loading on scroll-end for chat sidebars; "Load More" is acceptable but should keep position after mutations (it doesn't).
- 🟢 **Rename inline** (double-click on the title) instead of a modal prompt-style flow, matching list-editing conventions everywhere.
- 🟢 **Empty state onboarding:** fresh install shows two example conversations for demo data; a first-run empty state with 3 starter prompts ("Explore this codebase", "Plan a feature", "Fix a bug") would activate the three modes better than a blank "How can I help you today?".
- 🟢 Delete-All: require typing a phrase (the app already has this pattern in checkpoint restore) and show the true count from a `COUNT` endpoint.

💎 Quick wins: server-side search endpoint + debounced query; time grouping; catch + toast on rename/delete.

---

## R2-5 · Top bar + mode system (Chat/Agent/Plan) + export

**Surface:** `top-bar.tsx`, mode state in `routes.tsx`/`use-chat-stream.ts`, `handleExport` in `routes.tsx:602-694`.

**What exists:** Mode toggle with workspace-gated Agent/Plan, workspace chip (conversation-bound takes precedence), search/export/terminal buttons, per-conversation workspace restore, markdown export including agent steps/thinking/tool I/O.

**Findings**

- 🔴 Carried from R1: mode buttons have no `aria-pressed`; Ctrl+K tooltip dead while typing; the **plan→agent handoff executes in plan mode** (stale closure); export strips only `<think>` while the renderer hides four tag variants (exported markdown leaks thought blocks); always-on History highlight.
- 🟡 **Plan mode is a toggle, not a workflow.** The industry pattern ([Claude Code](https://nimbalyst.com/blog/claude-code-plan-mode/), [Cursor](https://github.com/zed-industries/zed/discussions/34436), [analysis by Ronacher](https://lucumr.pocoo.org/2025/12/17/what-is-plan-mode/)) is: read-only exploration → **plan as a reviewable artifact** → explicit approval → execute, with post-approval paths (auto-accept all / approve per step). Rapa has the read-only allowlist (`plan-mode-state.ts`) and a task list, but the "plan" is just chat text; the only execute path is the broken handoff button. A persisted plan artifact (the `AgentTask` model already exists!) with "Execute plan" + per-step approve/auto-accept would complete the loop the toggle implies.
- 🟡 **Read-only guarantee has a known hole.** Practitioners [document that write-bans must also watch shell escape hatches](https://www.reddit.com/r/PiCodingAgent/comments/1tvguq9/how_to_make_agent_readonly/) (`bash` can write files). Rapa's plan allowlist should be verified against `execute_command`-class tools — if shell is allowed at all in plan mode, it needs write-pattern gating ([Anthropic's tiered allowlist writeup](https://www.anthropic.com/engineering/claude-code-auto-mode) is the reference design).
- 🟢 **Mode discoverability:** the toggle shows three monogram buttons; a tooltip per mode ("Agent can edit files & run commands in {workspace}") would teach the boundary — the workspace chip and mode toggle are the two most important context signals and currently don't reference each other.
- 🟢 **Export upgrades:** JSON export (lossless, re-importable), "copy transcript", and fork-aware export (export only the current branch). The current exporter walks `agentSteps` well but caps tool output at 2,000 chars silently — mark truncations explicitly.
- 🟢 **Workspace chip:** clicking it when a *conversation-bound* workspace is active should offer "switch back to active workspace" — currently the guard blocks switching with a toast, and the escape hatch is non-obvious.

💎 Quick wins: `aria-pressed` on mode buttons; fix the handoff mode race (explicit `mode` override — same fix as R2-2's regenerate); strip all four thought-tag variants on export.

---

## R2-6 · Agent run trace (steps viewer, tool cards, approvals, task list)

**Surface:** `agent-steps-viewer.tsx` (1,119 lines), `task-list.tsx`, approval flow in `use-chat-stream.ts` + server `agent.ts`.

**What exists:** Inline collapsible tool cards with ProgressRing status, phase labels ("Editing…", "Awaiting approval"), inline Approve/Reject, diff badges → DiffDialog, expandable outputs (images, fetch markdown, search hits, params JSON), reasoning panels, TaskList extraction from `add_task`/`update_task`, run summary strip. This is Rapa's strongest surface — it already follows the [structured inline tool-card pattern](https://www.eleken.co/blog-posts/agentic-ux-examples) the ecosystem converged on.

**Findings**

- 🔴 Carried from R1: nested `<button>` in card headers (invalid HTML); pending approvals vanish on reload while the run stays blocked server-side; `workspacePath` never forwarded; N+1 `getAgentRun` per message; checkpoint-restore panel and run-comparison dialog unreachable.
- 🟡 **Approvals don't survive reload — industry treats them as resumable state.** The canonical HITL loop ([Microsoft AG-UI](https://learn.microsoft.com/en-us/agent-framework/integrations/by-component/ui/ag-ui/human-in-the-loop), [Vercel AI SDK](https://ai-sdk.dev/cookbook/next/human-in-the-loop)) persists the pending tool call server-side and re-presents it after reconnect. Rapa's approvals live in an in-memory Map with no GET endpoint; a page refresh mid-approval orphans the run. Persisting `approvalId` on the `AgentToolCall` row and rehydrating on conversation load is the fix.
- 🟡 **No progressive trust in the approval prompt.** Claude Code's model is per-call → allow-list → auto mode, with the allow-list offer *inside* the prompt ([auto-mode writeup](https://www.anthropic.com/engineering/claude-code-auto-mode), [/fewer allow-list](https://www.mindstudio.ai/blog/claude-code-fewer-permission-prompt-allow-list)). Rapa has all three tiers — but the `AutoApprovePattern` table (server model, routes exist) has **zero frontend**: the approval card can't offer "always allow `npm test`". Adding a checkbox to the inline approval that POSTs a pattern closes the loop the backend already built.
- 🟡 **No per-step cost/token visibility.** Observability platforms ([Datadog LLM observability](https://docs.datadoghq.com/llm_observability/quickstart/terms/), [span-tree traces](https://www.reddit.com/r/LocalLLaMA/comments/1quf6iv/i_built_an_opensource_observability_tool_for_ai/)) treat per-step tokens/cost/duration as the core trace payload. Rapa tracks usage at run level only (`UsageRecord`); surfacing per-iteration tokens in the step header would make "why did this run cost 300K tokens" answerable in-UI.
- 🟢 **Parallel tool-call grouping:** read-only tools execute in parallel server-side, but the trace renders them as a flat sequential list — grouping concurrent calls (or at least preserving server order + a "parallel" badge) would represent what actually happened.
- 🟢 **Task list ↔ plan:** TaskList derives from tool results only; when a run ends with unchecked tasks there's no "resume remaining tasks" affordance — the natural continuation entry point.
- 🟢 a11y: `aria-expanded` on card headers, status text for ProgressRing states (color+animation only today).

💎 Quick wins: persist + rehydrate approvals; "always allow this pattern" checkbox wired to the existing `AutoApprovePattern` API; fix nested buttons (CSS, not `<button>` nesting).

---

## R2-7 · Ask-user cards + mode-switch prompts

**Surface:** `interactive-options.tsx`, `mode-switch-prompt.tsx`, heuristic fallbacks in `chat-utils.ts`.

**What exists:** Batched multi-question cards with 2-N selectable options, "rec" recommended badge, multi-select, per-option descriptions + preview panes, "Other" free-text fallback, aggregate Submit with all-answered gating, post-submit lockout. This closely matches the [emerging de-facto pattern](https://github.com/warpdotdev/warp/issues/8519) (Claude Code's `AskUserQuestion`: header + 2–4 options, [now documented in Spring AI too](https://spring.io/blog/2026/01/16/spring-ai-ask-user-question-tool)) — genuinely current design.

**Findings**

- 🔴 Carried from R1: cards re-render **unanswered on old messages** (component-local `submitted` state) and can be re-submitted; mode-switch prompts render on all history with live approve buttons; single-question single-select auto-submits on first click (misclick = committed answer); fragile "Other" label regex can misclassify legitimate options.
- 🟡 **Answered-state should be persisted, not component-local.** The interactive payload is already persisted in message metadata (`chat-utils.ts:254`) — adding an `answered` flag on submit (one PATCH or a follow-up metadata write) makes the lockout survive reloads, which every product implementing this pattern treats as table stakes.
- 🟡 **Scope: latest-message-only rendering.** [Timing research](https://dl.acm.org/doi/10.1145/3803784.3816856) and the [clarify-once guidance](https://towardsdatascience.com/when-rag-users-ask-vague-questions-clarify-once-learn-the-default/) both argue clarifications belong at the point of decision — rendering stale questionnaires mid-history invites accidental submissions into the *current* conversation. Gate on `isLatestAssistant` like the plan handoff already does (`message-list.tsx:430`), and collapse old ones to a read-only "answered · 3 questions" summary chip.
- 🟢 **Two-phase confirm:** replace instant-submit with an explicit Submit that shows a one-line answer summary ("Architecture & Design · Entire Codebase · Understand risks") — protects against the misclick without losing speed.
- 🟢 **Drop or demote the regex heuristics.** `looksLikeWorkspaceRequest` matches any prompt containing "workspace/repo/codebase" and can push a spurious mode-switch card; the server-driven `mode_switch` payload already covers the real cases. False-positive agent cards erode trust in the real ones.
- 🟢 Mode-switch cards: show the *reason* payload (`explanation` exists) prominently and include the original prompt preview (it does) — good; add "edit before switching" (prefill composer with the prompt in the target mode) instead of blind resubmit.

💎 Quick wins: `isLatestAssistant` gating (few lines, eliminates the whole stale-submission class); persist an `answered` flag next to the existing metadata write.

---

## R2-8 · Right sidebar (Tool History / Workspace Files / Agent Plan)

**Surface:** `right-sidebar.tsx`, `tool-history-drawer.tsx`, `workspace-file-tree.tsx` (files tab host), `task-list.tsx` (plan tab).

**What exists:** Icon-rail with three tabs, pulsing activity dot on Plan while the agent works, auto-switch to Plan on new tasks, Escape to close, per-tool expandable history entries with category chips + ok/fail stats, file tree, task progress.

**Findings**

- 🔴 Carried from R1: after the Escape/close path the sidebar **cannot be reopened** (no TopBar toggle; only a page reload restores it); collapse state resets (component-internal, unmounts on close); the activity dot flickers between iterations (`liveToolCalls` cleared per step); auto-switch yanks the user to Plan mid-read.
- 🟡 **Panels should remember their state.** [VS Code's layout contract](https://code.visualstudio.com/docs/configure/custom-layout) is that secondary-sidebar visibility/arrangement persists across sessions — the baseline expectation for any IDE-style product. Rapa's tab + collapsed state are ephemeral; one `localStorage` write in `agent-settings`-style persistence fixes it. Also add a TopBar rail toggle so "reopen" exists at all ([VS Code treats the secondary sidebar as auxiliary-but-reachable](https://code.visualstudio.com/api/ux-guidelines/sidebars)).
- 🟡 **Tool history should be searchable and linked.** The converging pattern in AI-IDEs is [searchable session history with per-session tool timelines](https://code.visualstudio.com/docs/agents/run/sessions/session-history). Rapa's drawer has category filter chips (good) but no text search, no jump-to-message link from a history entry, and [Claude Code's own issue tracker articulates why](https://github.com/anthropics/claude-code/issues/40557) sidebars beat tabs for history at scale: scanability. Entries already carry `msg#` — a "show in conversation" link is nearly free.
- 🟡 **Timeline grouping over flat list.** Entries render chronologically but ungrouped; [timeline best practice](https://uxpatterns.dev/patterns/data-display/timeline) for execution logs is grouping by iteration/step with duration per group — Rapa has `iter` metadata to do this today.
- 🟢 **"Working" indicator:** use the stable signal (`pending && last-message-is-assistant`, as in message-list) instead of the flickering `liveToolCalls` one — two definitions of "agent active" already coexist.
- 🟢 Failed-count accuracy (`success:false` without error string isn't counted) and structured `data` results invisible in the drawer (visible in trace cards) — align the two.

💎 Quick wins: TopBar reopen toggle + persisted tab/collapsed state; jump-to-message links from history entries.

---

## R2-9 · Workspace IDE (file tree, file viewer, command palette, terminal)

**Surface:** `workspace-file-tree.tsx` (2,416 lines), `file-viewer.tsx`, `command-palette.tsx`, `terminal-dialog.tsx`/`terminal-view.tsx`.

**What exists:** Full CRUD tree (create/rename/duplicate/delete/bulk ops/multi-select), filter-as-you-type, recent files, hover stat tooltips, extension color coding, hidden-entry list, reveal-in-explorer, markdown preview with raw toggle, server-backed go-to-file + find-in-files, multi-tab PTY terminal with cwd-pinned tabs, session persistence across minimize/conversation switches.

**Findings**

- 🔴 Carried from R1 (the module's bug cluster): **download always 401s** (auth-protected `/raw` via anchor); `present_file`/`render_widget` invisible; "Search in folder" stub (`workspace:search-in` has no listener); Ctrl+P/Find-in-Files dead when the right sidebar is collapsed; tree selection inheritance bug; filter wipes expansion state; images open as mojibake; terminal `closed` → auto-respawn; terminal crash vector (spawn with nonexistent cwd kills the backend — this round's outage).
- 🟡 **No tree virtualization.** The tree renders every expanded node recursively — [every production reference implementation](https://replit.com/blog/filetree-updates) ([react-arborist](https://mmengineering.com.pl/en/uncategorized/react-arborist-build-fast-tree-views-file-explorers/), [TanStack Virtual](https://fairdataihub.org/blog/file-explorer-guide), [MUI Pro](https://mui.com/x/react-tree-view/rich-tree-view/virtualization/)) virtualizes and lazy-loads children on expand. `node_modules` is hidden by name, but one `dist`-heavy monorepo will freeze the panel. The server already returns a bounded tree; client-side windowing is the fix.
- 🟡 **Files open in a modal, not tabs.** Rapa's viewer is a dialog; the IDE convention ([VS Code](https://code.visualstudio.com/docs/editing/getting-started/userinterface), [with overflow pickers for many tabs](https://github.com/microsoft/vscode/issues/7987)) is persistent editor tabs in the files panel with dirty indicators. At minimum: "open in split view beside the tree" and remembering open files per workspace (recent files is a good substitute — promote it to a session-restored tab strip).
- 🟡 **Image previews need a real path.** Standard practice is auth'd blob URLs (`fetch` + `URL.createObjectURL`) — which also fixes download in one move ([lazy-loading guidance](https://web.dev/articles/browser-level-image-lazy-loading) for thumbnails in tree rows). This is the highest-leverage single fix in the module: download, image preview, and `present_file` rendering all unblock with an authed `blob:` helper.
- 🟢 **Palette polish:** "no workspace" state (currently misleads with "start typing"), line-jump after find-in-files (toast-only today), respect the tree's dotfile rules so Ctrl+P and the tree agree.
- 🟢 **Terminal:** advertise Ctrl+` to *open* (register globally, not just when open), suppress auto-respawn on `closed` (require explicit re-connect), and surface the stale-workspace case ("workspace directory no longer exists — pick another") instead of a bare error strip. That last one would have prevented this round's backend outage UX-wise.
- 🟢 a11y: tree rows need `aria-expanded`/`role="treeitem"`; terminal tab rail needs `role="tablist"` + keyboard nav ([Replit's rebuild](https://replit.com/blog/filetree-updates) treats a11y as a headline feature of a filetree).

💎 Quick wins: authed blob-URL helper for `/raw` (fixes download + image preview at once); global Ctrl+` open; no-workspace palette state.

---

## R2-10 · Settings — provider page + add custom provider

**Surface:** `settings-page.tsx` (1,036 lines), `add-custom-provider.tsx`.

**What exists:** Per-provider enable toggle, multi-key management (add/name/reveal/copy/edit/delete/set-active, inactive-key accordion), automatic fallback (key rotation), Test-active-key, base-URL editing with debounced autosave, model list CRUD + Refresh/Merge from upstream, presets on the custom-provider form.

**Findings**

- 🔴 Carried from R1: auto-save silently commits **staged** state (disabled toggle, pasted-but-not-added key); destructive "Refresh" (replaces whole model list) has no confirmation; "How It Works" references a Save button that doesn't exist; production icon 404s; OpenRouter preset slug collides with the built-in; custom providers are un-deletable (endpoint exists, UI doesn't).
- 🟡 **vs. the reference standard ([Stripe's keys page](https://docs.stripe.com/keys)):** Rapa has create/reveal/rotate/test — the missing pieces are **key metadata and health**: last-used timestamp, last error, per-key status ("working ✓ / rate-limited / 401"). The usage pipeline already records per-run provider data; surfacing "last used Aug 15 · last error: 429" next to each key turns rotation from guesswork into maintenance. ([Rotation-lifecycle guidance](https://zuplo.com/learning-center/api-key-rotation-lifecycle-management) makes the same point about audit trails.)
- 🟡 **Staged-vs-saved ambiguity is the core UX bug.** The page mixes two models (explicit Save for the enable toggle, autosave for base URL/models/keys) and the payload leaks staged state into autosaves. Industry settings pages pick one model per section and visually mark unsaved changes (dirty dot on the toggle). Splitting the enable toggle into its own immediate-persist section eliminates the whole class.
- 🟢 **Fallback visibility:** when automatic fallback rotates keys mid-run, the chat surface shows ApiKeySwitchBanner (good) — but the provider page should also log rotation events ("key 2 promoted at 14:32") so users can prune dead keys.
- 🟢 **Model list:** show per-model metadata where the provider returns it (context window, reasoning support — the reasoning-profile data already exists server-side) and badge models that were auto-added by Merge vs. hand-added.
- 🟢 **Add-provider:** validate base URL client-side (format + reachability probe button like Test-active-key), avoid the full `window.location.reload()` on success (refetch providers instead), and suffix preset slugs (`openrouter-custom`) to prevent the collision.

💎 Quick wins: confirm dialog on Refresh; delete button for custom providers; dirty-dot on the enable toggle.

---

## R2-11 · Settings — agent settings + specialists

**Surface:** `agent-settings-page.tsx` + `agent-settings-panel.tsx` (localStorage-backed), `agent-specialists-page.tsx`.

**What exists:** Max-iterations slider (1–80), auto-approve category checkboxes (filesystem/shell/web/system/code), show-thinking toggle; specialists page with 5 built-ins, override editing (description/instructions/when-to-use/suggested-tools), Save Override / Use Built-In, custom specialist drafts.

**Findings**

- 🔴 Carried from R1: the **baseline auto-approve set (13 tools incl. `mkdir`, `git_*`) is invisible and undisableable** from the UI — the checkboxes show all-unchecked while a substantial default allowlist ships; "Use Built-In" leaves a zombie disabled row + permanent stale badge; no way to delete custom specialists; rename collisions break the editors.
- 🟡 **Show the effective permission set, not just deltas.** The [VS Code approvals model](https://code.visualstudio.com/docs/agents/run/approvals) presents the *resulting* permission level, and the [stakes × reversibility framework](https://medium.muz.li/when-should-an-ai-agent-ask-for-permission-a-ux-framework-for-trust-and-control-231f6c06e505) argues users calibrate trust against concrete actions ("`npm test` runs without asking"), not category names. One sentence under the checkboxes — "13 tools always run without approval: read_file, list_directory, git_status…" with a "review" expander — converts a hidden default into an inspectable one ([transparency patterns](https://www.telerik.com/blogs/ai-ux-patterns-user-transparency)).
- 🟡 **Settings are machine-local.** Max iterations + auto-approve live in `localStorage` while everything else (rules, skills) is server-persisted — switching machines silently reverts agent behavior. The server already has `/agent/auto-approve-patterns` storage; moving these two settings there is mostly plumbing.
- 🟢 **Iteration budget deserves context:** show last-run stats next to the slider ("last run used 23 iterations · stopped at plan completion") so 80 is an informed choice, not a guess.
- 🟢 **Specialists:** (1) fix Use-Built-In by deleting the override row (needs the missing `DELETE /agent/skills` route); (2) show *usage* per specialist ("activated 4× in the last 10 runs") — the catalog is config-only today with zero feedback that specialists do anything; (3) a "test this specialist" button that runs a sample prompt through `delegate_task` would make the page self-verifying.

💎 Quick wins: effective-permissions expander under auto-approve; `DELETE /agent/skills` + real Use-Built-In; confirm-delete for custom specialists.

---

## R2-12 · Settings — web search (service keys) + appearance

**Surface:** `service-keys-settings.tsx`, `appearance-page.tsx`.

**What exists:** Serper key management mirroring the provider pattern (add/reveal/copy/edit/delete/active/fallback), web-search enable/pause switch; Appearance with light/dark/system tri-state, 6 accent swatches, text-size, density, reset.

**Findings**

- 🔴 Carried from R1: the web-search **pause switch has no backend** (pure `useState`, resets on remount, never affects the agent) while the copy promises exactly that; **accent color, text size, and density are all inert** — CSS variables with zero consumers; stored "system" theme degrades to explicit dark after reload (`use-theme.tsx:61-64`); Reset hardcodes dark; hardcoded "Toggle" section header.
- 🟡 **Theme: right structure, broken persistence.** The light/dark/system tri-state matches [current best practice](https://www.orizon.co/blog/dark-mode-vs-light-mode-ux-best-practices-tokens-toggles-and-accessibility) (default to system, remember overrides) — but the boot script resolves "system" into a concrete class and `use-theme` then reads the *resolved* value back, losing the preference. Store the raw mode separately from the resolved one.
- 🟡 **Accent colors need token plumbing + contrast validation before they're wired.** If/when `--accent-color` gets consumers, each swatch must clear WCAG 4.5:1 against *both* light and dark backgrounds ([checkers](https://webaim.org/resources/contrastchecker/); see also [the dark-yellow problem](https://uxdesign.cc/the-dark-yellow-problem-in-design-system-color-palettes-a0db1eedc99d) for auto-deriving accent variants). The honest options today: wire the variable into the existing `accent-*` tokens (medium effort), or remove the control until then — a dead control on a settings page is worse than no control ([user-choice philosophy](https://www.smashingmagazine.com/2023/08/css-accessibility-inclusion-user-choice/)).
- 🟢 **Service keys:** add Test-connection parity with the provider page (a `/service-keys/test` endpoint that hits Serper's 1-cent search) — the pattern exists 1 tab away; fix the hardcoded "Web Search" heading to use `SERVICE_META` so a second service doesn't ship two heading styles.
- 🟢 Consider honoring `prefers-contrast`/`forced-colors` once tokens are semantic ([MDN reference](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-contrast)) — free accessibility win on a token-based system.

💎 Quick wins: either wire or remove the three dead appearance controls (removal is a 30-minute honest fix); persist raw theme mode; give the pause switch a backend or remove it.

---

## R2-13 · Settings — usage analytics

**Surface:** `usage-analytics-page.tsx` (993 lines).

**What exists:** KPI cards, 24-week GitHub-style heatmap with tooltips + Today marker, provider donut + legend, chat-vs-agent split, prompt/completion composition chart, top-models bar chart + leaderboard, provider/model tables with last-active, token-accuracy footnote. Solid scope for a personal tool — the layout answers "where did my tokens go" well.

**Findings**

- 🔴 Carried from R1: `huggingface`/`openrouter`/custom providers render as raw ids with fallback colors (label/color map gaps); two different "Total tokens" scopes share one label (all-time header vs 24-week heatmap); title-only tooltips (not keyboard/AT accessible).
- 🟡 **No cost view.** Every reference dashboard ([Telerik](https://www.telerik.com/ai-engineering/cost-token-usage), [Broadcom's LLM cost dashboard](https://techdocs.broadcom.com/us/en/ca-enterprise-software/it-operations-management/dx-operational-observability/saas/dashboards/all-dashboards/Out-of-the-Box-Dashboards/genai-and-llm-observability-dashboards/llm-cost-and-token-usage-dashboard.html), [Braintrust's attribution playbook](https://www.braintrust.dev/articles/how-to-track-llm-costs-2026)) treats **dollars as the primary metric**, with tokens as the underlying unit. Rapa already persists model + tokens per run; a static per-model price table (editable, since local/custom models vary) converts the existing charts to cost with one multiplication. "You spent $4.12 this month" is the sentence users actually care about.
- 🟡 **No date-range filter or refresh.** Data is fetched once on mount with a fixed 24-week window ([standard practice](https://jellyfish.co/library/ai-token-usage-monitoring/) is a range selector + auto-refresh). Add 7d/30d/24w presets and a manual refresh button.
- 🟢 **Attribution drill-down:** click a provider/model row → filtered conversation list (the data model supports it via `UsageRecord`); answers "which chats burned 30M tokens on Aug 15" in two clicks.
- 🟢 **Spike annotation:** the heatmap already renders the 31M-token outlier day; linking it to that day's conversations (same drill-down) turns a pretty chart into a debugging tool.
- 🟢 Fix the label-map gaps (3 lines), qualify the header "Total tokens (all time)", and swap `title` tooltips for a real tooltip component (the design system has Radix tooltip available).

💎 Quick wins: label map + "all time" qualifier + refresh button (under an hour total); cost view is the strategic upgrade.

---

## R2-14 · Cross-cutting (accessibility, error UX, design system)

**Surface:** all modules; `error-boundary.tsx`, `use-keyboard-shortcuts.ts`, token system in `theme.css`.

**Findings**

- 🟡 **Custom dropdowns don't follow the APG combobox contract.** The model selector, effort picker rows, and terminal tab rail are divs with `onClick` — no roles, no arrow-key navigation, no Escape, no `aria-expanded`/`aria-controls`, no result announcements. The [W3C APG combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/) defines the expected keyboard/AT behavior ([common pitfalls](https://accessibility.build/guides/accessible-combobox) map 1:1 onto Rapa's gaps). The cheap path: Rapa already ships Radix — rebuilding the model dropdown on Radix `DropdownMenu`/`Popover` inherits the entire contract for free instead of hand-rolling it.
- 🟡 **Error UX is silent-or-stuck.** The failure modes cluster: silent catches (sidebar rename/delete), undismissable banners (API-key-switch, error), raw Fastify errors surfaced verbatim (413 attachments, 401 workspace calls), and one root-only error boundary so a single bad message (e.g., a KaTeX edge case) blanks the entire app. Pattern to adopt: per-message error boundary + a standard toast/banner taxonomy (dismissable, with retry where a retry makes sense).
- 🟡 **Keyboard layer needs an input-aware policy.** Today *all* shortcuts die in inputs (Ctrl+K/N/\\ are dead where users type; Ctrl+P leaks to Print). Convention: non-conflicting combos (Ctrl+K, Ctrl+P with `preventDefault`) work in inputs; only text-entry keys are excluded. One condition change in `use-keyboard-shortcuts.ts` fixes four shortcuts.
- 🟢 **Design system:** the Engineering Blueprint is consistently applied on every *live* agent surface (verified across all four R1 audit groups) — deviations (`text-purple-400`, hardcoded hex in ErrorBoundary, DiffDialog's green/red vs DiffView's B/W, terminal's hardcoded dark palette) all live in dead or standalone components. Cleanup naturally follows the wire-or-delete decisions from R1.
- 🟢 **Live-region coverage:** streaming assistant text relies on `aria-live="polite"` on the log container (present — good), but tool-call status changes, approvals needed, and run completion are visual-only; three surgical `role="status"` announcements would make agent runs usable non-visually.

---

## R2 Synthesis — what changed since Round 1

Round 1 established *what's broken* (14 P1 bugs, 4 dead screens, ~45 P2s). Round 2's research pass adds the strategic layer:

1. **Rapa's best surfaces are genuinely current.** The batched ask_user cards match the emerging Claude-Code-style `AskUserQuestion` pattern; inline tool-trace cards match the ecosystem's structured-card convergence; the plan-mode allowlist mirrors Anthropic's tiered design. The gap is never the pattern — it's *completion*: answers don't persist, approvals don't survive reloads, plans don't become executable artifacts.
2. **The recurring root cause is unwired backend capability.** `AutoApprovePattern` (no UI), `/auth/refresh` (no caller), `/agent/runs/:id/abort` + Exit Hatch (no UI), checkpoint restore (dead screen), `deleteCustomProvider`, `DELETE /agent/skills` (missing route blocks three fixes). A "wire the orphaned backend" initiative would close ~8 findings across 6 modules.
3. **Top 10 by impact (R2 lens):** ① silent token refresh, ② plan artifact + working execute handoff, ③ approval persistence + progressive-trust checkbox, ④ per-message memoization in the chat list, ⑤ authed blob-URL file helper (download+images+present_file), ⑥ @-file mentions in the composer, ⑦ cost view in analytics, ⑧ model-override regenerate, ⑨ Radix-based model dropdown (a11y), ⑩ wire-or-delete the four dead screens.
4. **Per-module quick wins** (each ≤ half a day): login one-click, `isComposing` guard, input clear-before-await, server-side conversation search, time grouping, `aria-pressed`/`aria-expanded` passes, effective-permissions expander, heatmap label fixes, theme-mode persistence, global Ctrl+`.

*Every web-grounded claim above links its source inline. Bug citations (🔴) carry their R1 file:line references in `SCREEN_AUDIT.md`.*
