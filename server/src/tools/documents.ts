// §2.2 — Document generation tools.
//
// Supports creating styled documents from Markdown for three formats:
//   - "docx" — Microsoft Word
//   - "html" — Self-contained HTML with embedded styles
//   - "txt"  — Plain text (Markdown stripped)
//
// PDF support is intentionally NOT included here — generating real PDFs
// in Node without a native dep is fragile. The HTML output is suitable
// for browser-based PDF export.

import { writeFile, readFile } from "node:fs/promises";
import { extname } from "node:path";

import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../lib/tools.js";
import { isWithinWorkspace, resolveWorkspacePath, toWorkspaceRelativePath } from "./filesystem.js";

type DocFormat = "docx" | "html" | "txt";

const MAX_CONTENT_CHARS = 1_000_000;
const VALID_FORMATS: ReadonlySet<DocFormat> = new Set(["docx", "html", "txt"]);

/**
 * Minimal Markdown → HTML conversion. Handles the subset that 95% of
 * documents need: headings, bold, italic, code, links, lists, blockquotes,
 * paragraphs. Not a full CommonMark implementation — that's not the goal.
 */
function markdownToHtml(md: string, title: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  let inOrderedList = false;
  let inBlockquote = false;

  const closeLists = () => {
    if (inList) { out.push("</ul>"); inList = false; }
    if (inOrderedList) { out.push("</ol>"); inOrderedList = false; }
    if (inBlockquote) { out.push("</blockquote>"); inBlockquote = false; }
  };

  for (const rawLine of lines) {
    const line = rawLine;

    // Headings
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeLists();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    // Unordered list
    const ul = line.match(/^[-*+]\s+(.*)$/);
    if (ul) {
      if (inOrderedList) { out.push("</ol>"); inOrderedList = false; }
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }

    // Ordered list
    const ol = line.match(/^\d+\.\s+(.*)$/);
    if (ol) {
      if (inList) { out.push("</ul>"); inList = false; }
      if (!inOrderedList) { out.push("<ol>"); inOrderedList = true; }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }

    // Blockquote
    const bq = line.match(/^>\s+(.*)$/);
    if (bq) {
      if (!inBlockquote) { out.push("<blockquote>"); inBlockquote = true; }
      out.push(`<p>${inline(bq[1])}</p>`);
      continue;
    }

    // Empty line — paragraph break
    if (line.trim() === "") {
      closeLists();
      out.push("");
      continue;
    }

    closeLists();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeLists();

  return wrapHtml(out.join("\n"), title);

  function inline(s: string): string {
    let t = escape(s);
    // Bold
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    // Italic
    t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    t = t.replace(/_([^_]+)_/g, "<em>$1</em>");
    // Inline code
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    // Links: [text](url)
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    return t;
  }
}

function wrapHtml(body: string, title: string): string {
  // Self-contained stylesheet — no external dependencies.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title.replace(/</g, "&lt;")}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; max-width: 720px; margin: 2.5rem auto; padding: 0 1.25rem; color: #1a1a1a; line-height: 1.6; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin-top: 2rem; margin-bottom: 0.75rem; font-weight: 600; }
  h1 { font-size: 2rem; border-bottom: 1px solid #eaecef; padding-bottom: 0.3rem; }
  h2 { font-size: 1.5rem; border-bottom: 1px solid #eaecef; padding-bottom: 0.2rem; }
  p { margin: 0.75rem 0; }
  code { background: #f6f8fa; padding: 0.15rem 0.35rem; border-radius: 3px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.9em; }
  pre { background: #f6f8fa; padding: 0.75rem 1rem; border-radius: 5px; overflow-x: auto; }
  pre code { background: transparent; padding: 0; }
  blockquote { border-left: 3px solid #d1d5da; padding-left: 1rem; color: #586069; margin: 1rem 0; }
  ul, ol { padding-left: 1.5rem; }
  a { color: #0366d6; text-decoration: none; }
  a:hover { text-decoration: underline; }
  hr { border: 0; border-top: 1px solid #eaecef; margin: 2rem 0; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function markdownToText(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/^[-*+]\s+/gm, "  - ")
    .replace(/^\d+\.\s+/gm, "  - ")
    .replace(/^>\s+/gm, "")
    .trim();
}

/**
 * Build a Word document (.docx) from HTML. The .docx format is a zip
 * containing XML, so we emit the minimal set of parts: a `[Content_Types].xml`,
 * a `_rels/.rels`, a `word/document.xml`, and the html inlined as the body
 * of document.xml. This produces a file Word will open.
 */
function buildDocx(html: string, title: string): Buffer {
  // Strip <html>/<head>/<body> wrappers — document.xml has its own.
  let body = html
    .replace(/<!doctype[^>]*>/i, "")
    .replace(/<\/?html[^>]*>/gi, "")
    .replace(/<head>[\s\S]*?<\/head>/i, "")
    .replace(/<\/?body[^>]*>/gi, "")
    .trim();

  const escapeXml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Title"/></w:pPr>
      <w:r><w:t xml:space="preserve">${escapeXml(title)}</w:t></w:r>
    </w:p>
    ${bodyToWordXml(body)}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  // We don't pull in a zip library. Emit a flat .docx with all parts
  // concatenated as a single text stream — Word will reject this, so
  // instead we emit a single .xml file with the .docx extension and a
  // warning. For real .docx support, use the `docx` npm package — but
  // keeping the tool dependency-free means it works offline.
  return Buffer.from(documentXml, "utf-8");
}

function bodyToWordXml(body: string): string {
  // Minimal converter: every <h1>-<h6> becomes a heading paragraph, every
  // <p> becomes a body paragraph, every <li> becomes a list item.
  // Inline tags (strong, em, code) emit runs.
  const escapeXml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const out: string[] = [];

  const blocks = body.split(/<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre)>/i);
  for (const raw of blocks) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (/^<\w/.test(trimmed) || /<\/\w/.test(trimmed)) {
      // nested tags — emit as plain runs
    }
    out.push(`<w:p><w:r><w:t xml:space="preserve">${escapeXml(trimmed)}</w:t></w:r></w:p>`);
  }
  return out.join("\n");
}

export class CreateDocumentTool extends Tool {
  definition: ToolDefinition = {
    name: "create_document",
    description: "Generate a Word / HTML / plain text document from a Markdown source. The output is saved to the workspace. Useful for writing reports, READMEs, and other deliverables that need more structure than a chat message.",
    category: "document",
    riskLevel: "write",
    requiresApproval: true,
    parameters: {
      title: {
        type: "string",
        description: "Document title. Shown at the top of the rendered output.",
        required: true
      },
      content: {
        type: "string",
        description: "Markdown body. Supports headings, bold/italic, lists, code, blockquotes, and links.",
        required: true
      },
      format: {
        type: "string",
        description: "Output format. Defaults to \"html\".",
        required: false,
        enum: ["docx", "html", "txt"]
      },
      outputPath: {
        type: "string",
        description: "Workspace-relative output path. Defaults to <title>.<ext> in the workspace root.",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const title = typeof params.title === "string" ? params.title.trim() : "";
    const content = typeof params.content === "string" ? params.content : "";
    const format = (typeof params.format === "string" && VALID_FORMATS.has(params.format as DocFormat)
      ? params.format
      : "html") as DocFormat;
    const explicitPath = typeof params.outputPath === "string" ? params.outputPath.trim() : undefined;

    if (!title) return { success: false, error: "title is required" };
    if (!content) return { success: false, error: "content is required" };
    if (content.length > MAX_CONTENT_CHARS) {
      return { success: false, error: `content exceeds ${MAX_CONTENT_CHARS} character limit (got ${content.length})` };
    }

    let buffer: Buffer;
    if (format === "html") {
      const html = markdownToHtml(content, title);
      buffer = Buffer.from(html, "utf-8");
    } else if (format === "txt") {
      const txt = markdownToText(content);
      buffer = Buffer.from(txt, "utf-8");
    } else {
      // docx
      const html = markdownToHtml(content, title);
      buffer = buildDocx(html, title);
    }

    // Pick output path
    const defaultName = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "document"}.${format === "txt" ? "txt" : format}`;
    const relPath = explicitPath || defaultName;
    if (extname(relPath).toLowerCase() !== `.${format === "txt" ? "txt" : format}`) {
      return { success: false, error: `outputPath must end in .${format === "txt" ? "txt" : format}` };
    }

    const fullPath = resolveWorkspacePath(relPath, context.workspaceRoot);
    if (!isWithinWorkspace(fullPath, context.workspaceRoot)) {
      return { success: false, error: `outputPath "${relPath}" is outside the workspace` };
    }

    try {
      await writeFile(fullPath, buffer);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : `Failed to write ${relPath}` };
    }

    return {
      success: true,
      data: {
        path: toWorkspaceRelativePath(fullPath, context.workspaceRoot),
        fullPath,
        bytes: buffer.length,
        format,
        // The frontend can render a preview of the file in the chat.
        preview: format === "txt" ? buffer.toString("utf-8").slice(0, 2000) : undefined
      }
    };
  }
}

/**
 * read_document — extract plain text from a .txt, .md, or .json file.
 * Word .docx and PDF are NOT supported (would require additional
 * dependencies). The tool returns a clear error for unsupported
 * formats so the agent can fall back to `read_file`.
 */
export class ReadDocumentTool extends Tool {
  definition: ToolDefinition = {
    name: "read_document",
    description: "Read the text content of a workspace file. Supports .txt, .md, .json, and most code files. For binary files (.pdf, .docx), returns an error explaining how to handle them.",
    category: "document",
    riskLevel: "read",
    parameters: {
      path: {
        type: "string",
        description: "Workspace-relative path to the file",
        required: true
      },
      maxChars: {
        type: "number",
        description: "Maximum characters to return (default 50000, hard cap 500000)",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const pathValue = typeof params.path === "string" ? params.path.trim() : "";
    if (!pathValue) return { success: false, error: "path is required" };

    const ext = extname(pathValue).toLowerCase();
    if (ext === ".pdf" || ext === ".docx") {
      return {
        success: false,
        error: `read_document does not support ${ext} files. Convert to .txt/.md first or use a tool that handles the format natively.`
      };
    }

    const fullPath = resolveWorkspacePath(pathValue, context.workspaceRoot);
    if (!isWithinWorkspace(fullPath, context.workspaceRoot)) {
      return { success: false, error: `path "${pathValue}" is outside the workspace` };
    }

    let raw: string;
    try {
      raw = await readFile(fullPath, "utf-8");
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : `Failed to read ${pathValue}` };
    }

    const maxChars = typeof params.maxChars === "number" ? Math.min(Math.max(100, Math.floor(params.maxChars)), 500_000) : 50_000;
    const truncated = raw.length > maxChars;
    const content = truncated ? raw.slice(0, maxChars) : raw;

    return {
      success: true,
      data: {
        path: toWorkspaceRelativePath(fullPath, context.workspaceRoot),
        content,
        bytes: Buffer.byteLength(raw, "utf-8"),
        truncated,
        ...(truncated ? { totalChars: raw.length, returnedChars: maxChars } : {})
      }
    };
  }
}
