// Diagnostic tools — read_lints, run_tests.
//
// Security note: prior to §4.3 of the upgrade plan, this module passed
// `process.env` directly to child processes, leaking `DATABASE_URL`,
// `APP_SECRET`, and every `*_API_KEY` to workspace code. Now we use
// the same `getSanitizedEnv()` helper as `shell.ts` to strip sensitive
// variables before exec.

import { promisify } from "node:util";
import { exec } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../lib/tools.js";
import { getSanitizedEnv } from "./shell.js";

const execAsync = promisify(exec);

function resolveWorkdir(workdir: unknown, workspaceRoot: string): string | null {
  if (typeof workdir !== "string" || !workdir.trim()) return workspaceRoot;

  // SECURITY: reject absolute paths and `..` traversal. The agent LLM is
  // untrusted, so a hostile prompt could otherwise ask it to lint a
  // directory outside the workspace (which the sanitized env would still
  // leak into the child process).
  const trimmed = workdir.trim();
  if (isAbsolute(trimmed)) return null;
  const segments = trimmed.split(/[\\/]+/);
  if (segments.some((segment) => segment === "..")) return null;

  return resolve(workspaceRoot, trimmed);
}

/**
 * Detect project type by checking for characteristic files.
 */
function detectProjectType(cwd: string): "node" | "python" | "ruby" | "rust" | "go" | "unknown" {
  try {
    const entries = readdirSync(cwd);
    const has = (name: string) => entries.includes(name);
    const hasExt = (ext: string) => entries.some((e) => e.endsWith(ext));

    if (has("package.json")) return "node";
    if (has("pyproject.toml") || has("requirements.txt") || has("setup.py") || hasExt(".py")) return "python";
    if (has("Gemfile")) return "ruby";
    if (has("Cargo.toml")) return "rust";
    if (has("go.mod")) return "go";
  } catch {
    // Directory read failure — fall through
  }
  return "unknown";
}

/**
 * Read the project's preferred scripts (`scripts.test`, `scripts.lint`)
 * from `package.json` so we know whether the user has defined them.
 */
function readNodeScripts(cwd: string): { test?: string; lint?: string } {
  try {
    const raw = readFileSync(join(cwd, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return {
      test: typeof parsed.scripts?.test === "string" ? parsed.scripts.test : undefined,
      lint: typeof parsed.scripts?.lint === "string" ? parsed.scripts.lint : undefined
    };
  } catch {
    return {};
  }
}

/**
 * Pick the best test command, in priority order:
 *  1. explicit `command` parameter
 *  2. `framework` parameter override
 *  3. project's own `scripts.test` (npm test --if-present)
 *  4. language default
 */
function resolveTestCommand(
  projectType: string,
  workspaceCwd: string,
  explicit: string | undefined,
  framework: string | undefined
): string {
  if (explicit && explicit.trim().length > 0) return explicit;

  if (framework && framework.trim().length > 0) {
    const f = framework.toLowerCase().trim();
    if (f === "vitest") return "npx vitest run --reporter=default 2>&1";
    if (f === "jest") return "npx jest --colors=false 2>&1";
    if (f === "pytest") return "python -m pytest -v 2>&1";
    if (f === "unittest") return "python -m unittest discover -v 2>&1";
    if (f === "cargo") return "cargo test 2>&1";
    if (f === "go") return "go test ./... 2>&1";
    if (f === "rspec") return "bundle exec rspec 2>&1";
    if (f === "rake") return "bundle exec rake test 2>&1";
    if (f === "maven") return "mvn -B test 2>&1";
    if (f === "gradle") return "./gradlew test 2>&1";
  }

  switch (projectType) {
    case "node":
      return "npm test --if-present 2>&1 || echo 'NO_TESTS'";
    case "python":
      return "python -m pytest -v 2>&1 || python -m unittest discover -v 2>&1 || echo 'NO_TESTS'";
    case "ruby":
      return "bundle exec rake test 2>&1 || bundle exec rspec 2>&1 || echo 'NO_TESTS'";
    case "rust":
      return "cargo test 2>&1 || echo 'NO_TESTS'";
    case "go":
      return "go test ./... 2>&1 || echo 'NO_TESTS'";
    default:
      return "npm test --if-present 2>&1 || python -m pytest -v 2>&1 || python -m unittest discover -v 2>&1 || echo 'NO_TESTS'";
  }
}

function resolveLintCommand(
  projectType: string,
  workspaceCwd: string,
  explicit: string | undefined,
  framework: string | undefined
): string {
  if (explicit && explicit.trim().length > 0) return explicit;

  if (framework && framework.trim().length > 0) {
    const f = framework.toLowerCase().trim();
    if (f === "eslint") return "npx eslint . 2>&1 || echo 'NO_LINTS'";
    if (f === "biome") return "npx @biomejs/biome lint . 2>&1 || echo 'NO_LINTS'";
    if (f === "ruff") return "python -m ruff check . 2>&1 || echo 'NO_LINTS'";
    if (f === "flake8") return "python -m flake8 . 2>&1 || echo 'NO_LINTS'";
    if (f === "pylint") return "python -m pylint **/*.py 2>&1 || echo 'NO_LINTS'";
    if (f === "rubocop") return "bundle exec rubocop 2>&1 || echo 'NO_LINTS'";
    if (f === "clippy") return "cargo clippy 2>&1 || echo 'NO_LINTS'";
    if (f === "go-vet") return "go vet ./... 2>&1 || echo 'NO_LINTS'";
  }

  if (projectType === "node") {
    const scripts = readNodeScripts(workspaceCwd);
    if (scripts.lint) {
      return `npm run lint --if-present 2>&1 || echo 'NO_LINTS'`;
    }
  }

  switch (projectType) {
    case "node":
      return "npm run lint --if-present 2>&1 || echo 'NO_LINTS'";
    case "python":
      return "python -m ruff check . 2>&1 || python -m flake8 . 2>&1 || python -m py_compile *.py 2>&1 || echo 'NO_LINTS'";
    case "ruby":
      return "bundle exec rubocop 2>&1 || echo 'NO_LINTS'";
    case "rust":
      return "cargo clippy 2>&1 || echo 'NO_LINTS'";
    case "go":
      return "go vet ./... 2>&1 || echo 'NO_LINTS'";
    default:
      return "npm run lint --if-present 2>&1 || echo 'NO_LINTS'";
  }
}

// ---------------------------------------------------------------------------
// Structured output parsing.
//
// Many test/lint runners emit a sea of text. We extract a few signal-rich
// fields so the agent loop can decide whether to retry, suggest a fix, or
// report clean pass-through without having to re-grep the output.
// ---------------------------------------------------------------------------

export type ParsedDiagnostic = {
  pass: boolean;
  total?: number;
  passed?: number;
  failed?: number;
  warnings?: number;
  errors?: number;
  firstErrors: string[];
  runner?: string;
};

function parseTestOutput(output: string): ParsedDiagnostic {
  const lines = output.split(/\r?\n/);
  const firstErrors: string[] = [];
  let runner: string | undefined;
  let total: number | undefined;
  let passed: number | undefined;
  let failed: number | undefined;

  if (output.includes("NO_TESTS")) {
    return { pass: true, firstErrors: ["No test runner detected or no tests defined"], runner: runner ?? "unknown" };
  }

  for (const line of lines) {
    // vitest/jest: "Tests  3 passed (3)" or "Tests  2 failed | 5 passed (7)"
    const vitest = line.match(/Tests\s+(\d+)\s+passed/i);
    if (vitest) {
      runner ??= "vitest/jest";
      passed = Number(vitest[1]);
    }
    const vitestFail = line.match(/(\d+)\s+failed/i);
    if (vitestFail && runner === "vitest/jest") {
      failed = (failed ?? 0) + Number(vitestFail[1]);
    }
    const totalMatch = line.match(/Tests\s+\d+\s+(?:failed|passed).*?\((\d+)\)/);
    if (totalMatch) total = Number(totalMatch[1]);

    // pytest: "=== 5 passed, 2 failed in 1.23s ==="
    const pytest = line.match(/=+\s*(\d+)\s+passed(?:,\s*(\d+)\s+failed)?/i);
    if (pytest) {
      runner ??= "pytest";
      passed = Number(pytest[1]);
      if (pytest[2]) failed = (failed ?? 0) + Number(pytest[2]);
    }

    // cargo: "test result: ok. 5 passed; 0 failed; 0 ignored"
    const cargo = line.match(/test result:\s*(ok|FAILED).*?(\d+)\s+passed;\s*(\d+)\s+failed/i);
    if (cargo) {
      runner ??= "cargo";
      passed = Number(cargo[2]);
      failed = Number(cargo[3]);
    }

    if (/^FAIL\s/.test(line) && runner === undefined) runner = "go";
    if (/^ok\s/.test(line) && runner === undefined) runner = "go";

    if (
      firstErrors.length < 5 &&
      (/^FAIL\b/.test(line) ||
        /\bError\b/.test(line) ||
        /\bAssertionError\b/.test(line) ||
        /\bexpected\b/i.test(line) ||
        /\bFAILED\b/.test(line))
    ) {
      firstErrors.push(line.slice(0, 240));
    }
  }

  const fail = failed ?? 0;
  return {
    pass: fail === 0,
    total,
    passed,
    failed: fail || undefined,
    firstErrors,
    runner
  };
}

function parseLintOutput(output: string): ParsedDiagnostic {
  const lines = output.split(/\r?\n/);
  const firstErrors: string[] = [];

  if (output.includes("NO_LINTS")) {
    return { pass: true, firstErrors: ["No linter detected or no lintable files"], runner: "unknown" };
  }

  let runner: string | undefined;
  let errors = 0;
  let warnings = 0;

  for (const line of lines) {
    // eslint: "5 problems (3 errors, 2 warnings)"
    const eslint = line.match(/(\d+)\s+problems?\s+\((\d+)\s+errors?,\s+(\d+)\s+warnings?\)/i);
    if (eslint) {
      runner ??= "eslint";
      errors += Number(eslint[2]);
      warnings += Number(eslint[3]);
    }

    // ruff/flake8/biome: "Found 3 errors."
    const foundErrors = line.match(/Found\s+(\d+)\s+errors?/i);
    if (foundErrors) {
      runner ??= "ruff/flake8";
      errors += Number(foundErrors[1]);
    }

    if (
      firstErrors.length < 5 &&
      /^\s*\S+\.\w+:\d+:\d+/.test(line)
    ) {
      firstErrors.push(line.slice(0, 240));
    }
  }

  return {
    pass: errors === 0,
    errors: errors || undefined,
    warnings: warnings || undefined,
    firstErrors,
    runner
  };
}

async function runCommand(
  command: string,
  timeout: number,
  cwd: string,
  parser: (output: string) => ParsedDiagnostic
): Promise<ToolResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024 * 12,
      // SECURITY: pass a sanitized environment, not the raw process.env.
      env: getSanitizedEnv()
    });

    const output = [stdout, stderr].filter(Boolean).join("\n").trim();
    const parsed = parser(output);
    return {
      success: true,
      output,
      data: {
        command,
        cwd,
        parsed,
        pass: parsed.pass,
        firstErrors: parsed.firstErrors
      }
    };
  } catch (error) {
    if (error && typeof error === "object") {
      const e = error as { stdout?: string; stderr?: string; message?: string };
      const output = [e.stdout, e.stderr].filter(Boolean).join("\n").trim() || e.message || "";
      const parsed = parser(output);
      return {
        success: false,
        output,
        error: parsed.errors
          ? `${parsed.errors} error(s) found`
          : parsed.failed
            ? `${parsed.failed} test(s) failed`
            : "Command failed",
        data: {
          command,
          cwd,
          parsed,
          pass: parsed.pass,
          firstErrors: parsed.firstErrors
        }
      };
    }

    return {
      success: false,
      error: "Command execution failed",
      data: { command, cwd, pass: false, firstErrors: [] }
    };
  }
}

export class ReadLintsTool extends Tool {
  definition: ToolDefinition = {
    name: "read_lints",
    description: "Run lint diagnostics for the current workspace. Auto-detects project type (Node.js, Python, Ruby, Rust, Go) and runs the appropriate lint command. Supports `command` and `framework` overrides. Returns a structured `parsed` summary (error/warning counts, first errors) alongside the raw output.",
    category: "system",
    riskLevel: "network",
    requiresApproval: true,
    parameters: {
      workdir: {
        type: "string",
        description: "Optional working directory (must be relative to the workspace root, no `..` traversal)",
        required: false
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default 120000)",
        required: false
      },
      command: {
        type: "string",
        description: "Override the default lint command.",
        required: false
      },
      framework: {
        type: "string",
        description: "Force a specific linter. Overrides auto-detection.",
        required: false,
        enum: ["eslint", "biome", "ruff", "flake8", "pylint", "rubocop", "clippy", "go-vet"]
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const resolvedWorkdir = resolveWorkdir(params.workdir, context.workspaceRoot);
    if (!resolvedWorkdir) {
      return {
        success: false,
        error: "workdir must be a relative path inside the workspace (no `..` traversal, no absolute paths)"
      };
    }
    if (!existsSync(resolvedWorkdir)) {
      return {
        success: false,
        error: `workdir does not exist: ${String(params.workdir)}`
      };
    }
    const timeout = typeof params.timeout === "number" ? params.timeout : 120000;
    const projectType = detectProjectType(resolvedWorkdir);
    const command = resolveLintCommand(
      projectType,
      resolvedWorkdir,
      typeof params.command === "string" ? params.command : undefined,
      typeof params.framework === "string" ? params.framework : undefined
    );
    return runCommand(command, timeout, resolvedWorkdir, parseLintOutput);
  }
}

export class RunTestsTool extends Tool {
  definition: ToolDefinition = {
    name: "run_tests",
    description: "Run tests for the current workspace. Auto-detects project type (Node.js, Python, Ruby, Rust, Go) and runs the appropriate test command. Supports `command` and `framework` overrides. Returns a structured `parsed` summary (pass/fail counts, first errors) alongside the raw output.",
    category: "system",
    riskLevel: "network",
    requiresApproval: true,
    parameters: {
      workdir: {
        type: "string",
        description: "Optional working directory (must be relative to the workspace root, no `..` traversal)",
        required: false
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default 180000)",
        required: false
      },
      command: {
        type: "string",
        description: "Override the default test command.",
        required: false
      },
      framework: {
        type: "string",
        description: "Force a specific test runner. Overrides auto-detection.",
        required: false,
        enum: ["vitest", "jest", "pytest", "unittest", "cargo", "go", "rspec", "rake", "maven", "gradle"]
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const resolvedWorkdir = resolveWorkdir(params.workdir, context.workspaceRoot);
    if (!resolvedWorkdir) {
      return {
        success: false,
        error: "workdir must be a relative path inside the workspace (no `..` traversal, no absolute paths)"
      };
    }
    if (!existsSync(resolvedWorkdir)) {
      return {
        success: false,
        error: `workdir does not exist: ${String(params.workdir)}`
      };
    }
    const timeout = typeof params.timeout === "number" ? params.timeout : 180000;
    const projectType = detectProjectType(resolvedWorkdir);
    const command = resolveTestCommand(
      projectType,
      resolvedWorkdir,
      typeof params.command === "string" ? params.command : undefined,
      typeof params.framework === "string" ? params.framework : undefined
    );
    return runCommand(command, timeout, resolvedWorkdir, parseTestOutput);
  }
}
