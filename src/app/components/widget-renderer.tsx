// §2.5 — WidgetRenderer.
//
// Renders an interactive HTML widget produced by the agent's
// `render_widget` tool. The HTML runs inside a sandboxed iframe with a
// strict CSP so scripts can't escape into the parent page. A header bar
// shows the title and lets the user collapse/expand the widget.

import { useState } from "react";
import { ChevronDown, ChevronRight, AlertTriangle, Maximize2, X } from "lucide-react";

export type AgentWidget = {
  title: string;
  html: string;
  data?: unknown;
  sanitized?: string[];
};

type WidgetRendererProps = {
  widget: AgentWidget;
};

/**
 * Build a CSP that allows inline styles (needed for almost every
 * visualization) and inline scripts (needed for `<script>` blocks
 * inside the widget), but blocks forms, top-level navigation, and
 * popups. We also use a nonce-less sandbox attribute on the iframe
 * itself for defense-in-depth.
 */
const WIDGET_CSP = [
  "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "base-uri 'none'"
].join("; ");

function buildWidgetHtml(widget: AgentWidget): string {
  // Wrap the widget HTML in a minimal HTML document so the iframe
  // doesn't inherit the parent's CSS / scripts.
  const dataJson = JSON.stringify(widget.data ?? null);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP}">
<style>
  body { margin: 0; padding: 12px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1a1a1a; background: transparent; }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.2); border-radius: 3px; }
</style>
</head>
<body>
${widget.html}
<script>window.__WIDGET_DATA__ = ${dataJson};</script>
</body>
</html>`;
}

export function WidgetRenderer({ widget }: WidgetRendererProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  return (
    <div className={`flex flex-col gap-0 my-2 rounded border border-border/60 bg-card-3 overflow-hidden ${fullscreen ? "fixed inset-4 z-50" : ""}`}>
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border/40 bg-card-3">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-1.5 text-left flex-1 min-w-0 hover:text-foreground transition-colors"
        >
          {collapsed ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
          <span className="font-mono text-[11px] font-medium text-foreground truncate">{widget.title}</span>
          <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60">widget</span>
        </button>
        <div className="flex items-center gap-1">
          {widget.sanitized && widget.sanitized.length > 0 && (
            <span
              className="flex items-center gap-1 text-[9px] font-mono uppercase tracking-wider text-amber-400"
              title={`Sanitized: ${widget.sanitized.join(", ")}`}
            >
              <AlertTriangle className="h-3 w-3" />
              {widget.sanitized.length} sanitized
            </span>
          )}
          <button
            type="button"
            onClick={() => setFullscreen((f) => !f)}
            className="rounded p-1 text-muted-foreground hover:text-foreground transition-colors"
            title={fullscreen ? "Restore" : "Maximize"}
          >
            {fullscreen ? <X className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
      {!collapsed && (
        <iframe
          srcDoc={buildWidgetHtml(widget)}
          sandbox="allow-scripts"
          className={`w-full border-0 ${fullscreen ? "flex-1" : "min-h-[120px]"}`}
          style={{ height: fullscreen ? "calc(100% - 40px)" : 240 }}
          title={widget.title}
        />
      )}
    </div>
  );
}
