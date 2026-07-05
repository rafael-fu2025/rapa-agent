import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Download, Maximize2, Minimize2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight, vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import "katex/dist/katex.min.css";
import { useTheme } from "../hooks/use-theme";

type AssistantMarkdownProps = {
  content: string;
  hideThoughtBlock?: boolean;
};

type CodeBlockProps = {
  className?: string;
  children: React.ReactNode;
};

const CodeBlock = ({ className, children }: CodeBlockProps) => {
  const [copied, setCopied] = useState(false);
  const { resolved } = useTheme();
  const isDark = resolved === "dark";

  const language = className?.replace("language-", "") || "text";
  const raw = String(children ?? "").replace(/\n$/, "");
  const isSingleLineSnippet = !raw.includes("\n") && raw.trim().length > 0 && raw.trim().length <= 80;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  const handleDownload = () => {
    const blob = new Blob([raw], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `snippet.${language === "text" ? "txt" : language}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (isSingleLineSnippet) {
    return (
      <code className="inline-flex rounded border border-border/40 bg-card-3/50 px-1.5 py-0.5 font-mono-tech text-[10px] leading-[1.2] align-middle text-foreground">
        {raw}
      </code>
    );
  }

  return (
    <div className="mb-3 overflow-hidden rounded border border-border/40 bg-card-3/40" style={{ backdropFilter: "blur(16px)" }}>
      {/* Header bar */}
      <div className="flex items-center justify-between border-b border-border/30 bg-card-3/60 px-3 py-1.5">
        <span className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
          {language}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleDownload}
            className="rounded border border-border/40 p-1 text-muted-foreground/60 transition-colors hover:border-border hover:text-foreground"
            title="Download"
            type="button"
          >
            <Download size={12} />
          </button>
          <button
            onClick={() => {
              void handleCopy();
            }}
            className="rounded border border-border/40 p-1 text-muted-foreground/60 transition-colors hover:border-border hover:text-foreground"
            title="Copy"
            type="button"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
      </div>

      {/* Code body */}
      <div className="overflow-x-auto">
        <SyntaxHighlighter
          language={language}
          style={isDark ? vscDarkPlus : oneLight}
          wrapLongLines={false}
          customStyle={{
            margin: 0,
            borderRadius: 0,
            background: "transparent",
            fontSize: "11px",
            lineHeight: "1.6",
            padding: "10px 12px"
          }}
        >
          {raw}
        </SyntaxHighlighter>
      </div>
    </div>
  );
};

type ParsedThoughtContent = {
  hasThoughtTag: boolean;
  thoughtText: string;
  mainContent: string;
};

function parseThoughtContent(content: string): ParsedThoughtContent {
  const mainParts: string[] = [];
  const thoughtParts: string[] = [];
  const supportedTags = ["thinking", "thought", "think", "reasoning"] as const;

  let cursor = 0;
  let hasThoughtTag = false;

  while (cursor < content.length) {
    let openIndex = -1;
    let openTag = "";
    let closeTag = "";

    for (const tag of supportedTags) {
      const candidateOpenTag = `<${tag}>`;
      const candidateIndex = content.toLowerCase().indexOf(candidateOpenTag, cursor);
      if (candidateIndex !== -1 && (openIndex === -1 || candidateIndex < openIndex)) {
        openIndex = candidateIndex;
        openTag = candidateOpenTag;
        closeTag = `</${tag}>`;
      }
    }

    if (openIndex === -1) {
      mainParts.push(content.slice(cursor));
      break;
    }

    hasThoughtTag = true;
    mainParts.push(content.slice(cursor, openIndex));

    const thoughtStart = openIndex + openTag.length;
    const closeIndex = content.toLowerCase().indexOf(closeTag, thoughtStart);

    if (closeIndex === -1) {
      thoughtParts.push(content.slice(thoughtStart));
      cursor = content.length;
      break;
    }

    thoughtParts.push(content.slice(thoughtStart, closeIndex));
    cursor = closeIndex + closeTag.length;
  }

  return {
    hasThoughtTag,
    thoughtText: thoughtParts.join("\n\n").trim(),
    mainContent: mainParts.join("").trim()
  };
}

function normalizeMathDelimiters(content: string) {
  return content
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((segment) => {
      if (!segment || segment.startsWith("`")) return segment;

      return segment
        .replace(/\\\[([\s\S]*?)\\\]/g, (_match, equation: string) => `\n$$\n${equation.trim()}\n$$\n`)
        .replace(/\\\(([\s\S]*?)\\\)/g, (_match, equation: string) => `$${equation.trim()}$`);
    })
    .join("");
}

function stripResidualToolMarkup(content: string) {
  let sanitized = content;

  const completeBlockPatterns = [
    /<toolCall>[\s\S]*?<\/toolCall>/gi,
    /<tool_call>[\s\S]*?<\/tool_call>/gi,
    /<function_call>[\s\S]*?<\/function_call>/gi,
    /<invoke>[\s\S]*?<\/invoke>/gi,
    /<longcat_tool_call>[\s\S]*?<\/longcat_tool_call>/gi,
  ];

  for (const pattern of completeBlockPatterns) {
    sanitized = sanitized.replace(pattern, " ");
  }

  const jsonMatch = sanitized.match(/(?:```(?:json)?\s*)?\{[\s\n]*"toolCalls"[\s\S]*/);
  if (jsonMatch) {
    sanitized = sanitized.replace(jsonMatch[0], "");
  }

  return sanitized
    .replace(/<\/?(toolCall|tool_call|function_call|invoke|longcat_tool_call|name|parameters|id|longcat_arg_key|longcat_arg_value)\b[^>]*>/gi, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export const AssistantMarkdown = ({ content, hideThoughtBlock }: AssistantMarkdownProps) => {
  const safeContent = useMemo(() => stripResidualToolMarkup(content), [content]);
  const { hasThoughtTag, thoughtText, mainContent } = useMemo(() => parseThoughtContent(safeContent), [safeContent]);
  const normalizedThoughtText = useMemo(() => normalizeMathDelimiters(thoughtText || "Thinking..."), [thoughtText]);
  const normalizedMainContent = useMemo(() => normalizeMathDelimiters(mainContent), [mainContent]);
  const [isThoughtExpanded, setIsThoughtExpanded] = useState(false);
  const thoughtPanelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hasThoughtTag || hideThoughtBlock) {
      setIsThoughtExpanded(false);
      return;
    }

    if (!isThoughtExpanded && thoughtPanelRef.current) {
      thoughtPanelRef.current.scrollTop = thoughtPanelRef.current.scrollHeight;
    }
  }, [hasThoughtTag, thoughtText, isThoughtExpanded, hideThoughtBlock]);

  return (
    <div className="w-full min-w-0 overflow-hidden font-mono-tech text-[10px] leading-normal text-primary">
      {hasThoughtTag && !hideThoughtBlock && (
        <div className="mb-4 overflow-hidden rounded border border-border/40 bg-card-3/40" style={{ backdropFilter: "blur(16px)" }}>
          <div className="flex items-center justify-between border-b border-border/30 px-3 py-2">
            <span className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">thinking</span>
            <button
              onClick={() => setIsThoughtExpanded((prev) => !prev)}
              className="rounded border border-border/40 p-1 text-muted-foreground/60 hover:border-border hover:text-foreground transition-colors"
              type="button"
              title={isThoughtExpanded ? "Collapse thinking panel" : "Expand thinking panel"}
            >
              {isThoughtExpanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
            </button>
          </div>

          <div
            ref={thoughtPanelRef}
            className={`${isThoughtExpanded ? "max-h-48" : "h-40"} sidebar-scroll overflow-x-hidden overflow-y-auto px-3 py-2.5 text-[10px] leading-relaxed font-light italic text-muted-foreground/80 break-words [overflow-wrap:anywhere] min-w-0`}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
              components={{
                p: ({ children }) => <p className="mb-1 break-words last:mb-0">{children}</p>,
                ul: ({ children }) => <ul className="mb-1 list-disc space-y-1 break-words pl-6">{children}</ul>,
                ol: ({ children }) => <ol className="mb-1 list-decimal space-y-1 break-words pl-6">{children}</ol>,
                li: ({ children }) => <li>{children}</li>
              }}
            >
              {normalizedThoughtText}
            </ReactMarkdown>
          </div>
        </div>
      )}

      {mainContent ? (
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
          components={{
                p: ({ children }) => <p className="mb-1.5 last:mb-0">{children}</p>,
            ul: ({ children }) => <ul className="list-disc pl-5 mb-1.5 space-y-0.5">{children}</ul>,
            ol: ({ children }) => <ol className="list-decimal pl-5 mb-1.5 space-y-0.5">{children}</ol>,
            li: ({ children }) => <li>{children}</li>,
            h1: ({ children }) => <h1 className="text-lg font-semibold mb-1.5">{children}</h1>,
            h2: ({ children }) => <h2 className="text-base font-semibold mb-1.5">{children}</h2>,
            h3: ({ children }) => <h3 className="text-sm font-semibold mb-1.5">{children}</h3>,
            blockquote: ({ children }) => (
              <blockquote className="border-l-2 border-border pl-3 text-muted-foreground mb-1.5">{children}</blockquote>
            ),
            table: ({ children }) => (
              <div className="mb-4 overflow-x-auto rounded border border-border/40 bg-card-3/40" style={{ backdropFilter: "blur(16px)" }}>
                <table className="min-w-full border-collapse">
                  {children}
                </table>
              </div>
            ),
            thead: ({ children }) => (
              <thead className="bg-card-3/60">{children}</thead>
            ),
            tbody: ({ children }) => (
              <tbody className="bg-transparent">{children}</tbody>
            ),
            tr: ({ children }) => (
              <tr className="border-b border-border/40 last:border-b-0">{children}</tr>
            ),
            th: ({ children }) => (
              <th className="px-3 py-1.5 text-left font-mono-tech font-semibold text-[9px] text-muted-foreground/60 uppercase tracking-[0.16em]">
                {children}
              </th>
            ),
            td: ({ children }) => (
              <td className="px-3 py-1.5 text-[10px] text-foreground leading-4">
                {children}
              </td>
            ),
            code: ({ inline, className, children, ...props }: any) => {
              if (inline) {
                return (
                  <code className="rounded border border-border/40 bg-card-3/50 px-1.5 py-0.5 font-mono-tech text-[10px] text-foreground" {...props}>
                    {children}
                  </code>
                );
              }

              return <CodeBlock className={className}>{children}</CodeBlock>;
            }
          }}
        >
          {normalizedMainContent}
        </ReactMarkdown>
      ) : null}
    </div>
  );
};
