// Agent reasoning and communication tools

import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../lib/tools.js";

// Normalization helpers for the structured ask_user schema
// (multi-question, per-option label/description/preview, per-question header + multiSelect).

const THINK_TAG_PATTERN = /<(thinking|think)>[\s\S]*?<\/\1>/gi;

const HEADER_MAX_CHARS = 12;
const LABEL_MAX_CHARS = 80;
const QUESTION_MAX_CHARS = 500;
const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

function cleanAskUserText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(THINK_TAG_PATTERN, " ")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

function cleanAskUserMultilineText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(THINK_TAG_PATTERN, " ")
    .replace(/\r?\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

type AskUserOption = { label: string; description?: string; preview?: string; defaultOption?: boolean };

// Pull an array out of either a direct array or a single-key wrapper object
// (e.g. `{ item: [...] }`, `{ items: [...] }`, `{ choices: [...] }`).
// LLM JSON output often wraps the array under a synonym or makes a singular/plural
// typo, so we recover gracefully instead of failing the whole tool call.
function unwrapToArray(value: unknown): unknown[] | undefined {
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

function normalizeAskUserOption(value: unknown): AskUserOption | null {
  if (typeof value === "string") {
    const text = cleanAskUserText(value);
    return text ? { label: text } : null;
  }

  if (Array.isArray(value)) {
    // Sometimes the LLM wraps a single option in an array — unwrap to the first.
    return normalizeAskUserOption(value[0]);
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const label = cleanAskUserText(
    record.label ?? record.title ?? record.text ?? record.value ?? record.name ?? record.heading ?? record.option ?? record.choice
  );
  if (!label) return null;

  const description = cleanAskUserText(
    record.description ?? record.details ?? record.helperText ?? record.subtitle ?? record.summary
  );
  const preview = cleanAskUserMultilineText(
    record.preview ?? record.snippet ?? record.example ?? record.body
  );
  const defaultOption = record.defaultOption === true || record.isDefault === true || record.recommended === true;

  return {
    label,
    ...(description ? { description } : {}),
    ...(preview ? { preview } : {}),
    ...(defaultOption ? { defaultOption: true } : {})
  };
}

function normalizeAskUserOptions(value: unknown): AskUserOption[] | undefined {
  const array = unwrapToArray(value);
  if (!array) return undefined;
  const normalized = array
    .map((item) => normalizeAskUserOption(item))
    .filter((item): item is AskUserOption => Boolean(item));
  return normalized.length > 0 ? normalized : undefined;
}

type AskUserQuestion = {
  question: string;
  header: string;
  options: AskUserOption[];
  multiSelect: boolean;
};

function normalizeAskUserHeader(value: unknown, fallback: string): string {
  const text = cleanAskUserText(value);
  if (!text) return fallback;
  return text.length > HEADER_MAX_CHARS ? text.slice(0, HEADER_MAX_CHARS) : text;
}

function normalizeAskUserQuestion(value: unknown, index: number): AskUserQuestion | null {
  if (typeof value === "string") {
    const text = cleanAskUserText(value);
    return text ? { question: text, header: `Q${index + 1}`, options: [], multiSelect: false } : null;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const question = cleanAskUserText(
    record.question ?? record.text ?? record.prompt ?? record.label ?? record.title
  );
  if (!question) return null;

  const header = normalizeAskUserHeader(
    record.header ?? record.chip ?? record.tag ?? record.category,
    `Q${index + 1}`
  );
  const options = normalizeAskUserOptions(record.options) ?? [];
  const multiSelect = typeof record.multiSelect === "boolean"
    ? record.multiSelect
    : typeof record.isMultiSelect === "boolean"
      ? record.isMultiSelect
      : false;

  return { question, header, options, multiSelect };
}

function normalizeAskUserQuestions(value: unknown): AskUserQuestion[] | undefined {
  // Accept either an array of questions or a single question object
  // (legacy { question, options, isMultiSelect } shape) for backwards compat.
  if (value && !Array.isArray(value) && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("question" in obj || "options" in obj) {
      const single = normalizeAskUserQuestion(obj, 0);
      return single ? [single] : undefined;
    }
  }

  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map((item, index) => normalizeAskUserQuestion(item, index))
    .filter((item): item is AskUserQuestion => Boolean(item));
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * ThinkTool - Allows the agent to reason through problems without taking action.
 * This tool is used for internal deliberation and planning.
 */
export class ThinkTool extends Tool {
  definition: ToolDefinition = {
    name: "think",
    description: "Use this tool to think through a problem step by step without taking any action. Useful for planning, analyzing complex situations, or working through decisions before executing tools. The thought will be recorded and you can continue reasoning.",
    category: "system",
    riskLevel: "none",
    parameters: {
      thought: {
        type: "string",
        description: "Your reasoning, analysis, or planning thoughts. Be detailed and structured.",
        required: true
      }
    }
  };

  async execute(params: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
    const thought = (params.thought as string | undefined)?.trim();

    if (!thought) {
      return {
        success: false,
        error: "A thought is required"
      };
    }

    // The think tool simply echoes back the thought, allowing the agent
    // to see its own reasoning in the tool result and continue from there
    return {
      success: true,
      data: {
        thought,
        message: "Thought recorded. Continue with your reasoning or proceed to action."
      }
    };
  }
}

/**
 * AskUserTool - Allows the agent to request clarification from the user.
 * Use when the request is ambiguous or more information is needed.
 *
 * Schema (mirrors the structured interactive question format):
 *   questions: [
 *     {
 *       question: string,        // full question text shown to the user
 *       header: string,          // short chip label (max 12 chars)
 *       options: [               // 2-4 choices
 *         { label: string, description?: string, preview?: string }
 *       ],
 *       multiSelect: boolean     // allow multiple selections
 *     }
 *   ]   // 1-4 questions per call
 */
export class AskUserTool extends Tool {
  definition: ToolDefinition = {
    name: "ask_user",
    description: `Ask the user one or more structured clarifying questions (1-4 questions per call). Each question needs a short header chip (max 12 chars), a full question, 2-4 options with label/description/preview, and a multiSelect flag. Use this when you need user input, when the request is ambiguous, or to confirm your understanding before significant action.`,
    category: "system",
    riskLevel: "none",
    parameters: {
      questions: {
        type: "array",
        items: {
          type: "object",
          description: "A single structured question",
          properties: {
            question: { type: "string", description: "The full question shown to the user" },
            header: { type: "string", description: "A short label (max 12 chars) displayed as a chip" },
            options: {
              type: "array",
              description: "2-4 selectable options for this question",
              items: {
                type: "object",
                description: "A selectable option",
                properties: {
                  label: { type: "string", description: "Short button text (1-5 words, max 80 chars)" },
                  description: { type: "string", description: "One-line explanation of what this option means" },
                  preview: { type: "string", description: "Optional larger preview (e.g. code snippet) shown when expanded" },
                  defaultOption: { type: "boolean", description: "Set to true to mark this option as the recommended/default choice" }
                }
              }
            },
            multiSelect: { type: "boolean", description: "Set to true to allow the user to select multiple options" }
          }
        },
        description: `An array of ${MIN_QUESTIONS}-${MAX_QUESTIONS} structured questions. Each question must have 2-${MAX_OPTIONS} options.`,
        required: true
      }
    }
  };

  override validate(params: Record<string, unknown>): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];

    // Require questions to be an array (pre-normalization)
    if (!params.questions) {
      errors.push("Missing required parameter: questions (must be an array of 1-4 question objects, each with 'question', 'header', 'options', and 'multiSelect')");
      return { valid: false, errors };
    }

    if (!Array.isArray(params.questions)) {
      // Allow single-object legacy shape but flag if it's clearly wrong
      if (typeof params.questions === "object" && params.questions !== null) {
        // Will be normalized — proceed
      } else {
        errors.push("Parameter 'questions' must be an array of question objects. Example: [{ question: 'Which approach?', header: 'Approach', options: [{ label: 'Option A', description: '...' }, { label: 'Option B', description: '...' }], multiSelect: false }]");
        return { valid: false, errors };
      }
    }

    const normalized = normalizeAskUserQuestions(params.questions);
    if (!normalized) {
      errors.push("Could not parse 'questions'. Each question needs: { question: string, header: string (max 12 chars), options: [{ label: string, description?: string }], multiSelect: boolean }");
      return { valid: false, errors };
    }

    if (normalized.length < MIN_QUESTIONS || normalized.length > MAX_QUESTIONS) {
      errors.push(`Expected ${MIN_QUESTIONS}-${MAX_QUESTIONS} questions, got ${normalized.length}. Split into multiple ask_user calls if you need more.`);
    }

    normalized.forEach((q, index) => {
      const prefix = `Question ${index + 1}`;

      // Question text validation
      if (!q.question.trim()) {
        errors.push(`${prefix}: 'question' text must not be empty`);
      } else if (q.question.length > QUESTION_MAX_CHARS) {
        errors.push(`${prefix}: 'question' text exceeds ${QUESTION_MAX_CHARS} chars (${q.question.length}). Shorten it.`);
      }

      // Header validation (strict max length)
      if (!q.header.trim()) {
        errors.push(`${prefix}: 'header' must not be empty. Use a 1-${HEADER_MAX_CHARS} char chip label like "Auth", "Style", "DB".`);
      } else if (q.header.length > HEADER_MAX_CHARS) {
        errors.push(`${prefix}: 'header' exceeds ${HEADER_MAX_CHARS} chars ("${q.header}" = ${q.header.length} chars). Shorten to a chip label.`);
      }

      // Options validation
      if (q.options.length < MIN_OPTIONS) {
        errors.push(`${prefix}: needs at least ${MIN_OPTIONS} options, got ${q.options.length}. Add more choices.`);
      } else if (q.options.length > MAX_OPTIONS) {
        errors.push(`${prefix}: max ${MAX_OPTIONS} options, got ${q.options.length}. Split into multiple questions or reduce choices.`);
      }

      let defaultCount = 0;
      q.options.forEach((option, optIndex) => {
        if (!option.label.trim()) {
          errors.push(`${prefix} option ${optIndex + 1}: 'label' must not be empty`);
        } else if (option.label.length > LABEL_MAX_CHARS) {
          errors.push(`${prefix} option ${optIndex + 1}: 'label' exceeds ${LABEL_MAX_CHARS} chars. Keep it to 1-5 words.`);
        }
        if (option.defaultOption) defaultCount++;
      });

      if (defaultCount > 1) {
        errors.push(`${prefix}: only one option can have 'defaultOption: true'. Pick the recommended one.`);
      }
    });

    return errors.length > 0 ? { valid: false, errors } : { valid: true };
  }

  async execute(params: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
    const normalized = normalizeAskUserQuestions(params.questions);
    if (!normalized || normalized.length === 0) {
      return {
        success: false,
        error: "At least one structured question is required"
      };
    }

    // Ensure each question has 2-4 options; if any are missing, the request is malformed.
    const invalid = normalized.find((q) => q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS);
    if (invalid) {
      return {
        success: false,
        error: `Each question must have ${MIN_OPTIONS}-${MAX_OPTIONS} options`
      };
    }

    return {
      success: true,
      data: {
        questions: normalized,
        status: "awaiting_response",
        message: "Questions have been presented to the user. Wait for their response before continuing."
      }
    };
  }
}

/**
 * SummarizeProgressTool - Allows the agent to summarize completed work.
 * Useful for consolidating progress on multi-step tasks.
 */
export class SummarizeProgressTool extends Tool {
  definition: ToolDefinition = {
    name: "summarize_progress",
    description: "Summarize the progress made so far on the current task. Use this to consolidate completed work, provide a checkpoint, or give the user a clear picture of what has been accomplished and what remains.",
    category: "system",
    riskLevel: "none",
    parameters: {
      summary: {
        type: "string",
        description: "A clear summary of the work completed, including: what was done, any important findings, and what steps remain (if any).",
        required: true
      }
    }
  };

  async execute(params: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
    const summary = (params.summary as string | undefined)?.trim();

    if (!summary) {
      return {
        success: false,
        error: "A summary is required"
      };
    }

    return {
      success: true,
      data: {
        summary,
        timestamp: new Date().toISOString(),
        message: "Progress summary recorded."
      }
    };
  }
}

export class SummarizeConversationTool extends Tool {
  definition: ToolDefinition = {
    name: "summarize_conversation",
    description: "Generate a structured summary of the entire conversation so far, including: user requests, key decisions, completed tasks, files modified, errors encountered, and remaining work. Use this when the user asks for a recap, when you need to provide context to another agent, or before ending a long session.",
    category: "system",
    riskLevel: "none",
    parameters: {
      format: {
        type: "string",
        description: "The output format for the summary. Use 'structured' for a detailed breakdown with sections, or 'concise' for a brief overview. Defaults to 'structured'.",
        required: false,
        enum: ["structured", "concise"]
      }
    }
  };

  async execute(params: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
    const format = (params.format as string) ?? "structured";

    if (format === "concise") {
      return {
        success: true,
        data: {
          format: "concise",
          timestamp: new Date().toISOString(),
          message: "Concise conversation summary requested. Provide a brief overview covering: what the user asked for, what was accomplished, any issues encountered, and what remains."
        }
      };
    }

    return {
      success: true,
      data: {
        format: "structured",
        timestamp: new Date().toISOString(),
        sections: [
          "Primary Request and Intent",
          "Key Technical Concepts",
          "Files and Code Sections: list each file touched, why, what changed, and relevant code snippets",
          "Errors and fixes: each error encountered, root cause, and resolution",
          "Problem Solving: notable debugging or refactoring approaches",
          "All User Messages: chronological list of every user message in this conversation",
          "Pending Tasks: any work requested but not yet completed",
          "Current State: summary of where the conversation stands right now",
          "Optional Next Steps: if there are natural follow-up tasks, list them"
        ],
        message: "Structured conversation summary requested. Please provide a detailed summary using the sections provided, paying special attention to files modified, code changes, and error resolutions."
      }
    };
  }
}
