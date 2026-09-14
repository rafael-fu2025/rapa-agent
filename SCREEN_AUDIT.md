# Rapa — Screen & Feature Audit

**Date:** 13 September 2026
**Scope:** Every user-facing screen and feature of the Rapa frontend (React 18 · Vite · TS · Tailwind 4 · Radix), with backend endpoint cross-checks.
**Method:** Static source review of all 40+ components (~19,000 lines), endpoint contract verification against `server/src/routes/*`, and a live runtime walkthrough (backend :8787 + Vite :5173, every screen opened in a browser, interactions tested).

**Severity scale:** P1 = user-visible bug / broken feature · P2 = degraded experience or latent bug · P3 = polish / dead code / a11y.

---

## Screen inventory

| Route / surface | Component(s) | Status |
|---|---|---|
| `/login` | `login-page.tsx` | Renders, auto-login works |
| `/` (Home: Chat/Agent/Plan) | `routes.tsx` Home + `chat/message-list.tsx`, `chat-input.tsx`, `agent-steps-viewer.tsx` | Renders with live data |
| — Left sidebar | `sidebar.tsx` (conversations, workspaces modal, settings nav) | Renders, wired |
| — Top bar | `top-bar.tsx` (mode toggle, workspace chip, export, terminal) | Renders, wired |
| — Right sidebar | `right-sidebar.tsx` (Tool History / Files / Plan tabs) | Renders; Files tab fails on stale workspace |
| — Model selector + reasoning picker | `model-selector.tsx` | Works end-to-end |
| — Dialogs | conversation-search, go-to-file, find-in-files, terminal, diff | See findings |
| `/settings?tab=usage` | `usage-analytics-page.tsx` | Renders with live data |
| `/settings?tab=agent` | `agent-settings-page.tsx` + panel | Renders, localStorage-backed |
| `/settings?tab=skills` | `agent-specialists-page.tsx` | Renders (5 built-ins) |
| `/settings?tab=search` | `service-keys-settings.tsx` | Renders; pause toggle is a no-op |
| `/settings?tab=appearance` | `appearance-page.tsx` | Renders; 3 of 4 settings inert |
| `/settings?tab=<provider>` | `settings-page.tsx` (8 providers) | Renders (Gemini: 20 keys, ~50 models) |
| `/settings?tab=add-provider` | `add-custom-provider.tsx` | Renders |
| **Dead screens** (build-verified, no entry point) | `agent-run-panel.tsx`, `agent-run-comparison.tsx`, `tool-approval-dialog.tsx`, `tool-execution-history.tsx`, `workspace-selector.tsx`, `file-presentation-card.tsx`, `widget-renderer.tsx`, `DiffView` component | Unreachable |

**Endpoint contract:** every endpoint the frontend calls exists server-side with matching response shapes (verified across `api.ts`, `agent-api.ts`, `workspace-api.ts` vs `server/src/routes/*`). The problem is the inverse direction: a large "operations layer" (run control, checkpoint restore, widgets, file presentation, undo) is fully built on both ends but has no UI entry point, and several UI affordances have no backend.

---

## 1. Home — chat surface

### Features verified working (runtime)
Conversation list with pagination, rename/delete, workspaces modal, mode toggle Chat/Agent/Plan, model selector with provider tiles + searchable model list + reasoning-effort picker (Default/Low/Medium/High for Gemini lite models), message list with copy/edit/fork/regenerate/delete, agent mode banner, export to markdown, scroll-to-bottom, input dock with attachments + drag-drop + resize.

### P1 findings
1. **Plan→Agent handoff runs in the wrong mode.** `message-list.tsx:434-437` — the "execute plan in agent mode" button calls `onSetMode("agent")` then `onSubmit(...)`, but `submitPrompt` reads the stale `mode` closure (still `"plan"`) because React hasn't re-rendered (`use-chat-stream.ts:520`). The button re-runs the plan in plan mode, where side-effectful tools are blocked — the exact opposite of its label.
2. **Input freezes during generation.** `chat-input.tsx:198-207` — `handleSend` awaits `onSubmit(...)` before clearing the textarea/attachments. `onSubmit` resolves only when the entire stream finishes, so the sent text stays in the input (visually duplicated with the bubble) and attachments remain for the whole generation.
3. **Edit-resend diverges from server history.** `use-chat-stream.ts:813-815` — "resend edit" truncates the conversation locally only; the server is append-only (no truncate endpoint). After reload the user sees the original unedited tail **plus** the new branch.

### P2 findings
- Message delete is local-only (`routes.tsx:553-559`); deleted messages reappear on reload — the affordance lies about persistence.
- Stop only aborts the client fetch; the server's `POST /agent/runs/:id/abort` (`agent-control.ts:91`) is never called from the frontend — orphaned control surface, no confirmation the run stopped.
- Restored history shows **"0 tok/s"** on every assistant message (`chat-utils.ts:247-252` fabricates `tokensPerSec: 0`; footer gated on `stats` at `message-list.tsx:496`). *Runtime-confirmed.*
- Aborted chat responses lose their action footer (no stats → no copy/regenerate).
- **Ctrl+K / Ctrl+N / Ctrl+\ are dead while typing** (`use-keyboard-shortcuts.ts:26-31` skips all editable targets) — the chat textarea is the primary focus target, so the "Search conversation (Ctrl+K)" tooltip (`top-bar.tsx:161`) is misleading most of the time. Ctrl+P inside an input falls through to the browser Print dialog.
- `streamChat` retries permanent 4xx/5xx up to 10 times with a "Reconnecting…" banner (`api.ts:595-609`).
- Sidebar rename/delete/delete-all have no catch — silent failures, dialog stuck (`sidebar.tsx:519-566`); a transient poll error wipes the whole conversation list (`:383-385`); Delete-All confirm shows the loaded page count (max 50), not the true total (`:1041`); search covers only the loaded page and hides Load More (`:468-472, 945`).
- Enter sends prematurely during IME composition (`chat-input.tsx:349-354`, no `isComposing` check) — affects CJK input.
- Plan-mode live events hardcode `mode: "agent"` (`use-chat-stream.ts:367,377`) — message mode flips mid-run.
- Single-line fenced code blocks are silently demoted to inline code — loses language label/copy/download (`assistant-markdown.tsx:29,51-57`).
- Conversation search excludes plan-mode tool steps (`conversation-search.tsx:146`).

### Notable P3s
- Sending attachments-only fabricates the user message "Please analyze the uploaded files and images." (`chat-input.tsx:201`).
- API-key-switch and error banners have no dismiss control; assistant edit button labeled just "Save" vs the user equivalent "Save edit (keep locally)".
- Greedy `toolCalls` regex can delete legitimate trailing content in a message (`assistant-markdown.tsx:194-197`); export strips only `<think>` while the renderer also hides `<thinking>/<thought>/<reasoning>` — exported markdown can contain raw thought blocks (`routes.tsx:671`).
- Always-highlighted History button; mode-toggle buttons lack pressed-state semantics; attachment remove buttons unlabeled.

---

## 2. Home — agent run features

### Features verified working
Tool trace cards with ProgressRing status, phase labels, inline approval prompts (Approve/Reject → `POST /agent/approvals`), diff badges opening DiffDialog, expandable results (images, fetch_url markdown, search matches, params JSON), collapsible reasoning panels, task plan extraction to TaskList, resumable-run banner, tool-history drawer in the right sidebar, mode-switch prompt.

### P1 findings
4. **Nested `<button>` inside the trace-card header button** (`agent-steps-viewer.tsx:477` header contains the diff-path button `:495`, "Review Changes" `:513`, and ±badges `:537` as child buttons). Invalid HTML (React logs DOM-nesting warnings); keyboard/screen-reader behavior is undefined; correctness relies entirely on `stopPropagation`.
5. **Checkpoint-restore UI is unreachable.** `AgentRunPanel` is imported nowhere (only a stale `vi.mock` in `message-list.test.tsx:30`). The entire server-side checkpoint restore + typed-confirmation contract (`POST /agent/checkpoints/:id/restore`, `agent.ts:1415`) is fully built but unusable.
6. **Run A/B comparison is unreachable.** Rendered at `routes.tsx:904` but `setComparisonOpen` is never called with `true` and `_setComparisonRunIds` is never called (`routes.tsx:188`) — the dialog can never open and would always show "No runs to compare".
7. **Modal approval + tool-undo layer is dead.** `tool-approval-dialog.tsx` (risk-level modal, wired to the also-uncalled `POST /agent/command-risk`), `tool-execution-history.tsx`, and `lib/tool-history.ts` (227 lines) have zero consumers. Live approvals are inline-only.

### P2 findings
- `workspacePath` never forwarded to `AgentStepsViewer` (`message-list.tsx:410-422`) — relative tool paths render unresolved.
- N+1 `getAgentRun` fetch per persisted agent message, no cache (`agent-steps-viewer.tsx:978-1010`) — opening a 10-message agent conversation fires 10 full run fetches just to recover tool display names.
- Pending approvals are not rehydratable after reload — the server holds approvals in an in-memory map with no GET; the prompt disappears while the run stays blocked.
- **ask_user questionnaires re-render in an unanswered state on old historical messages** and can be re-answered/re-submitted (`message-list.tsx:447`, `interactive-options.tsx` `submitted` is component-local). *Runtime-confirmed: a 3-question ask_user card from an old run rendered fully interactive.*
- Mode-switch prompts also render on all history messages — old "Switch to Agent" buttons re-run stale prompts.
- The right sidebar cannot be reopened after the Escape/close path unmounts it (no TopBar toggle) — only a full page reload restores it. *Runtime: collapse-to-icon-rail works; the full-close path is code-verified.*
- Comparison duration highlight compares formatted strings (`agent-run-comparison.tsx:129-142`) — "10.0s" < "9.1s" lexically, slower run highlighted as faster.
- The **entire Exit Hatch server API** (`pause`/`resume`/`redirect`/`abort`, `agent-control.ts:41-133`) has zero frontend callers — no UI to pause/redirect a running agent.

### Notable P3s
- `defaultOpen` prop ignored → all reasoning panels open expanded; unused `statusText` prop; empty `useEffect` (`:1039`).
- Missing `aria-expanded`/selection semantics across trace cards, option buttons, drawer rows; instant-submit on misclick for single-select questions; fragile "Other" label heuristic; live `add_task` shows "In progress" before anything starts; `text-purple-400` raw palette color (blueprint deviation); ErrorBoundary hardcodes hex colors outside the token system and a single root boundary means one bad message crashes the whole app.

---

## 3. Workspace / IDE surface

### Features verified working
File tree with expand/collapse, filter-as-you-type, multi-select with bulk delete/copy, inline rename (F2/double-click), new file/folder dialogs, duplicate, reveal-in-explorer, recent files, hover stat tooltips, auto-refresh on agent file mutations (`workspace:tree-refresh` chain intact), Ctrl+P go-to-file + Ctrl+Shift+F find-in-files (server-backed), terminal panel with multi-tab PTY sessions, minimize-to-pill, drag-resize, cwd-pinned tabs via "Open in terminal", session persistence across conversation switches.

### Runtime finding (environment)
- **The Files tab shows "Failed to load workspace files"** — the active workspace `minimax_cb` points to `C:\Users\Rafael\OneDrive - DEPED REGION 7-1\Documents\minimax_cb`, which no longer exists on disk. The endpoint 404s and the UI shows a generic error + Retry with no hint that the workspace itself is stale or how to switch it. (Fix the data: re-point or remove the workspace; fix the UX: distinguish "directory missing" from "transient failure".)

### P1 findings
8. **File download always fails.** `workspace-file-tree.tsx:1681-1688` downloads via an `<a href="/workspaces/:id/raw?path=...">` anchor — but `/raw` sits behind JWT auth (`index.ts:177-193`) and an anchor can't send the Bearer header. Every Download context-menu click saves the 401 JSON body as the file.
9. **`present_file` agent tool is invisible to users.** The server emits `presentedFiles` (`present-file.ts:190`) and its comment claims "the frontend agent-steps-viewer looks for this" — it doesn't; `file-presentation-card.tsx` (the consumer) is never imported. The agent believes it presented a file; the user sees generic tool output.
10. **`render_widget` agent tool is invisible to users.** Same broken contract: `widgets.ts:117-124` emits `widget`, `widget-renderer.tsx` (sandboxed CSP-locked iframe viewer, complete) is orphaned.

### P2 findings
- `workspace:open-file` has no listener when the right sidebar is collapsed — Ctrl+P / Find-in-Files selections silently do nothing (the shortcut sets the tab but never un-collapses).
- "Search in folder" dispatches `workspace:search-in` — **no listener exists anywhere**; the menu item is a toast stub ("Tip: use Ctrl+K").
- Child tree rows inherit the parent's `isSelected` flag (`workspace-file-tree.tsx:624`) — Ctrl+clicking a folder visually selects every descendant while the bulk actions act on the folder only.
- Filtering permanently overwrites expansion state; the "fall back to whatever the user had expanded" comment describes restore logic that doesn't exist (`:1724-1737`).
- No image/binary preview — images open as utf-8 mojibake or 413; `/raw` can't be used in an `<img>` either (same auth issue as download).
- Terminal `closed` session auto-reconnects, spawning a brand-new shell in the same tab after typing `exit` (`terminal-view.tsx:271,298-302`); Ctrl+` can only minimize/restore, never open (`terminal-dialog.tsx:209-214`).
- No token refresh: `POST /auth/refresh` exists (`auth.ts:66`) with 7-day tokens but has no frontend caller; workspace APIs lack 401→logout handling, so a mid-session expiry surfaces as generic toasts. A transient `/auth/me` network failure at boot wipes a valid token (forced logout, `use-auth.tsx:39`).
- `workspace-selector.tsx` — 443 lines fully orphaned (replaced by the sidebar's Workspaces modal).

### Notable P3s
- Dead code cluster in the tree: rename dialog + `submitRename` (~106 lines, rewired to inline editing), unreachable "plain click selects" branch with stale-selection Delete hazard, shift-range over the unfiltered tree, tooltip stuck on "loading…" on stat failure, dotfile ignore-list mismatch between tree and Ctrl+P/Find-in-Files.
- File viewer raw view not virtualized (1MB file → tens of thousands of DOM nodes); terminal tab rail has no roles/keyboard support and hardcodes a dark theme inside light mode; standalone TerminalView mode (~100 lines) and `DiffView` component (~70 lines) are dead; DiffDialog uses green/red tints while diff-view.tsx documents a strict B/W palette — two diff languages.

---

## 4. Settings screens

All seven tabs render with live data. Endpoint wiring is complete and shape-accurate (including the new reasoning-profile flow — types, level space, and snap ladder are consistent between `model-selector.tsx` and `reasoning-capabilities.ts`; runtime-verified the picker renders per-model levels).

### P1 findings
11. **Web Search "enable/pause" toggle has no backend.** `service-keys-settings.tsx:38,377-380` — state is local only; no endpoint exists (`service-keys.ts` has none); the copy promises "disable the provider temporarily if you want the agent to avoid web search entirely" (`:514`). The switch resets on remount and never affects agent behavior.
12. **Accent color setting is inert.** `appearance-page.tsx:48-56` sets `--accent-color`, but nothing outside the page consumes it; the description claims it's "used for highlights, focus rings, and selected items" (`:370`).
13. **Message text size setting is inert.** `--font-size-multiplier` (`:58-65`) has zero consumers. (Message density `P2`: `data-density` consumed nowhere.)
14. **Model-selector reset race silently swaps the selected model.** `model-selector.tsx:284-294` — before the provider's saved model list loads, any model not in the hardcoded defaults (including models restored from a conversation, `routes.tsx:421`) is replaced by `defaultModels[0]`; the saved list arriving later cannot undo the already-fired `onSelectModel(fallback)`. The next message is sent with the wrong model.

### P2 findings
- Provider settings auto-save silently persists **staged** state: flipping the enabled toggle (without clicking Save) is committed by any auto-save action, and a pasted-but-not-added API key is silently created (`settings-page.tsx:194-197`).
- "Use Built-In" on a specialist leaves a zombie disabled row and a permanently wrong "Built-in updated — click Use Built-In to apply" badge (`agent-specialists-page.tsx:70-73,385`; no DELETE route exists, custom specialists are un-deletable).
- Auto-switch toggle for service keys silently lost when zero keys exist (server `updateMany` over zero rows still returns ok, `service-keys.ts:168-178`).
- Provider + Serper icons use `/src/assets/...` string URLs — work only under the Vite dev server; **404 in production builds** (static root is `web-dist`, `server/src/index.ts:208`).
- OpenRouter preset on Add-Custom-Provider uses the slug `openrouter` (`add-custom-provider.tsx:181`) which collides with the built-in provider — create fails with "already exists" once a row exists (the Groq preset deliberately avoids this with `groq-cloud`).
- `deleteCustomProvider` client function + server route exist but no UI calls it — custom providers are un-deletable from the app.

### Notable P3s (runtime-confirmed where noted)
- "How It Works" says "changes are saved when you click the top-right Save" — **no Save button exists on the screen** (stale copy, confirmed live); unconfirmed destructive "Refresh" (replaces whole model list); duplicate React keys possible from upstream model lists; load failure leaves editable defaults on screen where Save would overwrite server state.
- Appearance: hardcoded "Toggle" section header exposed in the a11y tree (confirmed live); Reset hardcodes theme "dark".
- Agent settings: auto-approve baseline (13 always-approved tools incl. `mkdir`, `git_*`) is invisible and undisableable from the UI.
- Usage analytics: `huggingface`/`openrouter`/custom providers render as raw ids with fallback colors (confirmed live — `PROVIDER_LABEL`/`PROVIDER_COLORS` gaps); two different "Total tokens" scopes (all-time header vs 24-week heatmap); title-only tooltips; no refresh/range control.
- Model selector: profile cache never invalidates; N+1 settings fetch per provider tile on mount; dropdown closes only on outside mousedown (no Escape); provider tiles/model rows are divs without roles.
- Specialists: duplicated Save/Disable button groups; rename collisions produce duplicate keys and edit the wrong row.

---

## 5. Login & auth

Renders with validation, error banner, and the animated brand layer; local auto-login works (runtime: unauthenticated visit bounced to `/login` and auto-authenticated back to `/`).

- **P2:** 7-day token expiry has no refresh path (see §3); transient boot network failure force-logs-out a valid session.
- **P3:** `/login` reachable while authenticated (no redirect-away); no show-password toggle; non-JSON failure (proxy 502) surfaces a parser message; separate `AuthProvider` per route boundary; stored "system" theme degrades to explicit dark/light after reload (`use-theme.tsx:61-64`).

---

## 6. Cross-cutting themes

1. **The "operations layer" is built but unreachable.** Checkpoint restore (AgentRunPanel), A/B run comparison, risk-based approval dialog + `/agent/command-risk`, undoable tool history, Exit Hatch controls (pause/resume/redirect/abort), `present_file`, `render_widget`, `/auth/refresh`, `deleteCustomProvider` — all fully implemented server-side (and mostly client-side) with no entry point in the current UI. This is the single largest gap between advertised capability and reachable surface. Fix: either wire entry points (a Runs/History view would unlock most of it) or delete the dead code.
2. **Client/server persistence divergence.** Message delete, edit-resend, and interactive-answer state are client-only mutations against an append-only server — every one of them silently diverges on reload.
3. **Settings that lie.** Three appearance controls do nothing; the web-search kill switch does nothing; "How It Works" copy describes removed buttons; auto-save commits state the user believes is staged.
4. **a11y debt is broad but shallow.** Missing `aria-expanded`/`aria-pressed`/dialog semantics/focus traps across nearly every custom composite widget (trace cards, option buttons, model selector, terminal rail, file tree). No single blocker, but no screen is fully compliant either.
5. **Blueprint design system** is well followed on the live agent surface; deviations cluster in dead/orphaned components (grey-palette dialogs, `text-purple-400`, hardcoded hex in ErrorBoundary, DiffDialog tints) — mostly moot until revived.

## Priority matrix (fix order)

| Priority | Count | Representative items |
|---|---|---|
| **P1** | 14 | Plan handoff mode race · frozen input during streams · edit-resend history divergence · file download 401 · `present_file`/`render_widget` invisible · web-search toggle no backend · inert accent/font-size settings · model-selector reset race · nested buttons in trace card · 4 dead screens (run panel / comparison / approval dialog / tool history) |
| **P2** | ~45 | 0 tok/s history stats · Ctrl+K dead while typing · orphaned abort endpoint · N+1 run fetches · ask_user re-answerable · right-sidebar reopen · `workspace:open-file` when collapsed · `workspace:search-in` no listener · tree selection inheritance · no image preview · terminal reconnect churn · no token refresh · auto-save commits staged state · specialist zombie rows · production icon 404s · OpenRouter slug collision |
| **P3** | ~90 | Dead code clusters (~800+ lines: workspace-selector, tool-history, DiffView, standalone terminal, rename dialog) · a11y gaps · stale copy · label/color map gaps · misc state hygiene |

**Bottom line:** every screen renders and the REST/WS contract layer is in excellent shape, but the audit found 14 P1 user-visible bugs — concentrated in (a) state races between UI affordances and the streaming loop, (b) a fully-built operations layer with no UI entry point, and (c) settings that promise behavior that was never wired. The fastest wins: pass an explicit mode override in the plan handoff, clear the input before awaiting the stream, fetch downloads with the auth header (blob), mount `FilePresentationCard`/`WidgetRenderer` in the steps viewer, and either wire or remove the four dead screens.
