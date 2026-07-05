// System prompt building, direct-response detection, and provider message formatting.
// Functions here take their dependencies as parameters so the Agent class can
// pass in its current state without the prompt builder knowing about it.

import { toolRegistry } from "../../tools/index.js";
import type {
  AgentExecutionMode,
  ToolDefinition,
  ToolResult
} from "../tools.js";
import {
  COMPACT_PROVIDER_HISTORY_CHAR_BUDGET,
  COMPACT_PROVIDER_MESSAGE_CHAR_LIMIT,
  COMPACT_TOOL_RESULT_STRING_CHAR_LIMIT,
  PROVIDER_HISTORY_CHAR_BUDGET,
  PROVIDER_MESSAGE_CHAR_LIMIT,
  TOOL_RESULT_STRING_CHAR_LIMIT,
  truncateText
} from "./types.js";
import type {
  AgentMessage,
  ProviderChatMessage,
  ToolCall
} from "./types.js";

export function buildSystemPrompt(
  tools: ToolDefinition[],
  maxIterations: number,
  mode: AgentExecutionMode
): string {
  const currentDate = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const modeLine = mode === "plan"
    ? "PLAN MODE — inspect and analyze only. Do NOT edit files or execute commands."
    : "AGENT MODE — full tool access. Read, write, run commands. Complete the task end-to-end.";

  // Only render essential rules for tools that cause the most failures.
  // The full tool catalog is exposed via native function-calling schemas (the
  // `tools` array sent in the API request) — no need to repeat it here as prose.
  const essentialRules = renderEssentialToolRules(tools);

  return `You are Rapa, an autonomous coding agent. ${modeLine} Today is ${currentDate}.

## HOW TO WORK

Follow this cycle for EVERY task. No exceptions.

**Phase 1 — PLAN (1 turn).** Call \`plan_tasks\` with all steps needed. Always include a final verification task (e.g. "Run tests, verify build passes"). This is your contract — you will execute each task in order and mark it completed when done. Do NOT re-plan mid-execution.

**Phase 2 — ACT (1 turn per task).** Execute the current task's tool calls. Batch parallel reads. Write surgically with \`edit_file\`. Run commands with \`execute_command\`. After EVERY tool call that advances a task, call \`update_task\` with \`status: "completed"\` (or "in_progress" if mid-task). Move to the next task immediately.

**Phase 3 — VERIFY (last task).** Run tests. Run the build. Check every requirement from the user's request against what you built. If something fails, fix it and re-verify. Never say "it's done" without checking.

**Phase 4 — REPORT (1 turn, no tool calls).** Once all tasks are completed and verified, produce your final answer. Include: files created/modified, test results, how to run the project. A turn with no tool calls ends the run.

### Execution Discipline

- **No overthinking.** Start executing task-1 immediately after \`plan_tasks\`. If you catch yourself writing "let me think about this" — STOP and execute instead.
- **No re-reading your own files.** If you wrote a file two turns ago, it exists. Do not re-read it unless you need specific content. Check \`.rapa/working-memory.md\` if you lose track.
- **No environment checks.** Do NOT run \`node --version\`, \`npm --version\`, \`pwd\`, \`dir\`, or \`ls -la\`. All tools are pre-installed. Go directly to building.
- **No repetition.** Never repeat the same tool call with the same parameters. Never re-plan. Never ask the same question twice.
- **Batch parallel reads.** Multiple independent \`read_file\` calls? Emit them together in one turn.
- **Verify after edits.** Run tests after writing code. Run the build after editing source files.
- **Update tasks immediately.** After completing work on a task, call \`update_task({ id: "task-N", status: "completed" })\` BEFORE calling tools for the next task. This is mandatory.

### File Tracking

After EVERY \`write_file\`, \`edit_file\`, \`replace_in_file\`, or \`append_file\`, call \`update_working_memory({ addFile: "path" })\`. This is mandatory, not optional. Files you create or edit are YOUR files — own them, reference them, don't treat them as pre-existing.

### Failure Recovery

- "File not found" → \`list_directory\` to find the correct path, retry.
- "Not found" in \`edit_file\` → re-read the file section, adjust oldText to match exact whitespace.
- "Command failed" → read the error, fix the command, re-run with \`--yes\`/\`-y\` flags.
- Same edit fails twice → \`read_file\` then \`write_file\` the full corrected content.
- After two failures on the same tool, switch strategy entirely.

### Terminal Rules

\`execute_command\` runs commands through pipes — there is NO interactive terminal. Commands that prompt for input will hang. Use flags: \`npm install --yes\`, \`pip install --no-input\`, \`apt-get -y\`, \`--non-interactive\`.

Prefer action over questions. Reserve \`ask_user\` for genuine decisions that change the approach.

${essentialRules}

## TOOL CALLING

You have a set of tools exposed through the runtime's native function-calling API (the \`tools\` parameter). To use a tool, emit a tool call through that mechanism — do NOT write the tool invocation as prose, pseudocode, or a JSON object in the message body. The runtime will execute the call and return the result on the next turn.

- Need to act? Call the tool directly. Do not narrate "I will read X" — just call read_file.
- Need to think privately first? Use the think tool, or rely on your native reasoning channel if available.
- Multiple independent read-only calls? Emit them together in one turn; the runtime batches them in parallel.
- No tool needed? Respond with plain prose. A turn with no tool calls ends the run.

Fallback only: if the runtime does not provide a native tool-calling channel, emit a single JSON object as your entire message and nothing else:
\`\`\`
{"toolCalls":[{"id":"call-1","name":"tool_name","parameters":{...}}]}
\`\`\`

## SELF-CORRECTION

- "File not found" → list_directory to find the correct path, retry.
- "Not found" in edit_file → re-read the file section, adjust oldText to match exact whitespace.
- "Command failed" → read the error, fix the command, re-run with --yes/-y flags.
- Same edit fails twice → read_file then write_file the full corrected content.

## DESIGN QUALITY

When creating or modifying frontend UI (HTML, CSS, React, Tailwind, components):

**Banned patterns — never produce these:**
- Generic fonts: Inter, system-ui, -apple-system as primary typeface. Pick a distinctive font that matches the project's character.
- Purple-to-blue gradients, "safe" blue CTAs, or any color scheme that looks like every SaaS template.
- Generic headlines: "Build the future", "Elevate your workflow", "Welcome to...", "Next-gen solution", "Passionate about...". Every headline must be specific to the actual project, product, or person.
- Placeholder content: Lorem ipsum, "Your Name Here", "Project Title", "Insert description", generic stock-image descriptions.
- Uniform border-radius everywhere, identical card heights, symmetric grid layouts with no visual hierarchy.
- Decorative hover effects that do nothing, fade-in animations without purpose.

**Required practices:**
- Read the project's existing theme, design tokens, or CSS variables FIRST. Match the established aesthetic — don't invent a new one.
- Use real data from the workspace: actual project names, real technology stacks, real descriptions, real content. Never generate filler text.
- Typography must be intentional: distinct heading/body pairing, deliberate weight/size hierarchy, appropriate line-height.
- Layouts need asymmetry, visual tension, or a clear design opinion. Cookie-cutter centered hero + 3-column features + footer is unacceptable.
- Colors must be functional and semantic (status, hierarchy, emphasis), not decorative gradients for their own sake.

**Quality checkpoint — after generating initial UI, review and fix:**
1. Does any section look like it came from a template? Rewrite it.
2. Is every headline and label specific to the actual project/product/person? If not, make it specific.
3. Would a designer recognize this as intentional work, or dismiss it as AI-generated? Aim for the former.

## BUDGET

${maxIterations} iterations. Small tasks: 2-6. Medium: 6-14. Large: use the full budget. On long tasks, checkpoint with summarize_progress every ~10 iterations.`;
}

/**
 * Render only the essential rules for high-risk tools that cause the most failures.
 * All other tool documentation is conveyed through native function-calling schemas
 * (which the provider renders in its own format). This keeps the system prompt lean.
 */
function renderEssentialToolRules(tools: ToolDefinition[]): string {
  const rules: string[] = [];
  const toolNames = new Set(tools.map((t) => t.name));

  if (toolNames.has("edit_file")) {
    rules.push("**edit_file**: `oldText` must be a BYTE-EXACT, UNIQUE substring with 3+ lines of context. If 'not found', re-read the file and adjust whitespace.");
  }
  if (toolNames.has("write_file")) {
    rules.push("**write_file**: For new files or full overwrites only. Prefer edit_file for surgical changes.");
  }
  if (toolNames.has("execute_command")) {
    rules.push("**execute_command**: Pass --yes/-y to package managers. Do NOT use shell to create/modify files. Raise timeoutMs for builds (180000+).");
  }
  if (toolNames.has("ask_user")) {
    rules.push("**ask_user**: True blockers only. 1-4 questions, 2-4 options each. If the answer lives in the workspace, find it with a tool — don't ask.");
  }
  if (toolNames.has("search_content")) {
    rules.push("**search_content**: Pass fileExtensions to scope by language. Use regex:true for patterns. Empty results → broaden the query.");
  }
  if (toolNames.has("git_commit")) {
    rules.push("**git_commit**: Always run git_status first. Use conventional commit prefixes (feat:, fix:, refactor:, chore:, docs:).");
  }

  if (rules.length === 0) return "";
  return "## KEY RULES\n\n" + rules.join("\n");
}

export function shouldRequireInitialAskUserForBroadAnalysis(
  userPrompt: string,
  _isNewConversation: boolean | undefined,
  mode: AgentExecutionMode
): boolean {
  if (mode !== "agent" && mode !== "plan") {
    return false;
  }

  const normalized = userPrompt.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return false;
  }

  if (/^Q\d+\s*\(/.test(normalized)) {
    return false;
  }

  const lower = normalized.toLowerCase();
  const broadAnalysisIntent =
    /\b(analy[sz]e|analysis|review|understand|map|explain|inspect|explore|overview|walk me through|audit)\b/.test(lower) &&
    /\b(codebase|repo|repository|project|architecture|structure|app|application|system|workspace|folder|directory)\b/.test(lower);
  const highLevelQualifier = /\b(whole|entire|overall|general|high[- ]level|big picture|everything)\b/.test(lower);
  const hasSpecificPathOrFile =
    /`[^`]+`/.test(normalized) ||
    /[A-Za-z]:\\[^\s]+/.test(normalized) ||
    /(?:^|[\s(])(?:\.{0,2}[\\/]|[A-Za-z0-9_-]+[\\/])[^\s]*\.(?:ts|tsx|js|jsx|json|md|css|prisma)\b/i.test(normalized) ||
    /\b(?:src|server|components|routes|lib|prisma|styles|assets)[\\/][^\s]+/i.test(normalized);
  const hasSpecificProblemOrTarget =
    /\b(error|bug|issue|failure|failing|broken|crash|performance|security|refactor|feature|endpoint|component|function|class|schema|migration)\b/.test(lower);

  return (broadAnalysisIntent || highLevelQualifier) && !hasSpecificPathOrFile && !hasSpecificProblemOrTarget;
}

export function isAskUserOnlyClarification(toolCalls: ToolCall[]): boolean {
  return toolCalls.length === 1 && toolCalls[0]?.name === "ask_user";
}

export function normalizeAskUserTextValue(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const normalized = value
    .replace(/<(thinking|think)>[\s\S]*?<\/\1>/gi, " ")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized.length > 0 ? normalized : null;
}

export function normalizeAskUserOptionValue(value: unknown): { label: string; description?: string; preview?: string; defaultOption?: boolean } | null {
  if (typeof value === "string") {
    const text = normalizeAskUserTextValue(value);
    return text ? { label: text } : null;
  }

  if (Array.isArray(value)) {
    return normalizeAskUserOptionValue(value[0]);
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const label = normalizeAskUserTextValue(
    record.label ?? record.title ?? record.text ?? record.value ?? record.name ?? record.heading ?? record.option ?? record.choice
  );
  if (!label) return null;

  const description = normalizeAskUserTextValue(
    record.description ?? record.details ?? record.helperText ?? record.subtitle ?? record.summary
  );
  const previewSource = record.preview ?? record.snippet ?? record.example ?? record.body;
  const preview = typeof previewSource === "string"
    ? previewSource.replace(/<(thinking|think)>[\s\S]*?<\/\1>/gi, " ").replace(/\r?\n{3,}/g, "\n\n").trim() || undefined
    : undefined;

  const defaultOption = record.defaultOption === true
    || record.isDefault === true
    || record.recommended === true
    || record.default === true;

  return {
    label,
    ...(description ? { description } : {}),
    ...(preview ? { preview } : {}),
    ...(defaultOption ? { defaultOption: true } : {})
  };
}

function unwrapOptionsArray(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const candidates = ["items", "item", "choices", "choice", "values", "value", "options", "option", "list", "entries", "rows"];
  for (const key of candidates) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return undefined;
}

export function getAskUserPayload(call: ToolCall, result: ToolResult): {
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description?: string; preview?: string; defaultOption?: boolean }>;
    multiSelect: boolean;
  }>;
} | null {
  if (call.name !== "ask_user" || !result.success || !result.data || typeof result.data !== "object") {
    return null;
  }

  const data = result.data as Record<string, unknown>;
  const rawQuestions = Array.isArray(data.questions) ? data.questions : undefined;
  if (!rawQuestions || rawQuestions.length === 0) return null;

  const HEADER_MAX = 12;
  const questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description?: string; preview?: string; defaultOption?: boolean }>;
    multiSelect: boolean;
  }> = [];

  for (let i = 0; i < rawQuestions.length; i += 1) {
    const raw = rawQuestions[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;

    const question = normalizeAskUserTextValue(
      record.question ?? record.text ?? record.prompt ?? record.label ?? record.title
    );
    if (!question) continue;

    const rawHeader = normalizeAskUserTextValue(
      record.header ?? record.chip ?? record.tag ?? record.category
    );
    const header = (rawHeader ?? `Q${i + 1}`).slice(0, HEADER_MAX);

    const rawOptions = unwrapOptionsArray(record.options);
    if (!rawOptions) continue;
    const options = rawOptions
      .map((option) => normalizeAskUserOptionValue(option))
      .filter((option): option is { label: string; description?: string; preview?: string; defaultOption?: boolean } => Boolean(option));
    if (options.length < 2 || options.length > 4) continue;

    const multiSelect = typeof record.multiSelect === "boolean"
      ? record.multiSelect
      : typeof record.isMultiSelect === "boolean"
        ? record.isMultiSelect
        : false;

    questions.push({ question, header, options, multiSelect });
    if (questions.length >= 4) break;
  }

  if (questions.length === 0) return null;
  return { questions };
}

export async function createBroadAnalysisFallbackAskUser(
  userPrompt: string,
  stepsLength: number,
  context: { workspaceRoot: string; userId: string; conversationId: string; mode?: AgentExecutionMode }
): Promise<{ call: ToolCall; result: ToolResult }> {
  const trimmedPrompt = userPrompt.trim();
  const summary = trimmedPrompt.length > 120 ? `${trimmedPrompt.slice(0, 117)}...` : trimmedPrompt;
  const questions = [
    {
      question: `What kind of analysis do you want for "${summary}"?`,
      header: "Analysis",
      options: [
        { label: "Architecture", description: "Module structure, dependencies, and data flow" },
        { label: "Debug issue", description: "Hunt down a bug, error, or regression" },
        { label: "Research patterns", description: "Find existing patterns, utilities, or examples to reuse" },
        { label: "Plan feature", description: "Design a refactor or new feature" }
      ],
      multiSelect: false
    },
    {
      question: "How deep should I go?",
      header: "Scope",
      options: [
        { label: "Quick scan", description: "Top-level files and structure only (a few minutes)" },
        { label: "Focused review", description: "Dive into 1-3 areas in detail" },
        { label: "Exhaustive", description: "Comprehensive read across the workspace" }
      ],
      multiSelect: false
    }
  ];

  const call: ToolCall = {
    id: `fallback-ask-user-broad-analysis-${stepsLength + 1}`,
    name: "ask_user",
    parameters: { questions }
  };

  const askUserTool = toolRegistry.get("ask_user");
  if (!askUserTool) {
    return {
      call,
      result: {
        success: true,
        data: {
          questions,
          status: "awaiting_response",
          message: "Questions have been presented to the user. Wait for their response before continuing."
        }
      }
    };
  }

  const result = await askUserTool.execute(call.parameters, context);
  return { call, result };
}

export function getInjectedSystemMessages(toolCalls: ToolCall[], toolResults: ToolResult[]): AgentMessage[] {
  const injected: AgentMessage[] = [];

  for (const [index, call] of toolCalls.entries()) {
    const result = toolResults[index];
    if (call.name !== "delegate_task" || !result?.success || !result.data || typeof result.data !== "object") {
      continue;
    }

    const activationMessage = (result.data as { activationMessage?: unknown }).activationMessage;
    if (typeof activationMessage !== "string" || !activationMessage.trim()) {
      continue;
    }

    injected.push({
      role: "system",
      content: activationMessage.trim()
    });
  }

  return injected;
}

export function sanitizePromptValue(value: unknown, stringLimit: number, depth = 0): unknown {
  if (typeof value === "string") return truncateText(value, stringLimit);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 80).map((item) => sanitizePromptValue(item, stringLimit, depth + 1));
  }
  if (value && typeof value === "object") {
    if (depth >= 5) return "[nested object omitted]";
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
        key,
        sanitizePromptValue(nestedValue, key === "content" || key === "output" ? stringLimit : Math.min(stringLimit, 4000), depth + 1)
      ])
    );
  }
  return value;
}

export function formatToolResultsForPrompt(
  results: ToolResult[] | undefined,
  compact: boolean,
  overrides: { toolResultCharLimit?: number; messageCharLimit?: number } = {}
): string {
  if (!results || results.length === 0) return "[Tool results: none]";
  const stringLimit = overrides.toolResultCharLimit
    ?? (compact ? COMPACT_TOOL_RESULT_STRING_CHAR_LIMIT : TOOL_RESULT_STRING_CHAR_LIMIT);
  const messageLimit = overrides.messageCharLimit
    ?? (compact ? COMPACT_PROVIDER_MESSAGE_CHAR_LIMIT : PROVIDER_MESSAGE_CHAR_LIMIT);
  const sanitized = results.map((result) => sanitizePromptValue(result, stringLimit));
  return truncateText(
    `[Tool execution results]\n${JSON.stringify(sanitized, null, 2)}`,
    messageLimit
  );
}

export function buildProviderMessages(
  history: AgentMessage[],
  extraInstruction: string | undefined,
  compact: boolean,
  overrides: {
    toolResultCharLimit?: number;
    messageCharLimit?: number;
    historyCharBudget?: number;
  } = {}
): ProviderChatMessage[] {
  const perMessageLimit = overrides.messageCharLimit
    ?? (compact ? COMPACT_PROVIDER_MESSAGE_CHAR_LIMIT : PROVIDER_MESSAGE_CHAR_LIMIT);
  const totalBudget = overrides.historyCharBudget
    ?? (compact ? COMPACT_PROVIDER_HISTORY_CHAR_BUDGET : PROVIDER_HISTORY_CHAR_BUDGET);

  // Expand the internal AgentMessage[] into the OpenAI chat-completions wire
  // format. Two cases need special handling for native function calling:
  //
  //   1. An assistant turn that called tools MUST carry a `tool_calls` array
  //      (not a JSON blob in `content`). Most providers reject assistant turns
  //      whose `tool_calls` were flattened into prose.
  //
  //   2. The agent stores tool results as a single {role:"tool", toolResults:[...]}
  //      blob, but the OpenAI spec requires ONE role:"tool" message per call,
  //      each linked back by `tool_call_id` to the assistant entry that issued
  //      it. A single blob → "invalid params, tool results" 400 on the next call.
  //
  // We expand one history entry into potentially several provider messages via
  // flatMap, then run the existing budget-aware truncation pass over the result.
  const messages: ProviderChatMessage[] = [];
  // Stateful queue of tool-call IDs emitted by assistant turns but not yet
  // answered by a tool-results blob. Walked forward in document order so each
  // role:"tool" message links to the correct preceding assistant call.
  const pendingCallIds: NonNullable<ProviderChatMessage["tool_calls"]> = [];
  for (const message of history) {
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      // Native tool-call turn. Preserve content if the model also wrote prose;
      // providers accept an empty string when the turn is tool-only.
      const textContent = typeof message.content === "string"
        ? truncateText(message.content, perMessageLimit)
        : message.content;
      const prose = typeof textContent === "string" ? textContent.trim() : "";
      const toolCalls = message.toolCalls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: {
          name: call.name,
          arguments: JSON.stringify(call.parameters ?? {})
        },
        ...(call.thoughtSignature ? { thought_signature: call.thoughtSignature } : {})
      }));
      // Queue these IDs so the next tool-results blob can link back to them.
      pendingCallIds.push(...toolCalls);
      messages.push({
        role: "assistant",
        // MiniMax/GLM reject an empty-string content alongside tool_calls
        // (error 2013 "chat content is empty"). The OpenAI convention is to
        // send `null` when the turn is tool-only; emit prose only when present.
        content: prose.length > 0 ? prose : null,
        tool_calls: toolCalls
      });
      continue;
    }

    if (message.role === "tool") {
      // Expand the batched tool-results blob into one role:"tool" message per
      // call, linked back to the assistant turn that issued the calls. We track
      // `pendingCallIds` statefully as we walk forward: an assistant turn with
      // tool_calls pushes its IDs onto the queue, and a tool blob consumes them
      // in order. This is more correct than a reverse search, which would
      // falsely link an orphan tool blob (e.g. the auto-lint synthetic result,
      // which has no preceding assistant tool-call turn) to whatever tool-call
      // assistant happened to be most recent — producing wrong tool_call_ids.
      const results = message.toolResults ?? [];

      if (results.length === 0) {
        // Defensive: a tool blob with no results shouldn't happen, but if it
        // does, demote to a user message so we never emit a bare role:"tool".
        messages.push({ role: "user", content: "[No tool results]" });
        continue;
      }

      // Consume pending call IDs one-for-one with the results.
      const linkedIds = pendingCallIds.splice(0, results.length);

      if (linkedIds.length === 0) {
        // No preceding assistant tool-call turn to link to (synthetic results,
        // grace-synthesis context, etc.). Demote the whole blob to a user
        // message so the conversation stays schema-valid for every provider.
        messages.push({
          role: "user",
          content: formatToolResultsForPrompt(results, compact, overrides)
        });
        continue;
      }

      for (let i = 0; i < results.length; i += 1) {
        const result = results[i];
        const linked = linkedIds[i];
        // If we ran out of linked IDs (more results than calls), emit the
        // remainder as a single user message rather than an unlinked tool.
        if (!linked) {
          messages.push({
            role: "user",
            content: formatToolResultsForPrompt(results.slice(i), compact, overrides)
          });
          break;
        }
        messages.push({
          role: "tool",
          content: formatToolResultsForPrompt([result], compact, overrides),
          tool_call_id: linked.id,
          name: linked.function.name
        });
      }
      continue;
    }

    // system / user / plain-assistant turns (tool-call assistant turns were
    // handled above and `continue`d, so content here is prose or multimodal).
    let content: string | Array<Record<string, unknown>> | null;
    if (typeof message.content === "string") {
      content = truncateText(message.content, perMessageLimit);
    } else {
      content = message.content;
    }

    if (message.role === "assistant" && (!content || (typeof content === "string" && content.trim() === ""))) {
      content = "[Empty assistant response]";
    }

    messages.push({
      role: message.role,
      content
    });
  }

  if (extraInstruction) {
    messages.push({
      role: "user",
      content: truncateText(extraInstruction, perMessageLimit)
    });
  }

  // ---------------------------------------------------------------------
  // Repair tool-call adjacency before sending to strict providers.
  //
  // MiniMax (and DeepSeek, per the odysseus project) enforce a hard rule
  // the OpenAI spec leaves implicit: every `role:"tool"` message must
  // IMMEDIATELY follow the `role:"assistant"` turn that issued the
  // matching `tool_calls`. If a user/system turn sits between them —
  // which can happen after trimming, grace-synthesis, or conversation
  // reloads — MiniMax returns HTTP 400 (2013):
  //   "invalid params, tool call result does not follow tool call"
  //
  // Mirrors `_sanitize_llm_messages` in odysseus/src/llm_core.py. We:
  //   1. Demote any `role:"tool"` message that doesn't immediately follow
  //      its parent assistant turn → `role:"user"` with a clear prefix.
  //   2. Drop `tool_calls` from assistant turns that aren't followed by
  //      matching `role:"tool"` answers (unanswered calls are also
  //      rejected by strict providers).
  //   3. Repair the inverse: a `role:"tool"` whose `tool_call_id` doesn't
  //      match the preceding assistant's `tool_calls` is also demoted.
  // ---------------------------------------------------------------------
  const sanitized = sanitizeLlmMessages(messages);

  const systemMessage = sanitized.find((message) => message.role === "system");
  const recentMessages = sanitized.filter((message) => message !== systemMessage);

  // Group messages into atomic units so the budget trimmer never splits a
  // native tool-call exchange. An assistant turn with `tool_calls` plus its
  // trailing `role:"tool"` replies form ONE group; including the assistant
  // half without its tool answers (or vice versa) produces a 400 from the
  // provider ("tool_calls must be followed by tool messages"). Everything else
  // is its own single-message group.
  type Group = { messages: ProviderChatMessage[]; cost: number };
  const groups: Group[] = [];
  let i = 0;
  while (i < recentMessages.length) {
    const msg = recentMessages[i];
    const isToolCallAssistant = msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    const members: ProviderChatMessage[] = [msg];
    if (isToolCallAssistant) {
      // Absorb any immediately-following role:"tool" messages into this group.
      let j = i + 1;
      while (j < recentMessages.length && recentMessages[j].role === "tool") {
        members.push(recentMessages[j]);
        j += 1;
      }
      i = j;
    } else {
      i += 1;
    }
    const cost = members.reduce((sum, m) => sum + messageCost(m), 0);
    groups.push({ messages: members, cost });
  }

  const selected: ProviderChatMessage[] = [];
  let remaining = totalBudget - (systemMessage
    ? (typeof systemMessage.content === "string" ? systemMessage.content.length : JSON.stringify(systemMessage.content).length)
    : 0);

  // Walk groups newest-first. Always include at least the first (newest) group
  // so we never return an empty conversation; after that, drop a whole group
  // once it would blow the budget.
  for (let g = groups.length - 1; g >= 0; g -= 1) {
    const group = groups[g];
    if (selected.length > 0 && remaining - group.cost < 0) break;
    selected.unshift(...group.messages);
    remaining -= group.cost;
  }

  return systemMessage ? [systemMessage, ...selected] : selected;
}

/** Approximate wire size of a provider message, including tool_calls metadata. */
function messageCost(message: ProviderChatMessage): number {
  const base = typeof message.content === "string"
    ? message.content.length + 32
    : JSON.stringify(message.content).length + 32;
  if (message.tool_calls && message.tool_calls.length > 0) {
    return base + JSON.stringify(message.tool_calls).length;
  }
  return base;
}

/**
 * Repair tool-call adjacency so strict OpenAI-compatible providers
 * (MiniMax, DeepSeek) don't reject the request with HTTP 400.
 *
 * Mirrors `_sanitize_llm_messages` in odysseus/src/llm_core.py. The
 * OpenAI spec is implicit about this; MiniMax enforces it strictly
 * (error 2013: "tool call result does not follow tool call").
 *
 * Two repairs are applied:
 *
 *   1. **Orphan tool messages.** A `role:"tool"` whose immediately
 *      preceding message is NOT an assistant turn with a matching
 *      `tool_call_id` is demoted to `role:"user"`. This can happen
 *      after trimming, grace-synthesis, or conversation reloads that
 *      leave stale tool results in the history.
 *
 *   2. **Unanswered tool_calls.** An assistant turn that carries
 *      `tool_calls` but has no following `role:"tool"` answers (or
 *      only partial answers) has the unanswered calls dropped. The
 *      assistant turn is kept if it has prose; otherwise it's dropped
 *      entirely. This matches the odysseus behavior and prevents
 *      providers from seeing "incomplete" conversations.
 *
 * The function is pure — it does not mutate the input array.
 */
export function sanitizeLlmMessages(messages: ProviderChatMessage[]): ProviderChatMessage[] {
  const out: ProviderChatMessage[] = [];
  // Track the most recent assistant turn that carried `tool_calls`.
  // We need this (not just `out[out.length - 1]`) because a single
  // assistant turn can be followed by MULTIPLE consecutive tool
  // messages — one per call — and each one must validate against the
  // SAME parent assistant turn, not against the previous tool message.
  let lastToolCallAssistant: ProviderChatMessage | undefined;

  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];

    // ── Repair 1: orphan tool messages ─────────────────────────────────
    if (msg.role === "tool") {
      // The parent is the most recent assistant turn with tool_calls,
      // NOT necessarily `out[out.length - 1]` (which is the previous
      // tool message when there are multiple consecutive tool replies).
      const parent = lastToolCallAssistant;
      const linkedId =
        parent && Array.isArray(parent.tool_calls)
          ? parent.tool_calls.some((tc) => tc.id === msg.tool_call_id)
          : false;

      if (parent && linkedId) {
        out.push(msg);
        continue;
      }

      // Demote to a user message with a clear prefix so the model still
      // sees the result (as text) but the wire format stays valid.
      const toolName = msg.name ? ` from \`${msg.name}\`` : "";
      const toolId = msg.tool_call_id ? ` (call ${msg.tool_call_id})` : "";
      out.push({
        role: "user",
        content: `[Tool result${toolName}${toolId}]\n${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}`
      });
      continue;
    }

    // ── Repair 2: unanswered tool_calls on assistant turns ────────────
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      // Remember this turn as the potential parent of the following
      // tool messages. We update BEFORE checking answers so a tool
      // message immediately after a fresh assistant turn validates
      // against the new parent (not the previous one).
      lastToolCallAssistant = msg;

      const callIds = new Set(
        msg.tool_calls
          .map((tc) => tc.id)
          .filter((id): id is string => typeof id === "string" && id.length > 0)
      );
      const answeredIds = new Set<string>();
      for (let j = i + 1; j < messages.length && messages[j].role === "tool"; j += 1) {
        const tid = messages[j].tool_call_id;
        if (typeof tid === "string" && callIds.has(tid)) {
          answeredIds.add(tid);
        }
      }

      if (answeredIds.size === 0) {
        const hasProse = typeof msg.content === "string" && msg.content.trim().length > 0;

        // If this assistant turn is the LAST message in the conversation
        // AND has no prose, the agent will execute the tool calls
        // next. Keep the tool_calls intact so the round-trip works
        // correctly. This handles the case where `buildProviderMessages`
        // is called before the tool results are appended to the history.
        if (i === messages.length - 1 && !hasProse) {
          out.push(msg);
          continue;
        }

        // Otherwise: no tool answers at all. Keep the prose (if any)
        // but drop the unanswered tool_calls. If the turn is
        // tool-only, drop it entirely so the model doesn't see a
        // phantom tool exchange.
        if (hasProse) {
          out.push({ role: "assistant", content: msg.content });
        }
        // else: drop the turn entirely
        continue;
      }

      if (answeredIds.size < callIds.size) {
        // Partial answers. Prune the unanswered tool_calls so the
        // remaining tool messages still have valid parents.
        const prunedCalls = msg.tool_calls.filter((tc) => answeredIds.has(tc.id));
        const hasProse = typeof msg.content === "string" && msg.content.trim().length > 0;
        out.push({
          role: "assistant",
          content: hasProse ? msg.content : null,
          tool_calls: prunedCalls
        });
        continue;
      }

      // All answered. Pass through unchanged.
      out.push(msg);
      continue;
    }

    // A plain user / system / prose-assistant turn breaks the
    // tool-call adjacency: any tool messages that follow can no
    // longer be linked to `lastToolCallAssistant`, so we reset it.
    // This is the key invariant MiniMax enforces.
    lastToolCallAssistant = undefined;
    out.push(msg);
  }

  return out;
}
