// Shell execution tools and terminal session management

import { exec, execSync, spawn } from "node:child_process";
import os from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../lib/tools.js";
import { Suggest } from "../lib/suggestions.js";
import { isWithinWorkspaceSymlinkSafe, resolveWorkspacePath, toWorkspaceRelativePath } from "./filesystem.js";


const execAsync = promisify(exec);
const MAX_BUFFER = 1024 * 1024 * 2;

type SessionMode = "pty" | "shell" | "pipe";

type TerminalProcessLike = {
  pid?: number;
  write: (data: string) => void;
  kill: () => void;
  resize?: (cols: number, rows: number) => void;
  onData: (listener: (data: string) => void) => void;
  onExit: (listener: () => void) => void;
};

type TerminalSession = {
  id: string;
  cwd: string;
  ownerId: string;
  conversationId: string;
  process: TerminalProcessLike;
  buffer: string;
  closed: boolean;
  mode: SessionMode;
  listeners: Set<(data: string) => void>;
  createdAt: number;
  updatedAt: number;
};

export type TerminalSessionInfo = {
  sessionId: string;
  cwd: string;
  mode: SessionMode;
  closed: boolean;
  pid?: number;
  createdAt: string;
  updatedAt: string;
  shell: string;
  platform: string;
};

const sessions = new Map<string, TerminalSession>();

let cachedShell: string | undefined;

const getShell = () => {
  if (cachedShell) return cachedShell;

  if (process.platform === "win32") {
    // Prefer PowerShell (pwsh or powershell) over cmd.exe for PSReadLine support
    // which provides syntax coloring, command prediction, and tab completion.
    for (const shell of ["pwsh.exe", "powershell.exe"]) {
      try {
        execSync(`where ${shell}`, { stdio: "ignore" });
        cachedShell = shell;
        return cachedShell;
      } catch {
        // Not found, try next
      }
    }
    cachedShell = process.env.ComSpec || "cmd.exe";
    return cachedShell;
  }

  cachedShell = process.env.SHELL || "/bin/bash";
  return cachedShell;
};

// ---------------------------------------------------------------------------
// Environment sanitization.
//
// Shell sessions and spawned commands must NOT inherit sensitive server-side
// environment variables (database credentials, API keys, secrets). We build
// a sanitized copy that strips anything matching known sensitive patterns.
// ---------------------------------------------------------------------------

const SENSITIVE_ENV_PATTERNS = [
  /^APP_SECRET$/i,
  /^DATABASE_URL$/i,
  /^MYSQL_/i,
  /^POSTGRES_/i,
  /^MONGO_/i,
  /^REDIS_/i,
  /API_KEY/i,
  /API_SECRET/i,
  /PRIVATE_KEY/i,
  /ACCESS_TOKEN/i,
  /^JWT_SECRET$/i,
  /^ENCRYPTION_KEY$/i,
  /^LANGFUSE_/i,
];

function getSanitizedEnv(): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const isSensitive = SENSITIVE_ENV_PATTERNS.some((pattern) => pattern.test(key));
    if (!isSensitive) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

// Exported for other tool modules (e.g. diagnostics.ts) so the same
// sensitive-variable stripping rules are applied uniformly across every
// tool that spawns a child process. Tests cover the patterns via this
// shared list.
export { getSanitizedEnv, SENSITIVE_ENV_PATTERNS };

const getCommandSeparator = () => {
  if (process.platform === "win32") {
    const shell = getShell().toLowerCase();
    if (shell.includes("powershell") || shell.includes("pwsh")) return ";";
    return "&";
  }

  return ";";
};

/**
 * Strip ANSI escape codes and terminal control sequences from PTY output.
 * Windows PowerShell/PSReadLine produces many types of noise:
 * - SGR color codes (ESC[...m)
 * - Cursor positioning (ESC[...H, ESC[...J)
 * - OSC sequences for terminal title (ESC]0;...BEL)
 * - Braille spinner characters (U+2800-U+28FF) from npm progress spinners
 * - Various C0/C1 control characters
 */
const ANSI_CSI_PATTERN = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const ANSI_OSC_PATTERN = /\u001b\][^\x07\u001b]*(?:\x07|\u001b\\)/g;
const BRAILLE_PATTERN = /[\u2800-\u28FF]/g;
const C0_CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function stripAnsi(text: string): string {
  return text
    .replace(ANSI_OSC_PATTERN, "")    // OSC sequences (terminal title etc.)
    .replace(ANSI_CSI_PATTERN, "")     // CSI sequences (colors, cursor, etc.)
    .replace(BRAILLE_PATTERN, "")      // Braille spinner characters
    .replace(C0_CONTROL_PATTERN, "");  // Remaining control characters
}

/**
 * Normalize PTY output for the LLM. Aggressively strips all PTY noise:
 * 1. ANSI/control sequences (colors, cursor, spinners, OSC)
 * 2. The command echo line (the wrapped command we sent)
 * 3. The marker echo line and any line containing the marker prefix
 * 4. PowerShell prompt lines (PS C:\...>)
 * 5. Bare ">>" continuation prompts and ">> command" echoes
 * 6. Single-character keystroke echoes (w, p, l, etc.)
 * 7. Excessive blank lines collapsed to single blanks
 */
const MARKER_PREFIX = "__CODEBUDDY_DONE_";

const normalizeOutput = (output: string, marker: string) => {
  let cleaned = stripAnsi(output);

  // Remove \r and normalize line endings
  cleaned = cleaned.replaceAll("\r", "");

  // Split into lines and filter noise
  const lines = cleaned.split("\n");
  const filtered: string[] = [];
  let consecutiveBlanks = 0;
  let isFirstContent = true;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip ANY line containing the marker prefix (command echo, marker echo, etc.)
    if (trimmed.includes(MARKER_PREFIX)) continue;

    // Skip the exact marker line
    if (trimmed.includes(marker)) continue;

    // Skip PowerShell/cmd prompt lines (PS C:\...> or C:\...>)
    // Also skip prompt + command echo (PS C:\...>node --version && ...)
    if (/^(PS\s+)?[A-Z]:\\.*>/.test(trimmed)) continue;

    // Skip bare ">>" continuation prompts
    if (trimmed === ">>") continue;

    // Skip ">> command..." echo lines (PowerShell continuation prompt + command)
    if (trimmed.startsWith(">>")) continue;

    // Skip single-character or very short keystroke echoes (1-3 chars)
    // These appear when the PTY echoes individual keystrokes as they're typed
    if (trimmed.length > 0 && trimmed.length <= 3 && /^[a-zA-Z&|;]$/.test(trimmed)) continue;

    // Collapse multiple blank lines into one
    if (trimmed === "") {
      consecutiveBlanks++;
      if (consecutiveBlanks <= 1) filtered.push("");
      continue;
    }
    consecutiveBlanks = 0;

    // Skip leading noise (keystroke echoes before first real output)
    if (isFirstContent && trimmed.length <= 5 && !trimmed.includes(" ")) {
      continue;
    }
    isFirstContent = false;

    filtered.push(line);
  }

  // Trim leading/trailing blank lines
  while (filtered.length > 0 && filtered[0].trim() === "") filtered.shift();
  while (filtered.length > 0 && filtered[filtered.length - 1].trim() === "") filtered.pop();

  return filtered.join("\n");
};

/**
 * Head+tail truncation for large command output. Preserves the start (initial
 * context, errors) and end (final results, exit status) while truncating the
 * middle. This matches the odysseus pattern: 8K head + 8K tail with a
 * truncation marker in between.
 */
const MAX_OUTPUT_CHARS = 16_000;
const HEAD_CHARS = 8_000;
const TAIL_CHARS = 8_000;

function headTailTruncate(text: string, maxChars = MAX_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, HEAD_CHARS);
  const tail = text.slice(-TAIL_CHARS);
  const truncatedChars = text.length - HEAD_CHARS - TAIL_CHARS;
  return `${head}\n\n... [${truncatedChars} chars truncated] ...\n\n${tail}`;
}

function touchSession(session: TerminalSession) {
  session.updatedAt = Date.now();
}

function appendToSessionBuffer(session: TerminalSession, data: string) {
  session.buffer += data;
  if (session.buffer.length > MAX_BUFFER) {
    session.buffer = session.buffer.slice(-MAX_BUFFER);
  }
  touchSession(session);
  session.listeners.forEach((listener) => listener(data));
}

function buildSessionInfo(session: TerminalSession): TerminalSessionInfo {
  return {
    sessionId: session.id,
    cwd: session.cwd,
    mode: session.mode,
    closed: session.closed,
    pid: session.process.pid,
    createdAt: new Date(session.createdAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
    shell: getShell(),
    platform: os.platform()
  };
}

async function spawnPtySession(sessionId: string, cwd: string, ownerId: string, conversationId: string): Promise<TerminalSession> {
  const pty = (await import("node-pty")) as unknown as {
    spawn: (file: string, args: string[], options: { cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }) => TerminalProcessLike;
  };

  const shell = getShell();
  const shellArgs = shell.includes("pwsh") || shell.includes("powershell")
    ? ["-NoLogo"]
    : [];

  const ptyProcess = pty.spawn(shell, shellArgs, {
    cols: 120,
    rows: 30,
    cwd,
    env: { ...getSanitizedEnv(), TERM: "xterm-256color", LANG: "en_US.UTF-8" }
  });

  // For PowerShell sessions, set UTF-8 output encoding immediately after spawn.
  // This prevents Unicode garbling (e.g., ✓ showing as Γ£ö) in test output.
  if (shell.includes("pwsh") || shell.includes("powershell")) {
    // Small delay to let the shell initialize, then set encoding
    setTimeout(() => {
      ptyProcess.write("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8\r\n");
    }, 300);
  }

  const session: TerminalSession = {
    id: sessionId,
    cwd,
    ownerId,
    conversationId,
    process: ptyProcess,
    buffer: "",
    closed: false,
    mode: "pty",
    listeners: new Set(),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  ptyProcess.onData((data) => {
    appendToSessionBuffer(session, data);
  });

  ptyProcess.onExit(() => {
    session.closed = true;
    touchSession(session);
  });

  return session;
}

function spawnNativeShellSession(sessionId: string, cwd: string, ownerId: string, conversationId: string): TerminalSession {
  const shell = getShell();
  const child = spawn(shell, [], {
    cwd,
    env: getSanitizedEnv(),
    shell: false,
    windowsHide: true
  });

  const processLike: TerminalProcessLike = {
    pid: child.pid,
    write: (data: string) => {
      child.stdin.write(data);
    },
    kill: () => {
      child.kill();
    },
    resize: () => {
      // Resize is not supported for the native shell fallback.
    },
    onData: (listener) => {
      child.stdout.on("data", (chunk) => listener(String(chunk)));
      child.stderr.on("data", (chunk) => listener(String(chunk)));
    },
    onExit: (listener) => {
      child.once("exit", listener);
    }
  };

  const session: TerminalSession = {
    id: sessionId,
    cwd,
    ownerId,
    conversationId,
    process: processLike,
    buffer: "",
    closed: false,
    mode: "shell",
    listeners: new Set(),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  processLike.onData((data) => {
    appendToSessionBuffer(session, data);
  });

  child.on("exit", () => {
    session.closed = true;
    touchSession(session);
  });

  return session;
}

async function createSession(sessionId: string, cwd: string, ownerId: string, conversationId: string) {
  try {
    return await spawnPtySession(sessionId, cwd, ownerId, conversationId);
  } catch {
    return spawnNativeShellSession(sessionId, cwd, ownerId, conversationId);
  }
}

async function getOrCreateSession(sessionId: string, cwd: string, ownerId: string, conversationId: string) {
  const existing = sessions.get(sessionId);
  if (existing && !existing.closed) {
    if (resolve(existing.cwd) !== resolve(cwd)) {
      existing.closed = true;
      existing.process.kill();
      sessions.delete(sessionId);
    } else {
      existing.ownerId = ownerId;
      existing.conversationId = conversationId;
      touchSession(existing);
      return existing;
    }
  }

  const created = await createSession(sessionId, cwd, ownerId, conversationId);
  sessions.set(sessionId, created);
  return created;
}


function getOwnedSession(sessionId: string, ownerId: string) {
  const session = sessions.get(sessionId);
  if (!session || session.ownerId !== ownerId) {
    return null;
  }
  return session;
}

function diagnoseAndFixCommand(command: string): { command: string; diagnostic?: string } {
  if (process.platform !== "win32") {
    return { command };
  }

  let rewritten = command;
  const diagnostics: string[] = [];

  // Fix PowerShell cd/Set-Location with bracket paths.
  // PowerShell interprets [brackets] as wildcard characters in cd/Set-Location
  // even inside double quotes. Single quotes prevent this.
  // e.g. cd "C:\path - [rapa]" fails → cd 'C:\path - [rapa]' works
  if (/\bcd\s+"([^"]*[[\]]+[^"]*)"/.test(rewritten)) {
    rewritten = rewritten.replace(/\bcd\s+"([^"]*[[\]]+[^"]*)"/g, "cd '$1'");
    diagnostics.push("fixed PowerShell bracket path: switched to single quotes for cd");
  }

  // Convert Unix environment variables: export VAR=val
  if (/\bexport\s+([A-Za-z0-9_]+)=/i.test(rewritten)) {
    rewritten = rewritten.replace(/\bexport\s+([A-Za-z0-9_]+)=/gi, "set $1=");
    diagnostics.push("translated 'export' syntax to Windows 'set'");
  }

  // Convert grep to findstr
  if (/\bgrep\b/i.test(rewritten)) {
    rewritten = rewritten.replace(/\bgrep\b/gi, "findstr");
    diagnostics.push("substituted 'grep' with 'findstr'");
  }

  // Convert rm -rf to Windows existence checks
  if (/\brm\s+-rf\s+([^\s&|;]+)/i.test(rewritten)) {
    rewritten = rewritten.replace(/\brm\s+-rf\s+([^\s&|;]+)/gi, "if exist $1 (rmdir /s /q $1) || del /f /q $1");
    diagnostics.push("translated 'rm -rf' syntax to Windows check/deletion");
  }

  return {
    command: rewritten,
    diagnostic: diagnostics.length > 0 ? diagnostics.join("; ") : undefined
  };
}

async function runInSession(session: TerminalSession, command: string, timeout: number, input?: string): Promise<string> {
  const marker = `__CODEBUDDY_DONE_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
  const separator = getCommandSeparator();
  const startAt = session.buffer.length;
  const wrapped = `${command} ${separator} echo ${marker}`;
  session.process.write(`${wrapped}\r\n`);

  const started = Date.now();
  let inputSent = false;

  if (input) {
    setTimeout(() => {
      if (!inputSent) {
        inputSent = true;
        session.process.write(`${input}\r\n`);
      }
    }, 500);
  }

  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.listeners.delete(onData);
      const chunk = session.buffer.slice(startAt);
      const promptInfo = extractPrompt(chunk);
      if (promptInfo) {
        reject(new Error(
          `Command is waiting for input. It prompted: "${promptInfo}". ` +
          `Re-run this command with the "input" parameter set to your response (e.g. "y" or "yes").`
        ));
        return;
      }
      reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);

    const onData = () => {
      if (session.closed) {
        clearTimeout(timer);
        session.listeners.delete(onData);
        reject(new Error("Terminal session closed unexpectedly"));
        return;
      }

      const chunk = session.buffer.slice(startAt);

      if (!inputSent && input && isWaitingForInput(chunk)) {
        inputSent = true;
        session.process.write(`${input}\r\n`);
      }

      if (chunk.includes(marker)) {
        clearTimeout(timer);
        session.listeners.delete(onData);
        resolve(normalizeOutput(chunk, marker));
      }
    };

    session.listeners.add(onData);
    // Process any initial buffer sync
    onData();
  });
}

const INTERACTIVE_PROMPT_PATTERNS: RegExp[] = [
  /\[\s*Y\s*\/\s*[Nn]\s*\]\s*[?:]?\s*$/m,
  /\[\s*y\s*\/\s*[Nn]\s*\]\s*[?:]?\s*$/m,
  /\(\s*[Yy]\s*\/\s*[Nn]\s*\)\s*[?:]?\s*$/m,
  /\(\s*yes\s*\/\s*no\s*\)\s*[?:]?\s*$/im,
  /\[\s*yes\s*\/\s*no\s*\]\s*[?:]?\s*$/im,
  /[Pp]roceed\s*\(\s*[Yy]\s*\/\s*[Nn]\s*\)\s*[?:]?\s*$/m,
  /[Cc]ontinue\s*\?\s*\[\s*[Yy]\/[Nn]\s*\].*$/m,
  /[Cc]ontinue\s*\?\s*\(\s*[Yy]\/[Nn]\s*\).*$/m,
  /[Pp]ress\s+[Ee]nter\s+to\s+continue/,
  /[Pp]ress\s+any\s+key\s+to\s+continue/,
  /[Ss]elect\s+an?\s+option/i,
  /[Ee]nter\s+(a\s+)?[Vv]alue/i,
  /[Tt]ype\s+['"][^'"]+['"]\s+to\s+confirm/i,
];

function isWaitingForInput(buffer: string): boolean {
  return INTERACTIVE_PROMPT_PATTERNS.some((pattern) => pattern.test(buffer));
}

function extractPrompt(buffer: string): string | null {
  const lines = buffer.split(/\r?\n/);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    const line = lines[i].trim();
    if (!line) continue;
    for (const pattern of INTERACTIVE_PROMPT_PATTERNS) {
      if (pattern.test(line)) return line;
    }
  }
  return null;
}

const ALLOWED_COMMAND_PREFIXES = [
  "npm ", "npx ", "node ", "tsx ", "tsc ",
  "git ", "python ", "python3 ", "pip ", "pip3 ",
  "go ", "cargo ", "make ", "cmake ",
  "eslint ", "prettier ", "vitest ", "jest ",
  "yarn ", "pnpm ", "ncu ",
  "ls ", "dir ", "cat ", "type ", "echo ", "pwd ", "cd ",
  "cp ", "copy ", "mv ", "move ", "mkdir ", "rmdir ",
  "find ", "grep ", "findstr ", "sort ", "wc ",
  "head ", "tail ", "touch ", "chmod ", "chown ",
  "ps ", "tasklist ", "kill ", "taskkill ",
  "curl ", "wget ", "ping ", "nslookup ",
  "docker ", "docker-compose ", "kubectl ",
  "gh ", "code ", "notepad ", "explorer ",
  "set ", "export ",
  "which ", "where ", "whereis ",
  "php ", "composer ",
];

const BLOCKED_PRIVILEGE_COMMANDS = [
  "sudo", "su ", "pkexec", "doas", "run0",
  "set-executionpolicy", "runas",
];

const BLOCKED_DESTRUCTIVE_PATTERNS: RegExp[] = [
  /rm\s+-rf?\s+(\/|~\/)/i,
  /rmdir\s+.*\/(s|q).*[a-z]:\\/i,
  /rd\s+.*\/(s|q).*[a-z]:\\/i,
  /del\s+.*\/(s|q).*[a-z]:\\/i,
  /remove-item\s+.*(-recurse|-r).*[a-z]:\\\\/i,
  /format\s+[a-z]:\s*/i,
  /dd\s+if=/i,
  /mkfs/i,
  /fdisk/i,
  /:\(\)\{.*\}/,
];

const BLOCKED_PIPE_PATTERNS: RegExp[] = [
  /curl\s+.*\|\s*(sh|bash|zsh|powershell|pwsh|cmd)/i,
  /wget\s+.*\|\s*(sh|bash|zsh|powershell|pwsh|cmd)/i,
  /irm\s+.*\|\s*iex/i,
  /iwr\s+.*\|\s*iex/i,
  /invoke-webrequest\s+.*\|\s*invoke-expression/i,
  /invoke-restmethod\s+.*\|\s*invoke-expression/i,
];

export function isDangerousCommand(command: string): boolean {
  const normalized = command.trim();

  for (const pattern of BLOCKED_DESTRUCTIVE_PATTERNS) {
    if (pattern.test(normalized)) return true;
  }

  for (const pattern of BLOCKED_PIPE_PATTERNS) {
    if (pattern.test(normalized)) return true;
  }

  const lowerCmd = normalized.toLowerCase();
  for (const blocked of BLOCKED_PRIVILEGE_COMMANDS) {
    if (lowerCmd.startsWith(blocked)) return true;
    if (lowerCmd.includes(` ${blocked}`) || lowerCmd.includes(`\t${blocked}`)) return true;
    if (lowerCmd.includes(`&${blocked}`) || lowerCmd.includes(`|${blocked}`)) return true;
  }

  const firstWord = lowerCmd.split(/\s+/)[0] ?? "";
  if (!firstWord) return false;

  for (const allowed of ALLOWED_COMMAND_PREFIXES) {
    const prefix = allowed.trimEnd();
    if (firstWord === prefix) return false;
    if (`${firstWord} ` === allowed) return false;
  }

  if (firstWord === lowerCmd && lowerCmd.length > 0) {
    for (const allowed of ALLOWED_COMMAND_PREFIXES) {
      const prefix = allowed.trimEnd();
      if (lowerCmd === prefix || lowerCmd.startsWith(`${prefix} `)) return false;
    }
  }

  if (/^["'].*["']$/.test(normalized)) return false;

  return true;
}


function getCommandError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function getRequestedCwd(params: Record<string, unknown>) {
  const cwd = typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : undefined;
  const workdir = typeof params.workdir === "string" && params.workdir.trim() ? params.workdir.trim() : undefined;
  return cwd ?? workdir;
}

function resolveCommandCwd(params: Record<string, unknown>, context: ToolExecutionContext) {
  const requestedCwd = getRequestedCwd(params);
  const cwd = resolveWorkspacePath(requestedCwd, context.workspaceRoot);

  // Fire-and-forget async check — we wrap in an IIFE because the caller is
  // synchronous but the symlink-safe check is async.
  // Instead, we export an async version and patch the callers.
  // For now, do a synchronous lexical check first, then the async symlink
  // check is done in the tool execute() methods that call this function.
  return {
    cwd,
    relativeCwd: toWorkspaceRelativePath(cwd, context.workspaceRoot)
  };
}

async function resolveCommandCwdSafe(params: Record<string, unknown>, context: ToolExecutionContext) {
  const requestedCwd = getRequestedCwd(params);
  const cwd = resolveWorkspacePath(requestedCwd, context.workspaceRoot);

  if (!(await isWithinWorkspaceSymlinkSafe(cwd, context.workspaceRoot))) {
    return {
      error: "Access denied: cwd is outside workspace"
    };
  }

  return {
    cwd,
    relativeCwd: toWorkspaceRelativePath(cwd, context.workspaceRoot)
  };
}

function getProcessSessionId(context: ToolExecutionContext, providedSessionId?: string, cwd = context.workspaceRoot) {
  return providedSessionId?.trim() || `${context.userId}:${cwd}:${context.conversationId}`;
}


export function getDefaultSessionId(context: ToolExecutionContext) {
  return getProcessSessionId(context);
}

export async function ensureTerminalSession(options: {
  sessionId: string;
  cwd: string;
  ownerId: string;
  conversationId?: string;
}) {
  const session = await getOrCreateSession(options.sessionId, options.cwd, options.ownerId, options.conversationId ?? options.sessionId);
  return buildSessionInfo(session);
}

export async function subscribeToTerminalSession(
  options: {
    sessionId: string;
    cwd: string;
    ownerId: string;
    conversationId?: string;
  },
  listener: (data: string) => void
) {
  const session = await getOrCreateSession(options.sessionId, options.cwd, options.ownerId, options.conversationId ?? options.sessionId);
  session.listeners.add(listener);
  touchSession(session);

  return {
    session: buildSessionInfo(session),
    output: session.buffer,
    unsubscribe: () => {
      session.listeners.delete(listener);
      touchSession(session);
    }
  };
}

export async function writeToTerminalSession(options: {
  sessionId: string;
  cwd: string;
  ownerId: string;
  conversationId?: string;
  data: string;
}) {
  const session = await getOrCreateSession(options.sessionId, options.cwd, options.ownerId, options.conversationId ?? options.sessionId);
  session.process.write(options.data);
  touchSession(session);
  return buildSessionInfo(session);
}

export function resizeTerminalSession(sessionId: string, ownerId: string, cols: number, rows: number) {
  const session = getOwnedSession(sessionId, ownerId);
  if (!session || session.closed) {
    return null;
  }

  session.process.resize?.(cols, rows);
  touchSession(session);
  return buildSessionInfo(session);
}

export function getTerminalSessionOutput(sessionId: string, ownerId: string, maxChars = 4000) {
  const session = getOwnedSession(sessionId, ownerId);
  if (!session) {
    return null;
  }

  const output = maxChars > 0 ? session.buffer.slice(-maxChars) : session.buffer;
  return {
    session: buildSessionInfo(session),
    output
  };
}

export function listTerminalSessions(ownerId: string) {
  return Array.from(sessions.values())
    .filter((session) => session.ownerId === ownerId)
    .map((session) => buildSessionInfo(session));
}

export function closeTerminalSession(sessionId: string, ownerId: string) {
  const session = getOwnedSession(sessionId, ownerId);
  if (!session) {
    return false;
  }

  session.closed = true;
  touchSession(session);
  session.process.kill();
  sessions.delete(sessionId);
  return true;
}

export async function startBackgroundCommand(options: {
  sessionId: string;
  cwd: string;
  ownerId: string;
  conversationId?: string;
  command: string;
}) {
  const session = await getOrCreateSession(options.sessionId, options.cwd, options.ownerId, options.conversationId ?? options.sessionId);
  session.process.write(`${options.command}\r\n`);
  touchSession(session);
  return buildSessionInfo(session);
}

export class ExecuteCommandTool extends Tool {
  definition: ToolDefinition = {
    name: "execute_command",
    description: "Execute a shell command in a persistent terminal session in the workspace directory (PTY when available)",
    category: "shell",
    requiresApproval: true,
    parameters: {
      command: {
        type: "string",
        description: "The shell command to execute",
        required: true
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default: 3600000 = 1 hour). Generous timeout allows package installs, builds, and long-running scripts to complete without interruption.",
        required: false
      },
      cwd: {
        type: "string",
        description: "Optional working directory, relative to workspace root or an absolute path inside the workspace",
        required: false
      },
      workdir: {
        type: "string",
        description: "Alias for cwd, accepted for compatibility with other coding agents",
        required: false
      },
      sessionId: {
        type: "string",
        description: "Optional terminal session id for persistent command context",
        required: false
      },

      closeSession: {
        type: "boolean",
        description: "Close the terminal session after running this command",
        required: false
      },
      input: {
        type: "string",
        description: "Text to pipe to stdin after the command starts. Use this to answer interactive prompts (e.g. 'y' for [Y/n], 'yes' for confirmation). Commands that prompt for input will timeout unless input is provided.",
        required: false
      },
      background: {
        type: "boolean",
        description: "When true, starts the command in the background and returns immediately with a session ID (like start_process). Use for long-running commands you want to monitor with get_process_output.",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const rawCommand = params.command as string;
    const { command, diagnostic } = diagnoseAndFixCommand(rawCommand);
    const timeout = (params.timeout as number) ?? 3_600_000;
    const closeSession = (params.closeSession as boolean | undefined) ?? false;
    const background = (params.background as boolean | undefined) ?? false;
    const cwdInfo = await resolveCommandCwdSafe(params, context);
    if ("error" in cwdInfo) {
      return {
        success: false,
        error: cwdInfo.error
      };
    }
    const sessionId = getProcessSessionId(context, params.sessionId as string | undefined, cwdInfo.cwd);

    // Background mode: start and return immediately
    if (background) {
      try {
        const session = await startBackgroundCommand({
          sessionId,
          cwd: cwdInfo.cwd,
          ownerId: context.userId,
          conversationId: context.conversationId,
          command
        });

        return {
          success: true,
          data: {
            ...session,
            command,
            relativeCwd: cwdInfo.relativeCwd,
            mode: "background",
            diagnostic,
            message: `Command started in background. Use get_process_output({ sessionId: "${sessionId}" }) to read output, or stop_process to terminate.`
          }
        };
      } catch (error) {
        return {
          success: false,
          error: getCommandError(error, "Failed to start background command")
        };
      }
    }

    // Determine execution strategy:
    // - If a sessionId is explicitly provided, use PTY (persistent session needed)
    // - Otherwise, use PIPE (child_process.exec) — cleaner output, no echo, no ANSI
    const usePty = !!params.sessionId;

    if (!usePty) {
      // ── PIPE mode (primary path) ──────────────────────────────────────
      // Uses child_process.exec with stdout/stderr pipes. No PTY means:
      // - No command echo pollution
      // - No ANSI escape codes (tools auto-detect non-terminal via isatty())
      // - No shell prompts (PS C:\...>)
      // - Clean output suitable for LLM consumption
      // - Completion detected by process exit (no marker scanning needed)
      try {
        const input = params.input as string | undefined;
        const cmdToRun = input ? `echo ${JSON.stringify(input)} | ${command}` : command;

        const { stdout, stderr } = await execAsync(cmdToRun, {
          cwd: cwdInfo.cwd,
          timeout,
          maxBuffer: 1024 * 1024 * 10, // 10MB
          env: getSanitizedEnv()
        });

        let output = [stdout, stderr].filter(Boolean).join("\n").trim();
        // Still strip ANSI in case any tool forces color despite non-terminal
        output = stripAnsi(output);

        return {
          success: true,
          output: headTailTruncate(output),
          data: {
            sessionId,
            cwd: cwdInfo.cwd,
            relativeCwd: cwdInfo.relativeCwd,
            mode: "pipe" as SessionMode,
            shell: getShell(),
            platform: os.platform(),
            diagnostic
          }
        };
      } catch (error) {
        // execAsync throws on non-zero exit codes, attaching stdout/stderr
        const execError = error as { stdout?: string; stderr?: string; message: string; code?: number };
        const output = stripAnsi([execError.stdout, execError.stderr].filter(Boolean).join("\n")).trim();
        const exitCode = execError.code;

        if (output || exitCode !== undefined) {
          const baseResult: ToolResult = {
            success: exitCode === 0,
            output: headTailTruncate(output),
            data: {
              sessionId,
              cwd: cwdInfo.cwd,
              relativeCwd: cwdInfo.relativeCwd,
              mode: "pipe" as SessionMode,
              shell: getShell(),
              platform: os.platform(),
              exitCode,
              diagnostic
            }
          };
          // Attach recovery suggestions based on the error shape.
          if (exitCode !== 0) {
            const errMsg = execError.message ?? "";
            if (/timed out|ETIMEDOUT|timeout/i.test(errMsg)) {
              return Suggest.shellTimeout(baseResult, command);
            }
            if (/command not found|not recognized|ENOENT/i.test(errMsg)) {
              return Suggest.commandNotFound(baseResult, command);
            }
            if (/EACCES|permission denied/i.test(errMsg)) {
              return Suggest.permissionDenied(baseResult, command);
            }
          }
          return baseResult;
        }

        const fallbackMessage = getCommandError(error, "Command execution failed");
        if (/timed out|ETIMEDOUT|timeout/i.test(fallbackMessage)) {
          return Suggest.shellTimeout({ success: false, error: fallbackMessage }, command);
        }
        if (/command not found|not recognized|ENOENT/i.test(fallbackMessage)) {
          return Suggest.commandNotFound({ success: false, error: fallbackMessage }, command);
        }
        if (/EACCES|permission denied/i.test(fallbackMessage)) {
          return Suggest.permissionDenied({ success: false, error: fallbackMessage }, command);
        }
        return {
          success: false,
          error: fallbackMessage
        };
      }
    }

    // ── PTY mode (only when persistent session is explicitly requested) ──
    try {
      let output = "";
      let mode: SessionMode = "pty";

      try {
        const session = await getOrCreateSession(sessionId, context.workspaceRoot, context.userId, context.conversationId);
        mode = session.mode;
        output = await runInSession(session, command, timeout, params.input as string | undefined);

        if (closeSession) {
          closeTerminalSession(sessionId, context.userId);
        }
      } catch (error) {
        const errMsg = getCommandError(error, "Session command failed");
        if (/timed out|timeout/i.test(errMsg)) {
          return Suggest.shellTimeout({ success: false, error: errMsg }, command);
        }
        return {
          success: false,
          error: errMsg
        };
      }

      return {
        success: true,
        output: headTailTruncate(output),
        data: {
          sessionId,
          cwd: cwdInfo.cwd,
          relativeCwd: cwdInfo.relativeCwd,
          mode,
          shell: getShell(),
          platform: os.platform(),
          diagnostic
        }
      };
    } catch (error) {
      return {
        success: false,
        error: getCommandError(error, "Command execution failed")
      };
    }
  }
}

export class StartProcessTool extends Tool {
  definition: ToolDefinition = {
    name: "start_process",
    description: "Start a long-running command in a persistent terminal session without waiting for completion",
    category: "shell",
    requiresApproval: true,
    parameters: {
      command: {
        type: "string",
        description: "Command to start",
        required: true
      },
      cwd: {
        type: "string",
        description: "Optional working directory, relative to workspace root or an absolute path inside the workspace",
        required: false
      },
      workdir: {
        type: "string",
        description: "Alias for cwd, accepted for compatibility with other coding agents",
        required: false
      },
      sessionId: {
        type: "string",
        description: "Optional persistent terminal session id",
        required: false
      }

    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const rawCommand = params.command as string;
    const { command, diagnostic } = diagnoseAndFixCommand(rawCommand);
    const cwdInfo = await resolveCommandCwdSafe(params, context);
    if ("error" in cwdInfo) {
      return {
        success: false,
        error: cwdInfo.error
      };
    }
    const sessionId = getProcessSessionId(context, params.sessionId as string | undefined, cwdInfo.cwd);

    try {
      const session = await startBackgroundCommand({
        sessionId,
        cwd: cwdInfo.cwd,
        ownerId: context.userId,
        conversationId: context.conversationId,
        command
      });


      return {
        success: true,
        data: {
          command,
          relativeCwd: cwdInfo.relativeCwd,
          diagnostic,
          ...session
        }

      };
    } catch (error) {
      return {
        success: false,
        error: getCommandError(error, "Failed to start process")
      };
    }
  }
}

export class StopProcessTool extends Tool {
  definition: ToolDefinition = {
    name: "stop_process",
    description: "Stop a persistent terminal session or background process",
    category: "shell",
    requiresApproval: true,
    parameters: {
      sessionId: {
        type: "string",
        description: "Session id to stop",
        required: true
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const sessionId = params.sessionId as string;
    const stopped = closeTerminalSession(sessionId, context.userId);

    return stopped
      ? {
          success: true,
          data: {
            sessionId,
            stopped: true
          }
        }
      : {
          success: false,
          error: `Session ${sessionId} was not found`
        };
  }
}

export class ListProcessesTool extends Tool {
  definition: ToolDefinition = {
    name: "list_processes",
    description: "List active terminal sessions and background processes for the current user",
    category: "shell",
    parameters: {}
  };

  async execute(_params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    return {
      success: true,
      data: {
        sessions: listTerminalSessions(context.userId)
      }
    };
  }
}

export class GetProcessOutputTool extends Tool {
  definition: ToolDefinition = {
    name: "get_process_output",
    description: "Read recent output from a persistent terminal session. Supports regex filtering to return only matching lines, and non-blocking mode for quick status checks.",
    category: "shell",
    parameters: {
      sessionId: {
        type: "string",
        description: "Session id to inspect",
        required: true
      },
      maxChars: {
        type: "number",
        description: "Maximum number of trailing characters to return (default: 4000)",
        required: false
      },
      filter: {
        type: "string",
        description: "Regex pattern to filter output — only lines matching this pattern are returned. Useful for extracting specific log lines, errors, or status messages from verbose output.",
        required: false
      },
      block: {
        type: "boolean",
        description: "When true (default), waits briefly for new output if the buffer is empty. When false, returns immediately with whatever is in the buffer.",
        required: false
      },
      timeout: {
        type: "number",
        description: "Maximum wait time in milliseconds when blocking (default: 5000, max: 30000)",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const sessionId = params.sessionId as string;
    const maxChars = typeof params.maxChars === "number" ? Math.max(1, Math.floor(params.maxChars)) : 4000;
    const filter = typeof params.filter === "string" ? params.filter.trim() : undefined;
    const block = (params.block as boolean | undefined) ?? true;
    const timeout = typeof params.timeout === "number"
      ? Math.max(100, Math.min(30_000, Math.floor(params.timeout)))
      : 5000;

    let snapshot = getTerminalSessionOutput(sessionId, context.userId, maxChars);

    // Non-blocking mode: return immediately
    if (!block) {
      return formatProcessOutput(snapshot, filter);
    }

    // Blocking mode: if output is empty or very short, wait briefly for new output
    if (snapshot && (!snapshot.output || snapshot.output.trim().length < 10)) {
      const start = Date.now();
      const pollInterval = 200;
      while (Date.now() - start < timeout) {
        await new Promise((r) => setTimeout(r, pollInterval));
        snapshot = getTerminalSessionOutput(sessionId, context.userId, maxChars);
        if (snapshot && snapshot.output.trim().length > 10) break;
      }
    }

    return formatProcessOutput(snapshot, filter);
  }
}

function formatProcessOutput(
  snapshot: ReturnType<typeof getTerminalSessionOutput>,
  filter?: string
): ToolResult {
  if (!snapshot) {
    return { success: false, error: "Session was not found" };
  }

  // Strip ANSI escape codes and control sequences from PTY output
  let output = stripAnsi(snapshot.output).replaceAll("\r", "");
  let filterMatchCount: number | undefined;

  if (filter) {
    try {
      const regex = new RegExp(filter, "gmi");
      const lines = output.split("\n");
      const matching = lines.filter((line) => regex.test(line));
      filterMatchCount = matching.length;
      output = matching.join("\n");
    } catch {
      return {
        success: false,
        error: `Invalid filter regex: "${filter}". Use a valid regular expression.`
      };
    }
  }

  return {
    success: true,
    output,
    data: {
      ...snapshot.session,
      ...(filter ? { filter, filterMatchCount, totalLines: snapshot.output.split("\n").length } : {})
    }
  };
}
