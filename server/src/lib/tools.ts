// Tool system for agentic capabilities

export type ToolParameter = {
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required?: boolean;
  enum?: string[];
  properties?: Record<string, ToolParameter>;
  items?: ToolParameter;
};

export type ToolRiskLevel = "none" | "read" | "write" | "destructive" | "network";

/**
 * Coarse-grained error taxonomy. Used by the retry layer to decide whether to
 * retry (transient/rate_limit/timeout) or fail fast (validation/permission/
 * not_found/fatal). See research doc T5 and the agentic-reliability SKILL.
 */
export type ToolErrorCategory =
  | "transient"        // 5xx, ECONNRESET, fetch failed
  | "rate_limit"       // 429
  | "timeout"          // exceeded time budget
  | "validation"       // 400-class — fix the input, do not retry
  | "permission"       // 401/403, EACCES
  | "not_found"        // 404, ENOENT
  | "fatal";           // unclassified non-retryable

/**
 * Coarse-grained category used to group tools in the registry and to filter
 * the available tool set by mode. `chat` mode only exposes `web` and
 * `system`; `plan` mode exposes a curated allowlist; `agent` mode
 * exposes everything.
 *
 * The "browser" / "document" / "media" / "integration" / "scheduler" /
 * "notification" categories were added in the §2.x of the upgrade plan.
 */
export type ToolCategory =
  | "filesystem"
  | "code"
  | "shell"
  | "web"
  | "system"
  | "browser"
  | "document"
  | "media"
  | "scheduler"
  | "integration"
  | "notification";

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  category: ToolCategory;
  requiresApproval?: boolean;
  riskLevel?: ToolRiskLevel;
  /**
   * Optional per-tool default timeout in milliseconds. Overrides the global
   * fallback in timeout.ts.
   */
  defaultTimeoutMs?: number;
  /**
   * Optional per-tool retry policy. Overrides the category-based defaults in
   * retry.ts.
   */
  retryPolicy?: "default" | "aggressive" | "none";
};

export type ToolResult = {
  success: boolean;
  data?: unknown;
  error?: string;
  output?: string;
  /** Coarse error category — filled by executeWithResilience(). */
  errorCategory?: ToolErrorCategory;
  /** True when the agent should stop retrying on this error. */
  fatal?: boolean;
  /** Time the call took in ms (filled by executeWithResilience). */
  durationMs?: number;
  /**
   * Actionable next-step hints surfaced alongside the error. Tools populate
   * this with 1-3 short imperative sentences that the agent can use to
   * self-correct. E.g. ["Call read_file to confirm the file exists", "Check
   * that the path is relative to the workspace root"].
   */
  suggestions?: string[];
};

export type AgentExecutionMode = "chat" | "agent" | "plan";

export type ToolLlmContext = {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  fallbackApiKeys?: Array<{ apiKeyEncrypted: string; id: string }>;
  encryptionSecret?: string;
};

export type ToolExecutionContext = {
  workspaceRoot: string;
  userId: string;
  conversationId: string;
  /**
   * Stable identifier for the current agent run. Used to key in-memory
   * checkpoint handles so the user can roll back to a previous file state
   * if a later step fails. Falls back to `conversationId` when not set.
   */
  runId?: string;
  mode?: AgentExecutionMode;
  allowOutsideWorkspace?: boolean;
  agentDepth?: number;
  llm?: ToolLlmContext;
};

function getValueType(value: unknown): ToolParameter["type"] | "null" | "undefined" | "function" | "symbol" | "bigint" {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validateParameter(value: unknown, schema: ToolParameter, path: string, errors: string[]) {
  const actualType = getValueType(value);

  if (value === null || value === undefined) {
    if (schema.required) {
      errors.push(`Missing required parameter: ${path}`);
    }
    return;
  }

  if (actualType !== schema.type) {
    errors.push(`Parameter ${path} should be ${schema.type}, got ${actualType}`);
    return;
  }

  if (schema.enum && schema.type === "string" && typeof value === "string" && !schema.enum.includes(value)) {
    errors.push(`Parameter ${path} must be one of: ${schema.enum.join(", ")}`);
  }

  if (schema.type === "object" && schema.properties && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const [childKey, childSchema] of Object.entries(schema.properties)) {
      validateParameter(record[childKey], childSchema, `${path}.${childKey}`, errors);
    }
  }

  if (schema.type === "array" && schema.items && Array.isArray(value)) {
    value.forEach((item, index) => validateParameter(item, schema.items as ToolParameter, `${path}[${index}]`, errors));
  }
}

function validateToolDefinition(definition: ToolDefinition) {
  if (!definition.name.trim()) throw new Error("Tool definition is missing a name");
  if (!definition.description.trim()) throw new Error(`Tool ${definition.name} is missing a description`);
  for (const [paramName, param] of Object.entries(definition.parameters)) {
    if (!paramName.trim()) throw new Error(`Tool ${definition.name} has an empty parameter name`);
    if (!param.description.trim()) throw new Error(`Tool ${definition.name}.${paramName} is missing a description`);
  }
}

// Base tool executor interface
export abstract class Tool {
  abstract definition: ToolDefinition;
  
  abstract execute(
    params: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult>;

  validate(params: Record<string, unknown>): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];
    
    for (const [key, schema] of Object.entries(this.definition.parameters)) {
      validateParameter(params[key], schema, key, errors);
    }
    
    return errors.length > 0 ? { valid: false, errors } : { valid: true };
  }
}

// Tool registry
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    const name = tool.definition.name;
    if (this.tools.has(name)) {
      throw new Error(`Duplicate tool registered: ${name}`);
    }
    validateToolDefinition(tool.definition);
    this.tools.set(name, tool);
  }

  /**
   * Remove a tool from the registry. Intended for tests; production code
   * should leave the registry alone.
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(tool => tool.definition);
  }

  listByCategory(category: string): ToolDefinition[] {
    return this.list().filter(def => def.category === category);
  }

  listForMode(mode: AgentExecutionMode): ToolDefinition[] {
    if (mode === "chat") {
      return this.list().filter(def => def.category === "web" || def.category === "system");
    }

    if (mode === "plan") {
      const allowedTools = new Set([
        "read_file",
        "read_image",
        "list_directory",
        "search_files",
        "search_content",
        "fetch_url",
        "web_search",
        "think",
        "ask_user",
        "add_task",
        "update_task",
        "list_tasks",
        "summarize_progress",
        "delegate_task",
        "get_agent_status",
        "git_status",
        "git_diff",
        "git_log",
        "git_branch",
        "list_changed_files",
        "read_lints",
        "read_document"
      ]);

      return this.list().filter((def) => allowedTools.has(def.name));
    }

    return this.list();
  }

  getToolRiskLevel(name: string): ToolRiskLevel {
    return this.tools.get(name)?.definition.riskLevel ?? "write";
  }

  isToolReadOnly(name: string): boolean {
    const risk = this.getToolRiskLevel(name);
    return risk === "none" || risk === "read";
  }
}

// Global registry instance
export const toolRegistry = new ToolRegistry();

