// §2.5 — Interactive widget rendering tool.
//
// The agent can produce inline HTML/SVG/Chart widgets that render
// directly in the chat. The tool sanitizes the HTML, embeds it in a
// structured envelope, and the frontend's `WidgetRenderer` displays it
// inside a CSP-sandboxed iframe so scripts can't escape the widget.
//
// Security: we strip <script> tags pointing to external sources,
// <iframe> with non-allowlisted src, and on* event handlers. Inline
// styles are allowed (needed for visualizations). External resources
// (images, fonts) are loaded through the `data-src` attribute which the
// iframe allowlist then maps to `src`.

import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../lib/tools.js";

const MAX_HTML_CHARS = 200_000;
const MAX_DATA_KEYS = 32;

/**
 * Sanitize an HTML fragment. Designed to be safe inside a
 * `sandbox="allow-scripts allow-same-origin"` iframe — the parent page
 * doesn't render the HTML, the iframe does, and the sandbox limits what
 * the iframe can do.
 *
 * The sanitizer is intentionally simple: it strips <script> tags, <iframe>
 * with external srcs, and on* event handlers. Anything beyond that is the
 * iframe's CSP problem.
 */
function sanitizeHtml(html: string): { cleaned: string; removed: string[] } {
  const removed: string[] = [];
  let cleaned = html;

  // Strip <script>...</script> blocks.
  const scriptMatches = cleaned.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [];
  if (scriptMatches.length > 0) removed.push(`${scriptMatches.length} <script> tag(s)`);
  cleaned = cleaned.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");

  // Strip inline event handlers (onclick, onload, ...).
  const onHandler = cleaned.match(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi) ?? [];
  if (onHandler.length > 0) removed.push(`${onHandler.length} on* handler(s)`);
  cleaned = cleaned.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // Strip <iframe>/<frame>/<object>/<embed> entirely — they could nest
  // hostile content even inside the sandbox.
  const iframeMatches = cleaned.match(/<(iframe|frame|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi) ?? [];
  if (iframeMatches.length > 0) removed.push(`${iframeMatches.length} <iframe/frame/object/embed>`);
  cleaned = cleaned.replace(/<(iframe|frame|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Strip <meta http-equiv="refresh" ...> redirects.
  const metaRefresh = cleaned.match(/<meta\s+http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi) ?? [];
  if (metaRefresh.length > 0) removed.push(`${metaRefresh.length} <meta http-equiv="refresh">`);
  cleaned = cleaned.replace(/<meta\s+http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "");

  // Strip javascript: URLs in href/src.
  const jsUrls = cleaned.match(/(href|src)\s*=\s*["']?\s*javascript:/gi) ?? [];
  if (jsUrls.length > 0) removed.push(`${jsUrls.length} javascript: URL(s)`);
  cleaned = cleaned.replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'\s>]*/gi, "$1=$2");

  return { cleaned: cleaned.trim(), removed };
}

export class RenderWidgetTool extends Tool {
  definition: ToolDefinition = {
    name: "render_widget",
    description: "Render an interactive HTML/SVG widget inline in the chat. The `html` parameter is sanitized for safety (scripts and event handlers are stripped) and embedded in a sandboxed iframe. The optional `data` map is serialized to JSON and made available to the widget's JavaScript via `window.__WIDGET_DATA__`.",
    category: "media",
    riskLevel: "read",
    parameters: {
      title: {
        type: "string",
        description: "Title shown above the widget. The user can collapse the widget by clicking the title.",
        required: true
      },
      html: {
        type: "string",
        description: "HTML fragment. SVG is allowed. Inline styles work; external stylesheets need the host page to load them. Interactive elements should rely on inline event handlers...wait, those are stripped. Use CSS-only interaction or pre-rendered SVG.",
        required: true
      },
      data: {
        type: "object",
        description: "Optional data map (max 32 keys). Serialized to JSON and exposed to the widget's JavaScript as window.__WIDGET_DATA__.",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
    const title = typeof params.title === "string" ? params.title.trim() : "";
    if (!title) return { success: false, error: "title is required" };
    if (title.length > 200) return { success: false, error: "title must be <= 200 characters" };

    const html = typeof params.html === "string" ? params.html : "";
    if (!html.trim()) return { success: false, error: "html is required and must be a non-empty string" };
    if (html.length > MAX_HTML_CHARS) {
      return {
        success: false,
        error: `html exceeds ${MAX_HTML_CHARS} character limit (got ${html.length})`
      };
    }

    const data = params.data;
    if (data !== undefined) {
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        return { success: false, error: "data must be a plain object" };
      }
      const keys = Object.keys(data);
      if (keys.length > MAX_DATA_KEYS) {
        return { success: false, error: `data has ${keys.length} keys; max is ${MAX_DATA_KEYS}` };
      }
    }

    const { cleaned, removed } = sanitizeHtml(html);

    return {
      success: true,
      data: {
        // The frontend's agent-steps-viewer looks for this `widget`
        // shape and renders it with `WidgetRenderer`.
        widget: {
          title,
          html: cleaned,
          ...(data !== undefined ? { data } : {}),
          // Surface what was stripped so the user can see why their
          // widget might not behave as expected.
          sanitized: removed.length > 0 ? removed : undefined
        }
      }
    };
  }
}
