# Audit Remediation — Implementation Status

**Date:** 14 September 2026
**Reference:** [SCREEN_AUDIT.md](./SCREEN_AUDIT.md) (Round 1) · [SCREEN_AUDIT_R2.md](./SCREEN_AUDIT_R2.md) (Round 2)
**Gates:** every milestone ended with `tsc --noEmit` + `eslint --max-warnings 0` (both packages) + full test suites green (74 frontend / 572 backend tests).

Legend: ✅ fixed/wired · 🟡 partially done · ⏸ deferred (documented, not started)

---

## M0 — Stability & Auth

| Item | Status | Where |
|---|---|---|
| Terminal spawn crash (unhandled `error` event killed the backend) | ✅ | `shell.ts` error handler + `terminal.ts` cwd existence check + `getShell` cache invalidation; regression test `shell-session.test.ts` |
| Silent token refresh (7-day hard logout) | ✅ | `http.ts` `fetchWithAuth` (single-flight refresh + 429 backoff), adopted by `api.ts`/`agent-api.ts`/`workspace-api.ts`; `use-auth.tsx` proactive refresh + network-vs-401 boot distinction; 8 tests in `http.test.ts` |
| Login one-click local sign-in | ✅ | loopback-only `POST /auth/login-local` + "Continue as local user" button |
| Login polish (redirect-away, show-password) | ✅ | `login-page.tsx` |

## M1 — P1 bug sweep (all 14 fixed)

| Item | Status | Where |
|---|---|---|
| Plan→agent handoff mode race | ✅ | explicit `{ mode: "agent" }` override through `onSubmit` → `submitPrompt`; test asserts the override |
| Composer frozen during streams | ✅ | clear-before-await in `handleSend` |
| IME premature send | ✅ | `isComposing` guard |
| Edit-resend history divergence | ✅ | `DELETE /conversations/:id/messages` (truncate-after / delete-one) + wiring in `handleResendEdit`/`handleDelete` |
| Model-selector reset race | ✅ | fallback only fires against the loaded saved list |
| Nested buttons in ToolTraceCard | ✅ | header is now `div role="button"` with keyboard + `aria-expanded` |
| File download 401 | ✅ | `fetchWorkspaceRawObjectUrl` authed blob helper |
| Image preview mojibake | ✅ | `file-viewer.tsx` renders images via the blob URL |
| `present_file` invisible | ✅ | `FilePresentationCard` wired into the trace (lazy) |
| `render_widget` invisible | ✅ | `WidgetRenderer` wired into the trace (lazy) |
| Web-search pause toggle no backend | ✅ | `ServiceIntegrationSetting` model + migration + `PATCH/GET /service-keys/status` + `web_search` gate |
| Accent color inert | ✅ | `--accent-color` routes through `--accent-blue` (dark variant auto-lifted) |
| Text size inert | ✅ | `--font-size-multiplier` consumed by message bodies |
| Density inert | ✅ | `--density-row-gap` consumed by the message list (defaults preserved) |
| Boot application of appearance | ✅ | shared `lib/appearance.ts` + `main.tsx` boot call |

## M2 — Runs view & operations layer

| Item | Status | Where |
|---|---|---|
| Runs tab (list, status, live polling) | ✅ | `runs-panel.tsx` + 4th right-sidebar tab |
| Run detail (metrics, checkpoints, restore) | ✅ | `AgentRunPanel` in a dialog — now reachable |
| Destructive restore `window.prompt` | ✅ | inline typed-phrase confirm card |
| Run A/B comparison wiring | ✅ | real run ids + `setComparisonOpen` from the Runs tab |
| Comparison duration string-compare bug | ✅ | numeric ms comparison, running runs never highlight |
| Approval rehydration after reload | ✅ | `GET /agent/approvals/pending` + `createdAt` on pending entries + rehydrated approval card in the message list |
| Progressive trust ("always allow") | ✅ | checkbox on the inline approval → `POST /agent/auto-approve-patterns`; management UI in Agent Settings incl. the effective-permissions expander |
| Exit hatch (abort/pause/resume) | ✅ | `runId` in the agent start event; Stop calls `POST /agent/runs/:id/abort` first; Pause/Resume on the pending indicator |

## M3 — P2 sweep

| Item | Status | Where |
|---|---|---|
| "0 tok/s" honest stats + ≈ estimates | ✅ | `message-list.tsx` footer + `tokensEstimated` flag |
| Ctrl+K/N/\/P dead while typing | ✅ | modifier combos now fire in editable targets |
| streamChat retrying permanent 4xx | ✅ | 4xx (≠429/408) surfaces the error immediately |
| Banner dismiss buttons | ✅ | error + key-rotation banners |
| `aria-pressed` mode buttons | ✅ | `top-bar.tsx` |
| Restored `reasoningEffort` + fork copies it | ✅ | `chat-utils.ts` + server fork |
| Export strips all thought-tag variants | ✅ | `routes.tsx` exporter |
| Sidebar rename/delete/delete-all error handling | ✅ | catch + toast + dialog close |
| Poll error keeps stale list | ✅ | `loadConversations` catch |
| Server-side conversation search | ✅ | `GET /conversations?q=` + debounced client query |
| Time grouping (Today/Yesterday/7d/Older) | ✅ | sidebar render |
| Delete-All true count | ✅ | `GET /conversations/count` fetched on dialog open |
| ask_user gating + answered persistence | ✅ | `isLatestAssistant` gate, collapsed summaries, `PATCH .../messages/:messageId` `interactiveAnswered` |
| Mode-switch prompt gating | ✅ | latest-message only + collapsed summary |
| Right sidebar reopen + persistence | ✅ | TopBar toggle + `rapa.rightSidebarTab`/`...Collapsed` storage + `workspace:open-file` un-collapse |
| Tree selection inheritance bug | ✅ | children resolve own membership via `selectedPaths` |
| Terminal: global Ctrl+` open | ✅ | Home-level shortcut (guarded when open) |
| Terminal: closed → no auto-respawn | ✅ | "session ended — Reconnect" affordance |
| Providers: staged-state leak in auto-saves | ✅ | `persistSettings` opts-in model (+ same-tick stale-closure fixes for models/keys/toggles) |
| Providers: destructive Refresh confirm | ✅ | AlertDialog |
| Providers: delete custom provider | ✅ | header button + confirm |
| Provider icons 404 in production | ✅ | ESM asset imports (`provider-icons.ts`, Serper logo) |
| OpenRouter preset slug collision | ✅ | `openrouter-cloud` |
| "How It Works" stale copy | ✅ | rewritten |
| Auto-switch toggle with zero keys | ✅ | disabled when no live keys |
| Specialists: `DELETE /agent/skills/:id` | ✅ | route + client |
| Specialists: real "Use Built-In" | ✅ | deletes the override row (no zombie/badge) |
| Specialists: disabled rows ignored for builtins | ✅ | `buildEditors` |
| Specialists: delete custom + dedupe buttons | ✅ | single footer group with Delete |
| Analytics: provider label/color gaps | ✅ | `providerLabel`/`providerColor` helpers |
| Analytics: "Total tokens (all time)" qualifier | ✅ | header KPI |
| Analytics: refresh button | ✅ | header |
| Perf: `getAgentRun` N+1 | ✅ | TTL + in-flight-dedupe cache in `agent-api.ts` |

## M4 — Strategic upgrades

| Item | Status | Where |
|---|---|---|
| Regenerate with model switch | ✅ | `handleRegenerate(id, { model, provider })` + "regenerate with {current model}" chip in the footer |
| Slash commands (`/chat`, `/agent`, `/plan`) | ✅ | composer intercept + clickable hint row |
| Queued prompts while streaming | ✅ | queue + auto-flush, dimmed "queued" bubble, discarded on Stop |

## ⏸ Deferred (documented for a future round)

- **Radix model-dropdown rebuild** (a11y contract) — current dropdown works; rebuild is polish.
- **@-file mentions** in the composer — needs server-side token resolution in prompt building.
- **Plan artifact + per-step execution loop** — the handoff is fixed and working; the full task-artifact workflow needs `AgentTask` persistence design.
- **Streaming markdown incremental parse** — current full-parse is memoized at the component level; an incremental parser is a library evaluation.
- **Chat list virtualization** — per-message memoization groundwork not yet done either.
- **Cost view in analytics** — needs an editable price table design.
- **File-tree virtualization** — tree works for typical repos; virtualization is a scalability item.
- **`workspace:search-in` wiring** — the menu item still dispatches an unheard event (P2 stub); palette Ctrl+Shift+F covers the need today.
- **Dead code deletion** (`tool-approval-dialog.tsx`, `tool-execution-history.tsx`, `lib/tool-history.ts`, `workspace-selector.tsx`, `DiffView` component, terminal standalone mode) — intentionally left in place; several are superseded by M2's real UI and can be removed in a cleanup commit.

## Ops note

The stale `minimax_cb` workspace (dead OneDrive path) is a data issue — remove or re-point it in the sidebar's Workspaces modal. The terminal now degrades gracefully instead of crashing, but the Files tab will still show "Failed to load workspace files" until the workspace is fixed.
