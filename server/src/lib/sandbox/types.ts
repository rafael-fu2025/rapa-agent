// Shared types for the command-sandbox layer.
//
// Deliberately dependency-free: `lib/tools.ts` re-uses `SandboxMode` on
// `ToolExecutionContext`, so this module must not import anything.

/** Sandbox strategy for shell command execution. */
export type SandboxMode = "native" | "docker" | "off";

export type SandboxPrepareOptions = {
  /** Absolute workspace root on the host. Mounted at /workspace in Docker mode. */
  workspaceRoot: string;
  /** Absolute host working directory the command should run in. */
  cwd: string;
  /** Effective (already clamped) command timeout in milliseconds. */
  timeoutMs: number;
};

/**
 * A sandbox backend wraps/rewrites shell commands before execution and
 * knows how to tear down the processes it started.
 */
export type SandboxBackend = {
  /** Backend identifier, mirrors the SandboxMode that selected it. */
  readonly name: "native" | "docker";
  /**
   * Check whether the backend is usable right now (Docker daemon reachable,
   * image available, ...). Implementations memoize the result.
   */
  probe(): Promise<boolean>;
  /**
   * Wrap or rewrite a command so it runs inside the sandbox. Returns the
   * effective command string and the host cwd the process should start in.
   * Throws `SandboxUnavailableError` when the backend is configured but not
   * currently usable.
   */
  prepare(command: string, opts: SandboxPrepareOptions): Promise<{ command: string; cwd: string }>;
  /**
   * Kill a process (tree) previously started under this backend. Must never
   * throw — a missing/stale pid is treated as "already gone".
   */
  terminate(pid: number | undefined): Promise<void>;
};
