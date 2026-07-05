// §4.2 — FilePresentationCard.
//
// Renders one or more "presented" files as interactive cards with
// action buttons (open in viewer, copy path). The agent's
// `present_file` tool returns a `presentedFiles` array; this component
// reads that array and renders the cards.

import { useState } from "react";
import {
  Check,
  Copy,
  FileText,
  FileImage,
  FileArchive,
  FileCode,
  FileQuestion,
  ExternalLink,
  FolderOpen
} from "lucide-react";

export type PresentedFile = {
  path: string;
  fullPath: string;
  name: string;
  ext: string;
  size: number;
  mtime: string;
  isDirectory: boolean;
  label?: string;
  description?: string;
};

type FileKind = "image" | "archive" | "document" | "code" | "other";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif"]);
const ARCHIVE_EXTS = new Set([".zip", ".tar", ".tar.gz", ".tgz", ".gz", ".7z", ".rar"]);
const DOCUMENT_EXTS = new Set([".md", ".markdown", ".txt", ".rtf", ".pdf"]);
const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".rs", ".go", ".java", ".kt", ".swift",
  ".c", ".cpp", ".cc", ".h", ".hpp", ".cs", ".php",
  ".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd",
  ".html", ".css", ".scss", ".less", ".vue", ".svelte",
  ".json", ".yaml", ".yml", ".toml", ".xml", ".ini", ".env",
  ".sql", ".graphql", ".proto", ".lua"
]);

function classifyExtension(ext: string): FileKind {
  if (IMAGE_EXTS.has(ext)) return "image";
  if (ARCHIVE_EXTS.has(ext)) return "archive";
  if (DOCUMENT_EXTS.has(ext)) return "document";
  if (CODE_EXTS.has(ext)) return "code";
  return "other";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function FileIcon({ kind, isDirectory }: { kind: FileKind; isDirectory: boolean }) {
  if (isDirectory) {
    return <FolderOpen className="h-4 w-4 text-muted-foreground" />;
  }
  const cls = "h-4 w-4";
  if (kind === "image") return <FileImage className={`${cls} text-blue-400`} />;
  if (kind === "archive") return <FileArchive className={`${cls} text-amber-400`} />;
  if (kind === "document") return <FileText className={`${cls} text-emerald-400`} />;
  if (kind === "code") return <FileCode className={`${cls} text-violet-400`} />;
  return <FileQuestion className={`${cls} text-muted-foreground`} />;
}

function FileCard({ file }: { file: PresentedFile }) {
  const [copied, setCopied] = useState(false);
  const kind = classifyExtension(file.ext);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(file.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — clipboard may not be available
    }
  };

  const handleOpen = () => {
    // Dispatch a `workspace:open-file` event that the file tree listens
    // for. This reuses the same plumbing the Go-to-file palette uses,
    // so the file opens in the standard viewer.
    window.dispatchEvent(
      new CustomEvent("workspace:open-file", { detail: { path: file.path } })
    );
  };

  return (
    <div className="flex flex-col gap-2 rounded border border-border/60 bg-card-3 p-3 hover:border-border transition-colors">
      <div className="flex items-start gap-2">
        <FileIcon kind={kind} isDirectory={file.isDirectory} />
        <div className="flex-1 min-w-0">
          <div className="font-mono text-[12px] font-medium text-foreground truncate" title={file.path}>
            {file.label || file.name}
          </div>
          <div className="font-mono text-[10px] text-muted-foreground/60 truncate" title={file.fullPath}>
            {file.path}
          </div>
        </div>
      </div>
      {file.description && (
        <div className="text-[11px] text-muted-foreground/80 leading-snug">{file.description}</div>
      )}
      <div className="flex items-center justify-between gap-2 pt-1 border-t border-border/40">
        <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-muted-foreground/60">
          <span>{kind}</span>
          <span>·</span>
          <span>{formatBytes(file.size)}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleOpen}
            className="flex items-center gap-1 rounded border border-border/60 bg-card px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-foreground/80 hover:border-foreground/40 hover:text-foreground transition-colors"
            title="Open in viewer"
          >
            <ExternalLink className="h-3 w-3" />
            Open
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 rounded border border-border/60 bg-card px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-foreground/80 hover:border-foreground/40 hover:text-foreground transition-colors"
            title="Copy relative path"
          >
            {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function FilePresentationCard({ files }: { files: PresentedFile[] }) {
  if (files.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 my-2">
      <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.16em] text-muted-foreground/60">
        <span>Files</span>
        <span className="text-muted-foreground/30">·</span>
        <span>{files.length}</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {files.map((f) => (
          <FileCard key={f.path} file={f} />
        ))}
      </div>
    </div>
  );
}
