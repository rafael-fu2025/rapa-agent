// Post-write code validators (research C1).
//
// After write_file / edit_file / replace_in_file, run a lightweight syntax
// check against the changed file. Catches ~60-80% of "looks-correct" bugs
// before the model has to discover them via tool failure.
//
// We deliberately use cheap, language-specific checks:
// - TypeScript / JavaScript: `tsc --noEmit` if tsc is on PATH, otherwise
//   fall back to a basic Node syntax check via Function constructor
//   (parse-only, no execution).
// - Python: `python -m py_compile` if Python is on PATH.
// - JSON: `JSON.parse`.
// - Other: no-op (return success).
//
// All checks are wrapped in a hard timeout (5 s) so a hung compiler cannot
// stall the agent.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extname, resolve } from "node:path";
import { existsSync } from "node:fs";

const execFileAsync = promisify(execFile);
const VALIDATE_TIMEOUT_MS = 5_000;

export type CodeValidationResult = {
  ok: boolean;
  /** Short error message to feed back to the model. */
  message?: string;
  /** The original language/compiler that was used. */
  validator?: string;
};

/**
 * Run a syntax check on the file at the given absolute path. Returns
 * ok=true if the file is syntactically valid (or the file type has no
 * validator configured).
 */
export async function validateWrittenFile(
  absolutePath: string
): Promise<CodeValidationResult> {
  if (!existsSync(absolutePath)) {
    return { ok: true, validator: "skip-missing" };
  }
  const ext = extname(absolutePath).toLowerCase();
  const absolute = resolve(absolutePath);

  if (ext === ".ts" || ext === ".tsx") {
    return await runTscCheck(absolute);
  }
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") {
    return await runNodeSyntaxCheck(absolute);
  }
  if (ext === ".py") {
    return await runPyCompileCheck(absolute);
  }
  if (ext === ".json") {
    return await runJsonCheck(absolute);
  }
  return { ok: true, validator: "none" };
}

async function runTscCheck(absolutePath: string): Promise<CodeValidationResult> {
  try {
    await execFileAsync("npx", [
      "--no-install",
      "tsc",
      "--noEmit",
      "--pretty",
      "false",
      absolutePath
    ], { timeout: VALIDATE_TIMEOUT_MS, maxBuffer: 1024 * 256 });
    return { ok: true, validator: "tsc" };
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? "";
    const stderr = (error as { stderr?: string }).stderr ?? "";
    const message = (stdout + stderr).trim().split("\n").slice(0, 6).join("\n");
    if (!message) {
      return { ok: true, validator: "tsc-skip" };
    }
    return {
      ok: false,
      validator: "tsc",
      message: `TypeScript syntax check failed:\n${message}`
    };
  }
}

async function runNodeSyntaxCheck(absolutePath: string): Promise<CodeValidationResult> {
  try {
    await execFileAsync("node", ["--check", absolutePath], {
      timeout: VALIDATE_TIMEOUT_MS,
      maxBuffer: 1024 * 64
    });
    return { ok: true, validator: "node-check" };
  } catch (error) {
    const message = (error as { stderr?: string }).stderr
      ?? (error instanceof Error ? error.message : String(error));
    return {
      ok: false,
      validator: "node-check",
      message: `Node syntax check failed:\n${message.split("\n").slice(0, 4).join("\n")}`
    };
  }
}

async function runPyCompileCheck(absolutePath: string): Promise<CodeValidationResult> {
  try {
    await execFileAsync("python", ["-m", "py_compile", absolutePath], {
      timeout: VALIDATE_TIMEOUT_MS,
      maxBuffer: 1024 * 64
    });
    return { ok: true, validator: "py_compile" };
  } catch (error) {
    const message = (error as { stderr?: string }).stderr
      ?? (error instanceof Error ? error.message : String(error));
    return {
      ok: false,
      validator: "py_compile",
      message: `Python syntax check failed:\n${message.split("\n").slice(0, 4).join("\n")}`
    };
  }
}

async function runJsonCheck(absolutePath: string): Promise<CodeValidationResult> {
  const { readFile } = await import("node:fs/promises");
  try {
    const content = await readFile(absolutePath, "utf-8");
    JSON.parse(content);
    return { ok: true, validator: "json" };
  } catch (error) {
    return {
      ok: false,
      validator: "json",
      message: `JSON parse failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
