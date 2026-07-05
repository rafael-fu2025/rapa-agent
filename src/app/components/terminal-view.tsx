import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { AlertCircle, LoaderCircle, Plug2, RefreshCcw, XCircle, SquareTerminal } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { API_BASE } from "../../lib/api";
import { cn } from "../../lib/utils";

type TerminalReadyEvent = {
  type: "ready";
  session: {
    sessionId: string;
    mode: "pty" | "shell";
    cwd: string;
    closed: boolean;
    pid?: number;
  };
  output: string;
};

type TerminalStreamEvent =
  | TerminalReadyEvent
  | { type: "output"; data: string }
  | { type: "started"; command: string }
  | { type: "resized" }
  | { type: "closed"; sessionId: string }
  | { type: "error"; message: string };

type TerminalViewProps = {
  workspaceId?: string;
  conversationId?: string;
  sessionId?: string;
  /**
   * Optional workspace-relative path that the PTY should start in.
   * The server validates it against the workspace root (path-traversal
   * + symlink-safety) before spawning the shell. When omitted, the
   * shell starts in the workspace root.
   */
  cwd?: string;
  autoConnect?: boolean;
  active?: boolean;
  /** Whether the enclosing panel is currently visible (not display:none). Triggers re-fit on change. */
  visible?: boolean;
  embedded?: boolean;
  className?: string;
  onRegisterClose?: (closeFn: () => void) => void;
};

function buildTerminalSocketUrl(params: { workspaceId?: string; conversationId?: string; sessionId?: string; cwd?: string }) {
  const socketBase = API_BASE.replace(/^http/, "ws");
  const url = new URL(`${socketBase}/ws/pty`);
  if (params.workspaceId) url.searchParams.set("workspaceId", params.workspaceId);
  if (params.conversationId) url.searchParams.set("conversationId", params.conversationId);
  if (params.sessionId) url.searchParams.set("sessionId", params.sessionId);
  if (params.cwd) url.searchParams.set("cwd", params.cwd);
  // WebSocket connections can't send Authorization headers — pass the
  // JWT token as a query parameter for the server-side auth hook.
  const token = localStorage.getItem("auth_token") ?? localStorage.getItem("accessToken");
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

/** Clamp terminal dimensions to the backend's Zod validation bounds. */
function clampedResize(cols: number, rows: number) {
  return {
    type: "resize" as const,
    cols: Math.max(20, Math.min(400, Math.round(cols))),
    rows: Math.max(5, Math.min(200, Math.round(rows))),
  };
}

export function TerminalView({
  workspaceId,
  conversationId,
  sessionId,
  cwd,
  autoConnect = true,
  active = true,
  visible = true,
  embedded = false,
  className,
  onRegisterClose
}: TerminalViewProps) {
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [command, setCommand] = useState("");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const connectingRef = useRef(false);
  const [error, setError] = useState("");
  const [activeSessionId, setActiveSessionId] = useState(sessionId);

  const socketUrl = useMemo(
    () => buildTerminalSocketUrl({ workspaceId, conversationId, sessionId: activeSessionId ?? sessionId, cwd }),
    [activeSessionId, conversationId, sessionId, workspaceId, cwd]
  );

  useEffect(() => {
    setActiveSessionId(sessionId);
  }, [sessionId]);

  // Register a close handler the parent can call to terminate the PTY session
  useEffect(() => {
    onRegisterClose?.(() => {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "close" }));
      }
      socketRef.current?.close();
      socketRef.current = null;
    });
  }, [onRegisterClose]);

  useEffect(() => {
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      cols: 120,
      rows: 30,
      fontSize: 11,
      lineHeight: 1.4,
      fontFamily: "'JetBrains Mono', Consolas, 'Courier New', monospace",
      scrollback: 5000,
      allowProposedApi: true,
      theme: {
        background: "#0a0a0a",
        foreground: "#c8ccd4",
        cursor: "#6ee7b7",
        cursorAccent: "#0a0a0a",
        selectionBackground: "#2A3340",
        selectionForeground: "#c8ccd4",
        black: "#1a1a2e",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#3b82f6",
        magenta: "#a855f7",
        cyan: "#06b6d4",
        white: "#c8ccd4",
        brightBlack: "#4a4a5a",
        brightRed: "#f87171",
        brightGreen: "#4ade80",
        brightYellow: "#facc15",
        brightBlue: "#60a5fa",
        brightMagenta: "#c084fc",
        brightCyan: "#22d3ee",
        brightWhite: "#e4e8f0",
      }
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    if (terminalContainerRef.current) {
      terminal.open(terminalContainerRef.current);
      fitAddon.fit();
    }

    const onTerminalData = terminal.onData((data) => {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "input", data }));
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify(clampedResize(terminal.cols, terminal.rows)));
      }
    });

    if (terminalContainerRef.current) {
      resizeObserver.observe(terminalContainerRef.current);
    }

    return () => {
      resizeObserver.disconnect();
      onTerminalData.dispose();
      // Tell the server to terminate the PTY process before dropping the connection
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "close" }));
      }
      socketRef.current?.close();
      socketRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!active || !visible) return;

    const fitTerminal = () => {
      fitAddonRef.current?.fit();
      if (socketRef.current?.readyState === WebSocket.OPEN && terminalRef.current) {
        socketRef.current.send(JSON.stringify(clampedResize(terminalRef.current.cols, terminalRef.current.rows)));
      }
    };

    // Small delay to let the browser lay out the now-visible container
    const timer = window.setTimeout(fitTerminal, 60);
    return () => window.clearTimeout(timer);
  }, [active, visible]);

  const connect = useCallback(() => {
    if (!workspaceId || connectingRef.current) return;

    // Close any existing socket to prevent duplicate connections.
    // This is critical: when the server sends "ready" with a session ID,
    // activeSessionId updates → socketUrl changes → this effect re-fires.
    // Without closing the old socket, both connections send input and
    // both receive output, causing doubled characters.
    if (socketRef.current) {
      socketRef.current.onopen = null;
      socketRef.current.onmessage = null;
      socketRef.current.onerror = null;
      socketRef.current.onclose = null;
      socketRef.current.close();
      socketRef.current = null;
    }

    setError("");
    setConnecting(true);
    connectingRef.current = true;
    terminalRef.current?.writeln("\r\n\x1b[90m[connecting terminal session...]\x1b[0m\r\n");

    const socket = new WebSocket(socketUrl);
    socketRef.current = socket;

    socket.onopen = () => {
      setConnecting(false);
      connectingRef.current = false;
      setConnected(true);
      fitAddonRef.current?.fit();
      if (terminalRef.current) {
        socket.send(JSON.stringify(clampedResize(terminalRef.current.cols, terminalRef.current.rows)));
      }
    };

    socket.onmessage = (event) => {
      const terminalInstance = terminalRef.current;
      if (!terminalInstance) return;

      try {
        const payload = JSON.parse(String(event.data)) as TerminalStreamEvent;
        if (payload.type === "ready") {
          setActiveSessionId(payload.session.sessionId);
          if (payload.output) {
            terminalInstance.write(payload.output);
          }
          return;
        }

        if (payload.type === "output") {
          terminalInstance.write(payload.data);
          return;
        }

        if (payload.type === "started") {
          terminalInstance.writeln(`\r\n\x1b[36m[started]\x1b[0m ${payload.command}\r\n`);
          return;
        }

        if (payload.type === "closed") {
          terminalInstance.writeln("\r\n\x1b[90m[terminal session closed]\x1b[0m\r\n");
          setConnected(false);
          setActiveSessionId(undefined);
          return;
        }

        if (payload.type === "error") {
          setError(payload.message);
          terminalInstance.writeln(`\r\n\x1b[31m[error]\x1b[0m ${payload.message}\r\n`);
        }
      } catch {
        setError("Invalid terminal message received");
      }
    };

    socket.onerror = () => {
      setConnecting(false);
      connectingRef.current = false;
      setConnected(false);
      setError("Failed to connect terminal session");
    };

    socket.onclose = () => {
      setConnecting(false);
      connectingRef.current = false;
      setConnected(false);
    };
  }, [workspaceId, socketUrl]);

  useEffect(() => {
    if (autoConnect && active && workspaceId) {
      connect();
    }
  }, [active, autoConnect, socketUrl, workspaceId, connect]);

  const handleRunCommand = () => {
    if (!command.trim()) return;
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      setError("Connect the terminal first");
      return;
    }

    socketRef.current.send(JSON.stringify({ type: "run", command }));
    setCommand("");
  };

  const handleCloseSession = () => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "close" }));
    }
    socketRef.current?.close();
    socketRef.current = null;
    setConnected(false);
    connectingRef.current = false;
    setActiveSessionId(undefined);
  };

  // ── Embedded mode — clean terminal only, no toolbar ──
  if (embedded) {
    return (
      <div className={cn("flex h-full w-full flex-col", className)}>
        {/* Terminal fills remaining space */}
        <div ref={terminalContainerRef} className="flex-1 min-h-0 w-full px-1 py-1" />

        {/* Inline error */}
        {error ? (
          <div className="flex items-center gap-1.5 border-t border-border/30 px-3 py-1.5">
            <AlertCircle className="h-3 w-3 text-accent-red shrink-0" />
            <span className="font-mono-tech text-[9px] text-accent-red/80 truncate">{error}</span>
          </div>
        ) : null}
      </div>
    );
  }

  // ── Standalone mode — full toolbar + command bar ──
  const body = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/40 bg-app px-4 py-2.5">
        <div className="flex items-center gap-2">
          <SquareTerminal className="h-4 w-4 text-accent-cyan" />
          <span className="font-mono-tech text-[11px] font-semibold text-foreground">Workspace Terminal</span>
          {connecting ? (
            <span className="rounded border border-accent-cyan/30 bg-accent-cyan/10 px-1.5 py-0.5 font-mono-tech text-[9px] uppercase tracking-[0.1em] text-accent-cyan">
              connecting
            </span>
          ) : connected ? (
            <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono-tech text-[9px] uppercase tracking-[0.1em] text-emerald-400">
              connected
            </span>
          ) : (
            <span className="rounded border border-border/40 bg-card-3 px-1.5 py-0.5 font-mono-tech text-[9px] uppercase tracking-[0.1em] text-muted-foreground/60">
              offline
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={connect}
            disabled={!workspaceId || connecting || connected}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded border border-border/40 bg-card-3 px-2.5 py-1.5 font-mono-tech text-[10px] text-foreground transition-colors hover:border-border/60 hover:bg-card-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {connecting ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <Plug2 className="h-3 w-3" />}
            <span>{connected ? "Connected" : workspaceId ? "Connect" : "No workspace"}</span>
          </button>

          <button
            type="button"
            onClick={() => {
              terminalRef.current?.clear();
              setError("");
            }}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded border border-border/40 bg-card-3 px-2.5 py-1.5 font-mono-tech text-[10px] text-foreground transition-colors hover:border-border/60 hover:bg-card-hover"
          >
            <RefreshCcw className="h-3 w-3" />
            <span>Clear</span>
          </button>

          <button
            type="button"
            onClick={handleCloseSession}
            disabled={!connected}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded border border-border/40 bg-card-3 px-2.5 py-1.5 font-mono-tech text-[10px] text-foreground transition-colors hover:border-border/60 hover:bg-card-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <XCircle className="h-3 w-3" />
            <span>Close</span>
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 border-b border-border/40 bg-app px-4 py-2">
        <span className="font-mono-tech text-[10px] text-muted-foreground/60 select-none">$</span>
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              handleRunCommand();
            }
          }}
          placeholder="Run a command in this session..."
          className="flex-1 bg-transparent font-mono text-[12px] text-foreground placeholder:text-muted-foreground/40 outline-none"
        />
        <button
          type="button"
          onClick={handleRunCommand}
          disabled={!connected || !command.trim()}
          className="rounded border border-border/40 bg-card-3 px-3 py-1 font-mono-tech text-[10px] font-medium text-foreground transition-colors hover:border-border/60 hover:bg-card-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          Run
        </button>
      </div>

      {!workspaceId ? (
        <div className="flex items-center justify-center px-4 py-8 font-mono-tech text-[10px] uppercase tracking-[0.12em] text-muted-foreground/50">
          Select a workspace to enable the live terminal.
        </div>
      ) : null}

      {error ? (
        <div className="flex items-center gap-2 border-b border-accent-red/20 bg-accent-red/5 px-4 py-2">
          <AlertCircle className="h-3 w-3 text-accent-red shrink-0" />
          <span className="font-mono-tech text-[10px] text-accent-red/80">{error}</span>
        </div>
      ) : null}

      <div ref={terminalContainerRef} className="flex-1 min-h-0 w-full bg-[#0a0a0a] px-1 py-1" />
    </>
  );

  return (
    <div className={cn("flex h-full flex-col overflow-hidden rounded border border-border/40 bg-card", className)}>
      {body}
    </div>
  );
}
