// Pure response-parsing helpers used by the agent loop.
// These functions have no side effects and read no agent state.

import { safeParseToolCallEnvelope } from "./types.js";
import type { ParsedAssistantResponse, ToolCall } from "./types.js";

/**
 * Attempt to repair common JSON malformations produced by LLMs.
 * Returns the parsed object on success, or null if all repair attempts fail.
 *
 * Repair strategies (applied in order of aggressiveness):
 *   1. Strip JS comments, replace single quotes, remove trailing commas
 *   2. Quote unquoted object keys (e.g. {name: "foo"} → {"name": "foo"})
 *   3. Replace JS-only values (undefined, NaN, Infinity) with JSON-safe equivalents
 *   4. Strip trailing garbage after the closing brace/bracket
 *   5. Last resort: wrap in braces if it looks like a bare object body
 */
function tryRepairJson(raw: string): unknown | null {
  // ── Pass 1: lightweight cleanup ───────────────────────────────────────
  // Strip JS-style line and block comments
  let repaired = raw.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

  // Replace single-quoted strings with double-quoted (careful not to break escaped quotes)
  repaired = repaired.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');

  // Remove trailing commas before } or ]
  repaired = repaired.replace(/,\s*([}\]])/g, "$1");

  try {
    return JSON.parse(repaired);
  } catch {
    // fall through to pass 2
  }

  // ── Pass 2: quote unquoted object keys ────────────────────────────────
  // Matches patterns like { key: "value" } or { key: 123 }
  const quotedKeys = repaired.replace(
    /(?<=[{,])\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g,
    ' "$1":'
  );

  try {
    return JSON.parse(quotedKeys);
  } catch {
    // fall through to pass 3
  }

  // ── Pass 3: replace JS-only values ────────────────────────────────────
  let jsClean = quotedKeys;
  // undefined → null
  jsClean = jsClean.replace(/\bundefined\b/g, "null");
  // NaN → 0
  jsClean = jsClean.replace(/\bNaN\b/g, "0");
  // Infinity / -Infinity → large number
  jsClean = jsClean.replace(/\b-?Infinity\b/g, "999999999");
  // Trailing decimal point (e.g. 5. → 5)
  jsClean = jsClean.replace(/(\d+)\.\s*([,\]}])/g, "$1$2");

  try {
    return JSON.parse(jsClean);
  } catch {
    // fall through to pass 4
  }

  // ── Pass 4: strip trailing garbage after the last } or ] ──────────────
  const lastBrace = Math.max(jsClean.lastIndexOf("}"), jsClean.lastIndexOf("]"));
  if (lastBrace > 0) {
    const trimmed = jsClean.slice(0, lastBrace + 1);
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through
    }
  }

  // ── Pass 5: last resort — wrap in braces ──────────────────────────────
  try {
    return JSON.parse(`{${jsClean}}`);
  } catch {
    return null;
  }
}

export function extractThinking(content: string): string | undefined {
  const matches = Array.from(content.matchAll(/<(thinking|think)>[\s\S]*?<\/\1>/gi));
  const reasoning = matches
    .map((match) => match[0].replace(/^<(thinking|think)>/i, "").replace(/<\/(thinking|think)>$/i, "").trim())
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
  return reasoning || undefined;
}

export function stripThinking(content: string): string {
  return content.replace(/<(thinking|think)>[\s\S]*?<\/\1>/gi, "").trim();
}

export type StreamThinkStripperState = {
  displayContent: string;
  insideThink: boolean;
};

export function createStreamThinkStripper(): StreamThinkStripperState {
  return { displayContent: "", insideThink: false };
}

export function pushStreamThinkDelta(
  state: StreamThinkStripperState,
  delta: string
): { displayDelta: string; thinkingDelta: string; changed: boolean } {
  if (!delta) {
    return { displayDelta: "", thinkingDelta: "", changed: false };
  }

  let displayDelta = "";
  let thinkingDelta = "";
  let cursor = 0;
  let inside = state.insideThink;
  const lower = delta.toLowerCase();
  const OPEN_RE = /<think(ing)?>/i;
  const CLOSE_RE = /<\/think(ing)?>/i;

  while (cursor < delta.length) {
    const target = inside ? CLOSE_RE : OPEN_RE;
    const match = target.exec(lower.slice(cursor));
    if (!match) {
      if (inside) {
        thinkingDelta += delta.slice(cursor);
      } else {
        displayDelta += delta.slice(cursor);
      }
      cursor = delta.length;
      break;
    }

    const absoluteIndex = cursor + match.index;
    if (inside) {
      thinkingDelta += delta.slice(cursor, absoluteIndex);
    } else {
      displayDelta += delta.slice(cursor, absoluteIndex);
    }
    cursor = absoluteIndex + match[0].length;
    inside = !inside;
  }

  state.displayContent += displayDelta;
  state.insideThink = inside;

  return { displayDelta, thinkingDelta, changed: displayDelta.length > 0 || thinkingDelta.length > 0 };
}

export function combineReasoning(...values: unknown[]): string | undefined {
  const parts: string[] = [];
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        parts.push(trimmed);
      }
    }
  }

  const deduped: string[] = [];
  for (const part of parts) {
    if (!deduped.some((existing) => existing === part || existing.includes(part) || part.includes(existing))) {
      deduped.push(part);
    }
  }

  if (deduped.length === 0) return undefined;

  // Strip any residual tool-call artifacts that models sometimes leak
  // into their reasoning (e.g. minimax "model:tool_call" + parameter tags).
  const combined = deduped.join("\n\n");
  const sanitized = stripResidualToolMarkup(combined);
  return sanitized.length > 0 ? sanitized : undefined;
}

export function extractReasoningDelta(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export function containsToolCallMarkup(content: string): boolean {
  return /<\/?(toolCall|tool_call|function_call|invoke|longcat_tool_call|name|parameters|id|longcat_arg_key|longcat_arg_value|parameter)\b/i.test(content)
    || /\b\w+:tool_call\b/i.test(content);
}

export function stripResidualToolMarkup(content: string): string {
  let sanitized = content;

  // 1. Remove complete tool-call blocks (tag content is stripped entirely)
  const BLOCK_TAGS = [
    "toolCall", "tool_call", "function_call", "invoke",
    "longcat_tool_call", "parameter", "parameters"
  ];
  for (const tag of BLOCK_TAGS) {
    const pattern = new RegExp("<" + tag + ">[\\s\\S]*?<\\/" + tag + ">", "gi");
    sanitized = sanitized.replace(pattern, " ");
  }

  // 1b. Remove call: style tool invocations
  const callPattern = new RegExp("(?:<tool_call>|<toolCall>)?\\s*call:[a-zA-Z0-9_]+\\{[\\s\\S]*?\\}\\s*(?:</tool_call>|</toolCall>)?", "gi");
  sanitized = sanitized.replace(callPattern, " ");

  // 2. Remove stray opening/closing tags
  const TAGS = "toolCall|tool_call|function_call|invoke|longcat_tool_call|name|parameters|id|longcat_arg_key|longcat_arg_value|parameter";
  sanitized = sanitized.replace(new RegExp("<\\/?(" + TAGS + ")\\b[^>]*>", "gi"), " ");

  // 3. Remove model-specific tool_call markers (e.g. minimax:tool_call)
  sanitized = sanitized.replace(/\b\w+:tool_call\b/gi, " ");

  // 4. Clean up whitespace
  sanitized = sanitized
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return sanitized;
}

/**
 * Detect an explicit "I'm done" or "no follow-up needed" signal in a
 * model response. Used by both `looksLikeContinuationResponse` and
 * `looksLikeToolUseIntent` to short-circuit false-positive
 * continuations: a model that has already delivered its answer
 * sometimes appends a defensive paragraph like "I'm not going to emit
 * a toolCalls JSON. No tool calls are pending. No follow-up is
 * required from me." — and the inner `i'?ll` / action-verb
 * detectors were matching that paragraph instead of the actual
 * final answer, causing the UI to render the defensive text and
 * hide the real response.
 *
 * The patterns are intentionally narrow so they only fire on
 * unambiguous "I'm done" statements. Anything ambiguous falls
 * through to the existing heuristic.
 */
export function hasExplicitDoneSignal(content: string, reasoning?: string): boolean {
  // The defensive paragraph MiniMax and other models emit after a
  // final answer that happens to end with a trailing-promise phrase
  // (e.g. "If you'd like me to do additional work, just say which
  // area and I'll do it as a fresh, scoped pass."). The model is
  // explicitly saying it has no pending work.
  //
  // Also accepts a `reasoning` parameter so the MiniMax / DeepSeek
  // reasoning channel can be checked too. Those models often "think
  // out loud" in the reasoning field about being done ("no tool
  // calls are needed", "the work is done") while the response
  // content itself is empty or just an acknowledgment.
  const explicitDonePatterns: RegExp[] = [
    // ── Defensive "I'm not going to..." paragraphs ──────────────────
    // "I'm not going to emit/call/make a tool..."
    /\b(i'?m not going to|i am not going to|i won'?t be calling|i will not be calling|i'?m not going to (emit|call|use|make))\b/i,
    // "No tool calls are pending" / "no follow-up is required"
    /\bno tool calls? (are |is )?pending\b/i,
    /\bno follow-?up (is |are )?(required|needed|necessary)\b/i,
    // "I have nothing more to do/add/say"
    /\bno (more|additional|further) (tool )?calls? (are |is )?(needed|required|necessary)\b/i,
    // "My previous turn was a final answer"
    /\b(my (previous|last|prior) (turn|response|answer) (was|is) (a |the )?final)\b/i,
    // "I've delivered/completed/finished" (past-tense, no plan to continue)
    /\b(i'?ve (delivered|completed|finished|provided)|i have (delivered|completed|finished|provided))\b.{0,80}\b(answer|response|summary|map|analysis|review|explanation|report)\b/i,
    // "I'm done" / "that's it" / "nothing more"
    /\b(i'?m done|that'?s (it|all)|nothing more to (do|add|say))\b/i,
    // "I stopped at your instruction"
    /\bi stopped\b/i,

    // ── "The work is complete" / "Nothing left to do" ─────────────────
    // Often appears in the reasoning channel when the model is
    // deliberating about whether to emit a tool call. The
    // `(?:\w+\s+)?` allows for an optional adjective between "the"
    // and the noun (e.g. "the codebase analysis", "the final report").
    /\b(?:the\s+)?(?:\w+\s+)?(task|work|analysis|report)\s+(?:is|has been)\s+(?:complete|done|delivered|finished)\b/i,
    /\bnothing (more )?(left )?to (do|investigate|examine|add|say)\b/i,
    /\bgenuinely nothing (left |more )?to (do|investigate|examine|add)\b/i,
    /\bno (more |further |additional )(work|investigation|action) (is )?(needed|required|necessary)\b/i,

    // ── "Offering future work" courtesy phrases ──────────────────────
    // The architecture-map case: the model delivers a long final
    // answer and then offers to do more work if asked. The trailing
    // promise ("I'll do it as a fresh, scoped pass") used to trigger
    // the continuation detector. These patterns recognize the
    // "offering future work" shape and treat it as a final answer.
    /\bif you'?d like me to (do|perform|carry out) (additional|further|more)\b/i,
    /\bif you (want|need|would like) me to\b/i,
    /\bjust (say|let me know|tell me) (which|what|if|how)\b/i,
    /\bas a fresh, scoped (pass|effort|task)\b/i,
    /\bhappy to (do|help|continue|proceed|assist|extend|elaborate|dive|look)\b/i,
    /\bwould you like me to\b/i,
    /\blet me know if you (need|want|would like|require)\b/i,
  ];

  const sources: string[] = [];
  if (content && typeof content === "string") {
    sources.push(content.toLowerCase());
  }
  if (reasoning && typeof reasoning === "string") {
    sources.push(reasoning.toLowerCase());
  }
  if (sources.length === 0) return false;

  return explicitDonePatterns.some((pattern) => sources.some((source) => pattern.test(source)));
}

export function looksLikeToolUseIntent(content: string, providerReasoning?: string): boolean {
  // Explicit "I'm done" signals override any tool-use intent. Without
  // this, the model's defensive response — e.g. "I'm not going to emit
  // a toolCalls JSON. No tool calls are pending. No follow-up is
  // required from me." — gets mis-classified as a continuation
  // because it contains the action verb "emit" or mentions "tool
  // calls". That mis-classification was hiding the final response
  // (the architecture map) behind an unwanted "continue?" turn.
  //
  // We also pass `providerReasoning` so the MiniMax reasoning
  // channel is checked too. The model often "thinks out loud" in
  // the reasoning field about being done ("no tool calls are
  // needed", "the work is done") while the response content itself
  // is empty or just an acknowledgment.
  if (hasExplicitDoneSignal(content, providerReasoning)) return false;

  // If the response has substantial visible content, it's a complete
  // answer — not a "I'm about to call tools" statement. Models often
  // mention future actions ("let me verify", "I'll check") as part of
  // their summary, but that doesn't mean they intended to call tools.
  // Threshold matches odysseus (400 chars) — more lenient than 200.
  const visibleContent = stripThinking(content).trim();
  if (visibleContent.length >= 400) return false;

  // If the response contains fenced code blocks, the model actually
  // used the fenced-block tool format — not an intent-without-action.
  if (visibleContent.includes("```")) return false;

  const cleaned = stripThinking(content).toLowerCase();
  const thinking = combineReasoning(extractThinking(content), providerReasoning)?.toLowerCase() ?? "";
  const combined = `${cleaned}\n${thinking}`;

  const ACTION_VERBS = "list|read|search|edit|modify|write|create|fix|make|build|add|delete|remove|install|append|scaffold|generate|run|execute|inspect|check(?:\\s+out)?|look(?:\\s+at)?|explore|examine|review|open";

  const intentPatterns = [
    new RegExp(`\\b(let me|let's|we need to|we should|i'?ll|i will|i need to|i should|i'm going to)\\b[\\s\\S]{0,140}\\b(${ACTION_VERBS})\\b`),
    new RegExp(`\\b(need to|should|will)\\b[\\s\\S]{0,80}\\b(${ACTION_VERBS})\\b`),
    /\b(list|read|search|inspect|check(?:\s+out)?|look(?:\s+at)?|explore|examine|review|open)\b[\s\S]{0,100}\b(directory|workspace|files?|project|package\.json|readme|src|source|portfolio)\b/,
    /\b(run|execute)\b[\s\S]{0,100}\b(command|test|build|lint|server|npm|pnpm|yarn)\b/
  ];

  return intentPatterns.some((pattern) => pattern.test(combined));
}

/**
 * Returns the matched intent phrase (for inclusion in correction messages),
 * or null if no intent was detected. Uses the same logic as
 * looksLikeToolUseIntent but returns the matched text instead of boolean.
 */
export function getIntentMatchedPhrase(content: string, providerReasoning?: string): string | null {
  if (hasExplicitDoneSignal(content, providerReasoning)) return null;

  const visibleContent = stripThinking(content).trim();
  if (visibleContent.length >= 400) return null;
  if (visibleContent.includes("```")) return null;

  const cleaned = stripThinking(content).toLowerCase();
  const thinking = combineReasoning(extractThinking(content), providerReasoning)?.toLowerCase() ?? "";
  const combined = `${cleaned}\n${thinking}`;

  const ACTION_VERBS = "list|read|search|edit|modify|write|create|fix|make|build|add|delete|remove|install|append|scaffold|generate|run|execute|inspect|check(?:\\s+out)?|look(?:\\s+at)?|explore|examine|review|open";

  const intentPatterns = [
    new RegExp(`\\b(let me|let's|we need to|we should|i'?ll|i will|i need to|i should|i'm going to)\\b[\\s\\S]{0,140}\\b(${ACTION_VERBS})\\b`),
    new RegExp(`\\b(need to|should|will)\\b[\\s\\S]{0,80}\\b(${ACTION_VERBS})\\b`),
    /\b(list|read|search|inspect|check(?:\s+out)?|look(?:\s+at)?|explore|examine|review|open)\b[\s\S]{0,100}\b(directory|workspace|files?|project|package\.json|readme|src|source|portfolio)\b/,
    /\b(run|execute)\b[\s\S]{0,100}\b(command|test|build|lint|server|npm|pnpm|yarn)\b/
  ];

  for (const pattern of intentPatterns) {
    const match = combined.match(pattern);
    if (match) return match[0].trim();
  }
  return null;
}

export function looksLikeContinuationResponse(content: string, reasoning?: string): boolean {
  const normalized = content.trim().replace(/\s+/g, " ");
  if (!normalized) return false;

  // Explicit "I'm done" signals override continuation detection. Without
  // this, a model that has already delivered its answer and is now
  // explaining that it has no more work to do — e.g. "I'm not going to
  // emit a toolCalls JSON. No tool calls are pending." — gets
  // re-classified as a continuation because of forward-looking phrases
  // like "I'll do it as a fresh, scoped pass." That mis-classification
  // hides the final answer and asks the model to "continue" again.
  //
  // We also pass `reasoning` so the MiniMax reasoning channel is
  // checked too. The architecture-map case in particular: the
  // trailing "If you'd like me to do additional work..." offer
  // triggers the continuation detector below, but the reasoning
  // field often contains "the work is done" / "no tool calls are
  // needed" which the done-signal guard recognizes.
  if (hasExplicitDoneSignal(content, reasoning)) return false;

  const lower = normalized.toLowerCase();
  // Forward-looking intent at the start of the response. Catches both
  // single-sentence "Let me read X." promises and longer intros.
  const continuationLeadPatterns = [
    /^(let me|let's|i'?ll|i will|i'm going to|next,?\s+i'?ll|next,?\s+let me|now,?\s+i'?ll|now,?\s+let me|continuing|to continue)\b/,
    /\b(continue|continuing)\b[\s\S]{0,40}\b(with|by|examining|reading|searching|reviewing|inspecting|checking|looking at|opening)\b/,
    // Mid-sentence forward-looking intent, e.g. "Here's what I see — let me read the config."
    /[,;:]\s+(let me|i'?ll|i will|i should|let'?s|now let'?s)\b/,
    // Forward-looking verbs without a done-summary marker
    /^(now\s+)?(reading|reading through|inspecting|examining|searching|checking|looking at|opening|running|executing|reviewing|analyzing)\b/
  ];
  // The response must mention an action against the workspace. `every` is intentional —
  // both an action verb and a target noun must appear, so generic chat doesn't trigger.
  const actionPatterns = [
    /\b(list|read|search|inspect|check(?:\s+out)?|look(?:\s+at)?|explore|examine|review|open|run|execute|analyze|trace|find|locate|pull|fetch|grep|cat|view|browse|navigate|drill|investigate|compare|inspect|scan|trace|skim|load|read through)\b/,
    /\b(directory|workspace|files?|project|codebase|architecture|package\.json|readme|src|source|repo|component|module|function|class|method|endpoint|controller|model|view|route|config|test|tests|lint|build|log|logs|file|folder|path|output|output|method|signature|imports?|exports?|dependencies?)\b/
  ];
  // Trailing punctuation that signals an unfinished sentence. Includes `.`
  // because a model saying "Let me read X." is just as unfinished as one ending
  // in `:` — the period is just the model's default sentence terminator, not
  // evidence of a complete thought.
  const trailingContinuation = /(?:[:;,\.]\s*$|\.{3}$)/.test(normalized);

  // Short responses that are pure promise + action (no summary) are always
  // treated as continuations, regardless of trailing punctuation. We also
  // catch the common two-beat pattern: short summary of findings followed
  // by a "let me / I'll" promise — the promise is what determines the verdict.
  const hasSummaryMarker = /\b(done|complete|finished|conclusion|to summarize|in summary|overall|here'?s the (answer|result|summary)|final answer|final response)\b/i.test(lower);
  const trailingPromise = /\b(let me|i'?ll|i will|i should|let'?s|now let'?s|next,? let'?s|i'?m going to|continuing|to continue)\b[\s\S]{0,120}(?:[.!?]|$)/i.test(lower);
  const isShortPromiseOnly = normalized.length < 360
    && continuationLeadPatterns.some((pattern) => pattern.test(lower))
    && actionPatterns.every((pattern) => pattern.test(lower))
    && !hasSummaryMarker
    && trailingPromise;

  return (continuationLeadPatterns.some((pattern) => pattern.test(lower))
    && actionPatterns.every((pattern) => pattern.test(lower))
    && trailingContinuation)
    || isShortPromiseOnly;
}

export function extractXmlToolCalls(content: string): { calls: ToolCall[]; rawMatches: string[] } {
  const calls: ToolCall[] = [];
  const rawMatches: string[] = [];

  const inlineXmlTagPatterns = [
    /<tool_call>([\s\S]*?)<\/tool_call>/gi,
    /<longcat_tool_call>([\s\S]*?)<\/longcat_tool_call>/gi,
    /<\/function_call>([\s\S]*?)<\/function_call>/gi
  ];

  for (const pattern of inlineXmlTagPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      rawMatches.push(match[0]);
      const inner = match[1].trim();

      const nameEnd = inner.search(/[\s\n\r<]/);
      const name = nameEnd === -1 ? inner : inner.slice(0, nameEnd).trim();
      if (!name) continue;

      const params: Record<string, unknown> = {};
      const keyValuePattern = /<longcat_arg_key>([\s\S]*?)<\/longcat_arg_key>\s*<longcat_arg_value>([\s\S]*?)<\/longcat_arg_value>/gi;
      let kvMatch: RegExpExecArray | null;
      while ((kvMatch = keyValuePattern.exec(inner)) !== null) {
        const key = kvMatch[1].trim();
        const value = kvMatch[2].trim();
        if (key) params[key] = value;
      }

      if (Object.keys(params).length === 0) {
        const argsMatch = inner.match(/<longcat_arg_key>([\s\S]*?)<\/longcat_arg_key>\s*([\s\S]*?)(?=<longcat_arg_key>|$)/i);
        if (argsMatch) {
          const key = argsMatch[1].trim();
          const value = argsMatch[2].trim();
          if (key && value) params[key] = value;
        }
      }

      calls.push({
        id: crypto.randomUUID(),
        name,
        parameters: params
      });
    }
  }

  const nestedXmlTagPatterns = [
    /<toolCall>([\s\S]*?)<\/toolCall>/gi,
    /<tool_call>([\s\S]*?)<\/tool_call>/gi,
    /<\/function_call>([\s\S]*?)<\/function_call>/gi,
    /<invoke>([\s\S]*?)<\/invoke>/gi
  ];

  for (const pattern of nestedXmlTagPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      if (rawMatches.includes(match[0])) continue;
      rawMatches.push(match[0]);
      const inner = match[1].trim();

      const nameMatch = inner.match(/<name>([\s\S]*?)<\/name>/i);
      const idMatch = inner.match(/<id>([\s\S]*?)<\/id>/i);
      const toolName = nameMatch?.[1]?.trim();
      if (!toolName) continue;

      const params: Record<string, unknown> = {};
      const paramsBlockMatch = inner.match(/<parameters>([\s\S]*?)<\/parameters>/i);
      if (paramsBlockMatch) {
        const paramTags = paramsBlockMatch[1].match(/<(\w+)>([\s\S]*?)<\/\1>/gi) ?? [];
        for (const paramTag of paramTags) {
          const paramMatch = paramTag.match(/<(\w+)>([\s\S]*?)<\/\1>/i);
          if (paramMatch) {
            params[paramMatch[1]] = paramMatch[2].trim();
          }
        }
      }

      calls.push({
        id: idMatch?.[1]?.trim() || crypto.randomUUID(),
        name: toolName,
        parameters: params
      });
    }
  }

  const inlineToolPattern = /(?:<tool_call>|<toolCall>)?\s*call:([a-zA-Z0-9_]+)\{([\s\S]*?)\}\s*(?:<\/tool_call>|<\/toolCall>)?/gi;
  let inlineMatch: RegExpExecArray | null;
  while ((inlineMatch = inlineToolPattern.exec(content)) !== null) {
    if (rawMatches.includes(inlineMatch[0])) continue;
    rawMatches.push(inlineMatch[0]);
    const toolName = inlineMatch[1];
    const paramsStr = inlineMatch[2];

    const params: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(`{${paramsStr}}`);
      Object.assign(params, parsed);
    } catch {
      const paramMatches = Array.from(paramsStr.matchAll(/([a-zA-Z0-9_]+)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,\s{}]+)/g));
      for (const pMatch of paramMatches) {
        const key = pMatch[1];
        let value = pMatch[2];
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
        } else if (value === "true") {
          params[key] = true;
          continue;
        } else if (value === "false") {
          params[key] = false;
          continue;
        } else if (!Number.isNaN(Number(value))) {
          params[key] = Number(value);
          continue;
        }
        params[key] = value;
      }
    }

    calls.push({
      id: crypto.randomUUID(),
      name: toolName,
      parameters: params
    });
  }

  return { calls, rawMatches };
}

export function parseAssistantResponse(
  content: string,
  providerReasoning?: string,
  nativeToolCalls?: ToolCall[]
): ParsedAssistantResponse {
  const thinking = combineReasoning(providerReasoning, extractThinking(content));
  const cleanedContent = stripThinking(content);
  const hasToolCallMarkup = containsToolCallMarkup(cleanedContent);
  const sanitizedContent = stripResidualToolMarkup(cleanedContent);
  const needsContinuation = sanitizedContent.length === 0 && (Boolean(thinking) || hasToolCallMarkup);

  if (nativeToolCalls && nativeToolCalls.length > 0) {
    return {
      reasoning: thinking,
      toolCalls: nativeToolCalls,
      responseText: sanitizedContent
    };
  }

  try {
    const jsonMatch = cleanedContent.match(/\{[\s\S]*"toolCalls"[\s\S]*\}/);
    if (!jsonMatch) {
      const xmlResult = extractXmlToolCalls(cleanedContent);
      if (xmlResult.calls.length > 0) {
        let responseText = cleanedContent;
        for (const block of xmlResult.rawMatches) {
          responseText = responseText.replace(block, "");
        }
        return {
          reasoning: thinking,
          toolCalls: xmlResult.calls,
          responseText: stripResidualToolMarkup(responseText)
        };
      }

      return {
        reasoning: thinking,
        toolCalls: [],
        responseText: sanitizedContent,
        expectsToolUse: hasToolCallMarkup || looksLikeToolUseIntent(content, providerReasoning),
        needsContinuation,
        hasToolCallMarkup
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      // LLMs frequently produce malformed JSON (trailing commas, single quotes, etc.).
      // Attempt automated repair before reporting a parse error.
      const repaired = tryRepairJson(jsonMatch[0]);
      if (repaired === null) {
        throw new Error("JSON repair failed");
      }
      parsed = repaired;
    }
    const validation = safeParseToolCallEnvelope(parsed);
    if (!validation.success) {
      return {
        reasoning: thinking,
        toolCalls: [],
        responseText: sanitizedContent,
        parseError: `Tool call envelope validation failed: ${validation.issues}`,
        hasToolCallMarkup
      };
    }

    const toolCalls: ToolCall[] = validation.data.toolCalls.map((call) => ({
      id: call.id && call.id.trim().length > 0 ? call.id : crypto.randomUUID(),
      name: call.name,
      parameters: call.parameters ?? {}
    }));

    const reasoning = combineReasoning(validation.data.reasoning, thinking);

    // If the model over-emitted and we truncated, surface that to the UI
    // and to the model on its next turn so it can self-correct.
    if (validation.truncated) {
      const warning = `[system: ${validation.truncated.reason} The remaining tool calls were dropped — please retry them in subsequent turns if needed.]`;
      const reasoningWithWarning = reasoning
        ? `${reasoning}\n\n${warning}`
        : warning;
      return {
        reasoning: reasoningWithWarning,
        toolCalls,
        responseText: stripResidualToolMarkup(cleanedContent.replace(jsonMatch[0], "")),
        truncatedToolCalls: validation.truncated
      };
    }

    return {
      reasoning,
      toolCalls,
      responseText: stripResidualToolMarkup(cleanedContent.replace(jsonMatch[0], ""))
    };
  } catch (error) {
    if (cleanedContent.includes("toolCalls")) {
      return {
        reasoning: thinking,
        toolCalls: [],
        responseText: sanitizedContent,
        parseError: error instanceof Error ? error.message : "Failed to parse tool call JSON",
        hasToolCallMarkup
      };
    }
    return {
      reasoning: thinking,
      toolCalls: [],
      responseText: sanitizedContent,
      expectsToolUse: hasToolCallMarkup || looksLikeToolUseIntent(content, providerReasoning),
      needsContinuation,
      hasToolCallMarkup
    };
  }
}
