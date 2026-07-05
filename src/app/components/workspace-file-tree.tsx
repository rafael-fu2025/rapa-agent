import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  RefreshCw,
  Loader2,
  Copy,
  Link as LinkIcon,
  Maximize2,
  Minimize2,
  Search as SearchIcon,
  ExternalLink,
  Terminal as TerminalIcon,
  X,
  FilePlus,
  FolderPlus,
  Pencil,
  Trash2,
  Download,
  Clock,
  CheckSquare
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "./ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from "./ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "./ui/alert-dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Button } from "./ui/button";
import { cn } from "../../lib/utils";
import { toast } from "sonner";
import {
  getWorkspaceTree,
  getWorkspaceFileStat,
  type WorkspaceTreeNode,
  type WorkspaceTreeResponse,
  type WorkspaceFileStat
} from "../../lib/workspace-api";
import { API_BASE } from "../../lib/api";
import { FileViewerDialog } from "./file-viewer";

type Props = {
  workspaceId: string | null;
  workspaceName?: string;
};

// Files to hide from the tree for cleanliness
const HIDDEN_ENTRIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "web-dist",
  ".next",
  ".cache",
  ".tsbuildinfo",
  ".env",
  ".env.local",
]);

// File extension to color mapping
const EXT_COLORS: Record<string, string> = {
  ts: "text-accent-blue/70",
  tsx: "text-accent-blue/70",
  js: "text-accent-yellow/70",
  jsx: "text-accent-yellow/70",
  css: "text-accent-purple/70",
  html: "text-accent-orange/70",
  json: "text-accent-green/70",
  md: "text-muted-foreground/70",
  sql: "text-accent-cyan/70",
  prisma: "text-accent-cyan/70",
  env: "text-muted-foreground/50",
};

function getFileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function getFileColor(name: string): string {
  const ext = getFileExtension(name);
  return EXT_COLORS[ext] ?? "text-muted-foreground/60";
}

function filterTree(nodes: WorkspaceTreeNode[]): WorkspaceTreeNode[] {
  return nodes
    .filter((node) => !HIDDEN_ENTRIES.has(node.name) && !node.name.startsWith(".DS_Store"))
    .map((node) => ({
      ...node,
      children: node.children ? filterTree(node.children) : undefined,
    }))
    .sort((a, b) => {
      // Directories first, then alphabetical
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

// Flatten a tree into a list of relative paths in the same display
// order as the rendered tree (depth-first, directories first, then
// alphabetical). Used by Shift+click range selection so the user can
// see the same range they're selecting.
function flattenPaths(nodes: WorkspaceTreeNode[]): string[] {
  const out: string[] = [];
  const walk = (list: WorkspaceTreeNode[]) => {
    for (const n of list) {
      out.push(n.relativePath);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * Filter out paths whose ancestor is also in the set.
 *
 * Shift-clicking in a tree often selects a parent directory AND its
 * children. If we then issue parallel DELETEs for all of them, the
 * parent delete succeeds but every child delete fails with 404
 * (the parent already removed them) — and the user sees a confusing
 * "X deleted, Y failed" toast.
 *
 * We sort the paths so shorter (parent) paths come first, then for
 * each path check if any earlier path is a strict ancestor. If so,
 * skip it. The remaining list has no overlapping coverage.
 */
function dedupePathsByAncestor(paths: string[]): string[] {
  if (paths.length <= 1) return paths;
  // Normalize separators so ancestor checks work on Windows too.
  const normalized = paths.map((p) => p.split("\\").join("/")).sort();
  const kept: string[] = [];
  for (const p of normalized) {
    let isCovered = false;
    for (const k of kept) {
      // A path is covered by an ancestor if it starts with the
      // ancestor + "/". The ancestor must be strictly shorter
      // (handled by the sort order — ancestors are always shorter
      // than their descendants).
      if (p === k) {
        // Exact duplicate — keep only the first one.
        isCovered = true;
        break;
      }
      if (p.startsWith(k + "/")) {
        isCovered = true;
        break;
      }
    }
    if (!isCovered) kept.push(p);
  }
  return kept;
}

type TreeNodeProps = {
  node: WorkspaceTreeNode;
  depth: number;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  onFileClick?: (relativePath: string) => void;
  onExpandAll: (path: string) => void;
  onCopyPath: (path: string, label: "absolute" | "relative") => void;
  // The reveal/terminal/search handlers take the workspace-relative path,
  // because that's what the backend APIs expect. The frontend
  // resolves it to an absolute path on display only (Copy absolute path).
  onReveal: (relativePath: string) => void;
  onOpenInTerminal: (relativePath: string) => void;
  onSearchInFolder: (relativePath: string) => void;
  // Tier 2: file mutations. All paths are workspace-relative. The
  // parent (WorkspaceFileTreeContent) wires these to the new REST
  // endpoints and refreshes the tree when any of them completes.
  onNewFile: (parentRelativePath: string) => void;
  onNewFolder: (parentRelativePath: string) => void;
  onRename: (relativePath: string, isDir: boolean) => void;
  onDelete: (relativePath: string, isDir: boolean) => void;
  onDuplicate: (relativePath: string) => void;
  onDownload: (relativePath: string) => void;
  // Tier 3: multi-select. The parent owns the selectedPaths set; the
  // node just dispatches click events with modifier keys.
  onSelect: (relativePath: string, modifiers: { ctrl: boolean; shift: boolean }) => void;
  isSelected: boolean;
  // Tier 3: inline rename. The parent passes an optional inline-rename
  // target; when this node's path matches, the row renders as an input
  // instead of a button. The parent owns the state and clears it on
  // submit / cancel.
  inlineRenameState: InlineRenameState | null;
  onInlineRenameChange: (value: string) => void;
  onInlineRenameCommit: () => void;
  onInlineRenameCancel: () => void;
  // Tier 3: hover tooltip. The parent owns the stat cache + fetch
  // function; the row just calls into it via the tooltip body.
  fetchStat: (relativePath: string) => Promise<WorkspaceFileStat | null>;
};

// Inline-rename state. The parent owns it; the TreeNode just renders
// the input. `value` is the current input content; on commit the
// parent submits to the rename endpoint.
type InlineRenameState = {
  relativePath: string;
  baseName: string;
  ext: string;
  value: string;
};

const TreeNode = ({
  node,
  depth,
  expandedPaths,
  onToggle,
  onFileClick,
  onExpandAll,
  onCopyPath,
  onReveal,
  onOpenInTerminal,
  onSearchInFolder,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
  onDuplicate,
  onDownload,
  onSelect,
  isSelected,
  inlineRenameState,
  onInlineRenameChange,
  onInlineRenameCommit,
  onInlineRenameCancel,
  fetchStat
}: TreeNodeProps) => {
  const isDirectory = node.type === "directory";
  const isExpanded = expandedPaths.has(node.path);
  const paddingLeft = 8 + depth * 14;

  // If this node is the current inline-rename target, render the
  // row as an Input instead of a button. Pressing Enter commits,
  // Esc cancels, blur commits.
  const isRenaming = inlineRenameState?.relativePath === node.relativePath;

  // The actual row (the bit the user sees + clicks + right-clicks).
  // We render it as the ContextMenu trigger so right-clicking anywhere
  // on the row opens the actions menu. Left-click still toggles/opens.
  //
  // Tier 3 multi-select: Ctrl+click toggles this row's selection,
  // Shift+click selects a range from the last-clicked row. Plain
  // click keeps the existing single-row behaviour (toggle directory
  // expand, or open file in viewer) — selection is opt-in via
  // modifier keys. This matches the Finder/VS Code convention where
  // a plain click on a file opens it rather than just selecting it.
  const handleRowClick = (e: React.MouseEvent) => {
    const isModifier = e.ctrlKey || e.metaKey || e.shiftKey;
    if (isModifier) {
      onSelect(node.relativePath, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
      return;
    }
    // Plain click — no selection change, just the default action.
    if (isDirectory) {
      onToggle(node.path);
    } else if (onFileClick) {
      onFileClick(node.relativePath);
    }
  };

  // F2 keyboard shortcut: trigger the inline rename. The parent owns
  // the state, so we just call onRename. The same handler is also
  // wired to the row's onKeyDown (for keyboard nav).
  const handleRowKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "F2") {
      e.preventDefault();
      onRename(node.relativePath, isDirectory);
    } else if (e.key === "Enter" && !isDirectory && onFileClick) {
      // Plain Enter on a focused file row opens it (matches VS Code).
      e.preventDefault();
      onFileClick(node.relativePath);
    }
  };

  // Inline rename input — replaces the row when this node is the
  // active rename target. We render it as a sibling of the
  // ContextMenu-wrapped row (so the context menu is unavailable
  // while renaming).
  if (isRenaming && inlineRenameState) {
    return (
      <div
        className="flex w-full items-center gap-1.5 py-[1px] pr-2"
        style={{ paddingLeft }}
      >
        {/* Spacer + icon to align with the normal row. */}
        {isDirectory ? (
          <Folder size={12} className="shrink-0 text-accent-yellow/50" />
        ) : (
          <File size={11} className={cn("shrink-0", getFileColor(node.name))} />
        )}
        <div className="relative flex-1 min-w-0">
          <Input
            autoFocus
            value={inlineRenameState.value}
            onChange={(e) => onInlineRenameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onInlineRenameCommit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onInlineRenameCancel();
              }
            }}
            onBlur={() => onInlineRenameCommit()}
            className="h-6 px-1.5 py-0 text-[11px] font-mono-tech border-card-hover bg-card text-foreground"
            // Select the whole name on focus, but stop at the extension
            // (matches the rename dialog's behaviour).
            onFocus={(e) => {
              if (inlineRenameState.ext) {
                e.currentTarget.setSelectionRange(0, inlineRenameState.value.length);
              } else {
                e.currentTarget.select();
              }
            }}
            spellCheck={false}
            autoComplete="off"
          />
          {/* Render the extension as a static suffix inside the input
              so the user can see what's there without re-typing it. */}
          {inlineRenameState.ext && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-2 flex items-center font-mono-tech text-[11px] text-muted-foreground/70"
            >
              {inlineRenameState.ext}
            </span>
          )}
        </div>
      </div>
    );
  }

  // The visible part of the row, with optional selection checkmark.
  const label = (
    <span
      className={cn(
        "truncate font-mono-tech text-[11px]",
        isDirectory ? "font-medium text-foreground/80" : getFileColor(node.name)
      )}
    >
      {node.name}
    </span>
  );

  // Track hover state for the custom tooltip. We can't use Radix
  // Tooltip because it composes poorly with Radix ContextMenu (two
  // `asChild` parents don't nest cleanly — the inner TooltipTrigger
  // absorbs contextmenu events, which breaks the right-click menu).
  // A small custom tooltip driven by useState avoids the composition
  // issue entirely.
  const [isHovered, setIsHovered] = useState(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks whether the tooltip body has been "warmed up" by a recent
  // hover so re-entering the row after a brief gap doesn't trigger
  // the 500ms delay again (matches Radix's skipDelayDuration).
  const lastHoverEndedAtRef = useRef<number>(0);
  const HOVER_DELAY_MS = 500;
  const SKIP_DELAY_MS = 300;

  const handleRowMouseEnter = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    const sinceLast = Date.now() - lastHoverEndedAtRef.current;
    const delay = sinceLast < SKIP_DELAY_MS ? 0 : HOVER_DELAY_MS;
    hoverTimerRef.current = setTimeout(() => {
      setIsHovered(true);
    }, delay);
  };

  const handleRowMouseLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setIsHovered(false);
    lastHoverEndedAtRef.current = Date.now();
  };

  // Cleanup the timer on unmount.
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  // Render the row as a <button> so Radix's ContextMenuTrigger can
  // target a real, focusable, clickable element. The original Tier 1
  // implementation used a <button> too; we restored that because
  // the Tier 3 <div role="button"> approach didn't compose with
  // Radix ContextMenu.
  const row = (
    <button
      type="button"
      onClick={handleRowClick}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onRename(node.relativePath, isDirectory);
      }}
      onKeyDown={handleRowKeyDown}
      onMouseEnter={handleRowMouseEnter}
      onMouseLeave={handleRowMouseLeave}
      className={cn(
        "group relative flex w-full items-center gap-1.5 py-[3px] pr-2 text-left transition-colors focus:outline-none focus-visible:bg-accent/20",
        !isDirectory && "cursor-pointer",
        isDirectory && "cursor-pointer",
        isSelected ? "bg-accent/20" : "hover:bg-accent/10"
      )}
      style={{ paddingLeft }}
    >
      {isDirectory ? (
        <>
          {isExpanded ? (
            <ChevronDown size={10} className="shrink-0 text-muted-foreground/50" />
          ) : (
            <ChevronRight size={10} className="shrink-0 text-muted-foreground/50" />
          )}
          {isExpanded ? (
            <FolderOpen size={12} className="shrink-0 text-accent-yellow/60" />
          ) : (
            <Folder size={12} className="shrink-0 text-accent-yellow/50" />
          )}
          {label}
        </>
      ) : (
        <>
          <span className="w-[10px]" /> {/* spacer for alignment */}
          <File size={11} className={cn("shrink-0", getFileColor(node.name))} />
          {label}
        </>
      )}
      {isSelected && (
        <CheckSquare
          size={11}
          className="ml-auto shrink-0 text-accent-blue"
          aria-label="Selected"
        />
      )}
      {/* Custom hover tooltip. Rendered as a sibling of the row's
          children so it doesn't affect the button's flex layout.
          The tooltip is portaled via `fixed` positioning relative
          to the row's bounding rect. */}
      {isHovered && (
        <HoverTooltipCard
          relativePath={node.relativePath}
          isDirectory={isDirectory}
          fetchStat={fetchStat}
        />
      )}
    </button>
  );

  // Right-click actions. We compose the menu in render so adding more
  // actions (Tier 3+: drag-drop, multi-select, etc.) only requires
  // adding items here.
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          {isDirectory && (
            <>
              <ContextMenuItem
                onSelect={() => onExpandAll(node.path)}
                className="font-mono-tech text-[11px]"
              >
                <Maximize2 size={12} />
                Expand all
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => onOpenInTerminal(node.relativePath)}
                className="font-mono-tech text-[11px]"
              >
                <TerminalIcon size={12} />
                Open in terminal
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => onSearchInFolder(node.relativePath)}
                className="font-mono-tech text-[11px]"
              >
                <SearchIcon size={12} />
                Search in folder
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}

          {/* Tier 2 — file mutations. The "New file/folder" actions
              always create *inside* the right-clicked node if it's a
              directory, or as a sibling of the file otherwise. */}
          {isDirectory ? (
            <>
              <ContextMenuItem
                onSelect={() => onNewFile(node.relativePath)}
                className="font-mono-tech text-[11px]"
              >
                <FilePlus size={12} />
                New file…
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => onNewFolder(node.relativePath)}
                className="font-mono-tech text-[11px]"
              >
                <FolderPlus size={12} />
                New folder…
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          ) : null}

          {!isDirectory && (
            <>
              <ContextMenuItem
                onSelect={() => onDuplicate(node.relativePath)}
                className="font-mono-tech text-[11px]"
              >
                <Copy size={12} />
                Duplicate
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => onDownload(node.relativePath)}
                className="font-mono-tech text-[11px]"
              >
                <Download size={12} />
                Download
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}

          <ContextMenuItem
            onSelect={() => onRename(node.relativePath, isDirectory)}
            className="font-mono-tech text-[11px]"
          >
            <Pencil size={12} />
            Rename…
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => onDelete(node.relativePath, isDirectory)}
            className="font-mono-tech text-[11px] text-accent-red focus:text-accent-red"
          >
            <Trash2 size={12} />
            Delete…
          </ContextMenuItem>

          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => onCopyPath(node.path, "absolute")}
            className="font-mono-tech text-[11px]"
          >
            <LinkIcon size={12} />
            Copy absolute path
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => onCopyPath(node.relativePath, "relative")}
            className="font-mono-tech text-[11px]"
          >
            <Copy size={12} />
            Copy relative path
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => onReveal(node.relativePath)}
            className="font-mono-tech text-[11px]"
          >
            <ExternalLink size={12} />
            Reveal in file explorer
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {isDirectory && isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expandedPaths={expandedPaths}
              onToggle={onToggle}
              onFileClick={onFileClick}
              onExpandAll={onExpandAll}
              onCopyPath={onCopyPath}
              onReveal={onReveal}
              onOpenInTerminal={onOpenInTerminal}
              onSearchInFolder={onSearchInFolder}
              onNewFile={onNewFile}
              onNewFolder={onNewFolder}
              onRename={onRename}
              onDelete={onDelete}
              onDuplicate={onDuplicate}
              onDownload={onDownload}
              onSelect={onSelect}
              isSelected={isSelected}
              inlineRenameState={inlineRenameState}
              onInlineRenameChange={onInlineRenameChange}
              onInlineRenameCommit={onInlineRenameCommit}
              onInlineRenameCancel={onInlineRenameCancel}
              fetchStat={fetchStat}
            />
          ))}
        </div>
      )}
    </>
  );
};

// === Hover tooltip ============================================================
//
// Custom (non-Radix) tooltip that floats next to a tree row. We
// don't use Radix Tooltip here because it composes poorly with
// Radix ContextMenu (two `asChild` parents don't nest cleanly — the
// inner TooltipTrigger absorbs contextmenu events, breaking the
// right-click menu). The custom implementation is small: a
// useState-driven hover state, a 500ms delay, and a 300ms
// skip-delay for re-entering. The popover is positioned via
// `position: absolute` with `right: 0; top: 50%; transform:
// translate(100%, -50%)` to appear to the right of the row, which
// matches the right-sidebar's left edge.
function HoverTooltipCard({
  relativePath,
  isDirectory,
  fetchStat
}: {
  relativePath: string;
  isDirectory: boolean;
  fetchStat: (relativePath: string) => Promise<WorkspaceFileStat | null>;
}) {
  const [stat, setStat] = useState<WorkspaceFileStat | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchStat(relativePath).then((s) => {
      if (!cancelled) setStat(s);
    });
    return () => {
      cancelled = true;
    };
  }, [relativePath, fetchStat]);

  return (
    <div
      role="tooltip"
      // The popover is positioned to the right of the parent
      // button. We use `pointer-events: none` so the popover
      // itself doesn't block mouse events on the row underneath
      // (which would cause the row's onMouseLeave to fire when
      // the user accidentally mouses over the tooltip).
      className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 rounded border border-border bg-card px-2.5 py-1.5 text-left shadow-md max-w-[280px]"
    >
      <div className="space-y-0.5 font-mono-tech text-[10px]">
        <div className="text-foreground/90 break-all">{relativePath}</div>
        {stat ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            {isDirectory ? (
              <span>{stat.childCount ?? 0} items</span>
            ) : (
              <span>{formatBytes(stat.size)}</span>
            )}
            <span aria-hidden="true">·</span>
            <span>modified {formatRelativeTime(stat.mtime)}</span>
          </div>
        ) : (
          <div className="text-muted-foreground/60">loading…</div>
        )}
      </div>
    </div>
  );
}

// === Helpers =================================================================

// Format a byte count as "1.4 KB", "2.3 MB", etc. Uses 1024-based
// units (matches the OS file manager convention on Windows / macOS).
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIdx]}`;
}

// Format an ms-since-epoch timestamp as a relative time like
// "2 minutes ago", "yesterday", "3 days ago". For timestamps older
// than 30 days, falls back to a short date.
function formatRelativeTime(ms: number): string {
  const now = Date.now();
  const diff = now - ms;
  const seconds = Math.round(diff / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  // Fall back to a short date for older items.
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined });
}

export const WorkspaceFileTreeContent = ({ workspaceId, workspaceName }: Props) => {
  const [tree, setTree] = useState<WorkspaceTreeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  // Fuzzy filter for the tree. Empty string disables filtering.
  // When non-empty, the visible tree shows only nodes whose name
  // contains the filter (case-insensitive), plus all their ancestors
  // so the structure is preserved.
  const [filter, setFilter] = useState("");

  // === Mutation dialog state =================================================
  //
  // The new-file / new-folder / rename / delete actions each open a
  // dedicated dialog (Dialog for inputs, AlertDialog for confirmations)
  // instead of using window.prompt() / window.confirm(). This matches
  // the workspace-selector.tsx pattern and gives us:
  //   - styled, themeable UI (not the browser's plain JS dialog)
  //   - real form inputs with autofocus + Enter-to-submit
  //   - native focus management (Tab cycles through buttons, Esc cancels)
  //   - portal rendering so the dialog isn't clipped by the sidebar
  //
  // We use discriminated-union state objects so the dialog body can
  // render the right copy based on what's being acted on, and so the
  // close-callback knows what to reset.

  // New file / new folder. Both are "create a thing inside this parent"
  // — the dialog is essentially the same, only the title + the endpoint
  // differ. We use one piece of state for both, with a `kind` field.
  type CreateDialogState = {
    parentRelativePath: string;
    name: string;
    kind: "file" | "folder";
  } | null;
  const [createDialog, setCreateDialog] = useState<CreateDialogState>(null);

  // Rename. We split the source name into `baseName` (no extension) and
  // `ext` (the leading dot, e.g. ".html") so the input is pre-filled
  // with just the editable part. The dialog re-attaches the extension
  // on submit if the user didn't type one. `ext` is empty for folders
  // (no extension concept). The input is pre-selected on focus so the
  // user can immediately type a replacement.
  //
  // Users can still paste a full path (containing a separator) to move
  // the item; in that case the extension rule is bypassed and the
  // typed value is used as-is.
  type RenameDialogState = {
    relativePath: string;
    isDir: boolean;
    baseName: string;
    ext: string;
    name: string;
  } | null;
  const [renameDialog, setRenameDialog] = useState<RenameDialogState>(null);

  // Delete. Confirm-only; we just need the target path and the type so
  // the dialog can render the right warning.
  type DeleteDialogState = {
    relativePath: string;
    name: string;
    isDir: boolean;
  } | null;
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState>(null);

  // Bulk delete. We need a dedicated dialog state (separate from
  // `deleteDialog`) because the design is different — the user is
  // confirming N items at once and we want to render a list of
  // paths in the dialog body so they can see what they're about to
  // lose. The bulk dialog also handles the common pitfall where
  // shift-clicking selects a parent + its children, which would
  // cause parallel DELETEs to fail on the children (the parent
  // delete already removed them). We dedupe before showing the
  // dialog.
  type BulkDeleteDialogState = {
    paths: string[];
    isDirCount: number;
    fileCount: number;
  } | null;
  const [bulkDeleteDialog, setBulkDeleteDialog] = useState<BulkDeleteDialogState>(null);

  // While a mutation request is in flight, we disable the dialog
  // buttons to prevent double-submit. The state is shared across all
  // three dialogs because only one can be open at a time.
  const [mutationBusy, setMutationBusy] = useState(false);

  // === Tier 3 — multi-select, recent files, inline rename ====================
  //
  // These features all share state with the file tree but live in
  // their own effects/handlers below the main tree rendering.

  // Multi-select. The set holds workspace-relative paths. We use a
  // Set for O(1) toggle and lookup. The selection persists across
  // re-renders but is reset whenever the workspace changes.
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  // The "last clicked" path is the anchor for Shift+click range
  // selection. We record it on every click (whether or not the path
  // ends up selected) so the next Shift+click extends from there.
  const [lastClickedPath, setLastClickedPath] = useState<string | null>(null);
  // Clear selection when the workspace changes.
  useEffect(() => {
    setSelectedPaths(new Set());
    setLastClickedPath(null);
  }, [workspaceId]);

  // Recent files. We track the most-recently-opened files per
  // workspace, capped at 10 entries, persisted to localStorage so
  // they survive a page reload. The format is
  //   { [workspaceId: string]: string[] } // most recent first
  // We only persist workspace-relative paths, so opening a different
  // folder on the same workspace merges with the existing list.
  const RECENT_FILES_KEY = "rapa:recentFiles";
  const RECENT_FILES_MAX = 10;
  const [recentPaths, setRecentPaths] = useState<string[]>([]);

  useEffect(() => {
    if (!workspaceId) {
      setRecentPaths([]);
      return;
    }
    try {
      const raw = localStorage.getItem(RECENT_FILES_KEY);
      if (!raw) {
        setRecentPaths([]);
        return;
      }
      const parsed = JSON.parse(raw) as Record<string, string[]>;
      setRecentPaths(parsed[workspaceId] ?? []);
    } catch {
      setRecentPaths([]);
    }
  }, [workspaceId]);

  const recordRecentFile = useCallback(
    (relativePath: string) => {
      if (!workspaceId || !relativePath) return;
      setRecentPaths((prev) => {
        // Move to the front, dedupe, cap at RECENT_FILES_MAX.
        const next = [relativePath, ...prev.filter((p) => p !== relativePath)].slice(0, RECENT_FILES_MAX);
        try {
          const raw = localStorage.getItem(RECENT_FILES_KEY);
          const parsed = (raw ? JSON.parse(raw) : {}) as Record<string, string[]>;
          parsed[workspaceId] = next;
          localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(parsed));
        } catch {
          // localStorage may be unavailable (private mode); silent
          // failure — the in-memory state still works for this
          // session.
        }
        return next;
      });
    },
    [workspaceId]
  );

  // Stat cache for hover tooltips. Keyed by workspace-relative path.
  // Entries expire after 30 seconds to avoid stale data after edits
  // (the tree auto-refreshes, but the cache might outlive it).
  const statCacheRef = useRef<Map<string, { stat: WorkspaceFileStat; fetchedAt: number }>>(new Map());
  const STAT_TTL_MS = 30_000;

  const fetchStat = useCallback(
    async (relativePath: string): Promise<WorkspaceFileStat | null> => {
      if (!workspaceId) return null;
      const cached = statCacheRef.current.get(relativePath);
      if (cached && Date.now() - cached.fetchedAt < STAT_TTL_MS) {
        return cached.stat;
      }
      try {
        const stat = await getWorkspaceFileStat(workspaceId, relativePath);
        statCacheRef.current.set(relativePath, { stat, fetchedAt: Date.now() });
        return stat;
      } catch {
        return null;
      }
    },
    [workspaceId]
  );

  // Invalidate the stat cache when the tree refreshes. Without this,
  // hover tooltips would show stale size/mtime after a mutation.
  useEffect(() => {
    statCacheRef.current.clear();
  }, [tree]);


  const loadTree = useCallback(async (opts?: { preserveExpanded?: boolean }) => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await getWorkspaceTree(workspaceId);
      setTree(data);
      if (opts?.preserveExpanded) {
        // Keep user's current expand state; just add any new root dirs
        setExpandedPaths((prev) => {
          const next = new Set(prev);
          for (const n of data.tree) {
            if (n.type === "directory" && !next.has(n.path)) {
              // Only auto-expand root dirs that weren't previously in the set
              // (preserves collapsed state for dirs the user deliberately closed)
            }
          }
          return prev;
        });
      } else {
        // Initial load / manual refresh — auto-expand root-level directories
        const rootDirs = data.tree
          .filter((n) => n.type === "directory")
          .map((n) => n.path);
        setExpandedPaths(new Set(rootDirs));
      }
    } catch {
      setError("Failed to load workspace files");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (workspaceId) {
      void loadTree();
    }
  }, [workspaceId, loadTree]);

  // Auto-refresh when agent modifies files (dispatched from use-chat-stream)
  useEffect(() => {
    const handler = (e: Event) => {
      if (!workspaceId) return;
      const detail = (e as CustomEvent).detail;
      if (detail?.workspaceId && workspaceId && detail.workspaceId !== workspaceId) return;
      void loadTree({ preserveExpanded: true });
    };
    window.addEventListener("workspace:tree-refresh", handler);
    return () => window.removeEventListener("workspace:tree-refresh", handler);
  }, [workspaceId, loadTree]);

  const handleToggle = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  // === Context-menu / toolbar actions ========================================

  // Recursively collect every directory path under the given node.
  // Used by Expand All so the user can collapse the whole tree to a single
  // node and then explode it back out with one click.
  const collectDirPaths = (node: WorkspaceTreeNode, out: string[]): void => {
    if (node.type === "directory") {
      out.push(node.path);
      if (node.children) for (const c of node.children) collectDirPaths(c, out);
    }
  };

  const handleExpandAll = useCallback((rootPath: string) => {
    if (!tree) return;
    // Walk the tree to find the node matching `rootPath` and collect
    // every directory under it. If the path isn't found (shouldn't
    // happen — context-menu only fires for known nodes) we silently
    // bail out rather than corrupting the expansion state.
    const paths: string[] = [];
    const walk = (nodes: WorkspaceTreeNode[]): boolean => {
      for (const n of nodes) {
        if (n.path === rootPath) {
          collectDirPaths(n, paths);
          return true;
        }
        if (n.children && walk(n.children)) return true;
      }
      return false;
    };
    walk(tree.tree);
    if (paths.length === 0) return;
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      for (const p of paths) next.add(p);
      return next;
    });
  }, [tree]);

  const handleExpandAllRoot = useCallback(() => {
    if (!tree) return;
    const paths: string[] = [];
    for (const root of tree.tree) collectDirPaths(root, paths);
    setExpandedPaths(new Set(paths));
  }, [tree]);

  const handleCollapseAll = useCallback(() => {
    setExpandedPaths(new Set());
  }, []);

  // Copy absolute or workspace-relative path to the clipboard.
  // The `tree.path` is the workspace root; relative paths are emitted as
  // a forward-slash path so they're easy to paste into a terminal or
  // search bar on Windows.
  const handleCopyPath = useCallback(async (path: string, label: "absolute" | "relative") => {
    try {
      await navigator.clipboard.writeText(path);
      toast.success(
        label === "absolute"
          ? "Absolute path copied to clipboard"
          : "Relative path copied to clipboard"
      );
    } catch {
      toast.error("Couldn't access the clipboard");
    }
  }, []);

  // Reveal in native file explorer. We do this via a small backend endpoint
  // (POST /api/workspaces/:id/reveal) that calls the OS shell command
  // appropriate for the host. Sending the path through the server (rather
  // than opening file:// from the browser) keeps the workspace-isolation
  // guard in one place and avoids cross-browser limitations on
  // window.open(file://).
  //
  // The path passed in is the workspace-relative path (e.g. "src/lib/api.ts")
  // — the same format the existing /file and /tree endpoints accept. The
  // server resolves it to an absolute path inside isWithinWorkspaceSymlinkSafe
  // before spawning the OS shell command, so the browser never has to know
  // the absolute location on disk.
  const handleReveal = useCallback(async (relativePath: string) => {
    if (!workspaceId) return;
    const token = localStorage.getItem("auth_token");
    try {
      const res = await fetch(
        `${API_BASE}/workspaces/${encodeURIComponent(workspaceId)}/reveal`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {})
          },
          body: JSON.stringify({ path: relativePath })
        }
      );
      if (!res.ok) {
        const detail = await res.json().catch(() => ({ message: "Reveal failed" }));
        throw new Error(detail.message || "Reveal failed");
      }
      toast.success("Opened in file explorer");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reveal failed");
    }
  }, [workspaceId]);

  // Open the workspace terminal tab, optionally focused on a subfolder.
  // The terminal panel lives outside the right sidebar (in routes.tsx), so
  // we use a custom DOM event to bridge the gap. The Layout component
  // listens for this event and calls its existing handleOpenTerminal().
  // The `cwd` we send is the workspace-relative path (or "." for the
  // workspace root), which the server validates and uses as the
  // starting directory of the PTY session.
  const handleOpenInTerminal = useCallback((relativePath: string) => {
    window.dispatchEvent(
      new CustomEvent("workspace:open-terminal", { detail: { cwd: relativePath } })
    );
  }, []);

  // Search-in-folder stub. The actual search UI lives in the global search
  // palette (Ctrl+K). We prefill the search query with a path-scoped
  // fragment so the user lands in the right context.
  const handleSearchInFolder = useCallback((path: string) => {
    window.dispatchEvent(
      new CustomEvent("workspace:search-in", { detail: { path } })
    );
    toast.message("Tip: use Ctrl+K to open the global search");
  }, []);

  // Workspace-root shortcuts (right-click the header). The path used here
  // is the workspace root returned by the server.
  const onCopyPathRoot = useCallback(
    (rootPath: string, label: "absolute" | "relative") => {
      void handleCopyPath(rootPath, label);
    },
    [handleCopyPath]
  );

  const onRevealRoot = useCallback(() => {
    // Workspace root: pass "." so the server resolves it to the
    // workspace root via resolveWorkspacePath(".", workspace.path).
    // Sending tree.path (absolute) would be rejected by the
    // containsPathTraversal guard, so we use the relative form.
    if (tree?.path) void handleReveal(".");
  }, [handleReveal, tree]);

  // === Tier 2 — file mutations ===============================================
  //
  // These are thin wrappers around the new REST endpoints in
  // server/src/routes/workspaces.ts. They share the auth helper used
  // by handleReveal so the request shape is consistent.
  //
  // The dialog-based mutations (new file, new folder, rename, delete)
  // follow this pattern:
  //   1. handleXxxAction() — opens the dialog by setting state.
  //   2. submitXxx()       — performs the network call, closes the
  //                          dialog on success, surfaces errors as
  //                          toasts without closing (so the user can
  //                          correct the input).
  // The dialogs themselves are rendered near the end of the JSX tree.
  const authedFetch = useCallback(
    async (path: string, init: RequestInit): Promise<Response> => {
      const token = localStorage.getItem("auth_token");
      return fetch(`${API_BASE}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(init.headers ?? {})
        }
      });
    },
    []
  );

  // Reload the tree after any mutation so the new state is reflected.
  // We pass preserveExpanded:true so the user's expand/collapse state
  // is kept across the refresh — much nicer UX than collapsing
  // everything on every action.
  const refreshAfterMutation = useCallback(() => {
    void loadTree({ preserveExpanded: true });
  }, [loadTree]);

  // Compute the path for a new file/folder inside a parent directory.
  // - For files, append the user-supplied name to the parent path.
  // - For folders, same.
  // - The "." case means "workspace root"; we strip it.
  function joinParentChild(parent: string, child: string): string {
    if (parent === "." || parent === "") return child;
    return `${parent.replace(/[\\/]+$/, "")}/${child}`;
  }

  // Strip the basename from a path to get the parent. We avoid importing
  // node:path (not available in the browser bundle) by computing it
  // manually. Handles both / and \ separators. If the path has no
  // separator, returns "" (signaling "workspace root" to joinParentChild).
  function dirnameOf(p: string): string {
    const lastSep = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return lastSep >= 0 ? p.slice(0, lastSep) : "";
  }

  // Openers — called from the context menu. These only set state;
  // submitXxx() does the actual network call.
  const handleNewFile = useCallback(
    (parentRelativePath: string) => {
      if (!workspaceId) return;
      setCreateDialog({ parentRelativePath, name: "", kind: "file" });
    },
    [workspaceId]
  );

  const handleNewFolder = useCallback(
    (parentRelativePath: string) => {
      if (!workspaceId) return;
      setCreateDialog({ parentRelativePath, name: "", kind: "folder" });
    },
    [workspaceId]
  );

  // Note: the right-click "Rename…" menu no longer opens a dialog
  // — it triggers the inline editor (handleRenameInline below).
  // The RenameDialogState / submitRename code below is kept for
  // future use (e.g. a dedicated "rename from command palette"
  // entry point), but is no longer wired to the right-click menu.

  const handleDelete = useCallback(
    (relativePath: string, isDir: boolean) => {
      if (!workspaceId) return;
      const name = relativePath.split(/[\\/]+/).pop() ?? "";
      setDeleteDialog({ relativePath, name, isDir });
    },
    [workspaceId]
  );

  // Submitters — called from the dialog buttons. Each one runs the
  // mutation and either closes the dialog (success) or shows an error
  // toast without closing (failure, so the user can retry).

  // Create a new file OR folder. We dispatch on the dialog's `kind` to
  // hit the right endpoint. Validation is the same in both cases: the
  // name must be a basename (no separators, no `..`).
  const submitCreate = useCallback(async () => {
    if (!workspaceId || !createDialog) return;
    const name = createDialog.name.trim();
    if (!name) {
      toast.error("Name is required");
      return;
    }
    if (name.includes("/") || name.includes("\\") || name.includes("..")) {
      toast.error("Name can't contain path separators or '..'");
      return;
    }
    const fullPath = joinParentChild(createDialog.parentRelativePath, name);
    setMutationBusy(true);
    try {
      const endpoint = createDialog.kind === "file" ? "file" : "folder";
      const body = createDialog.kind === "file"
        ? { path: fullPath, content: "" }
        : { path: fullPath };
      const res = await authedFetch(
        `/workspaces/${encodeURIComponent(workspaceId)}/${endpoint}`,
        { method: "POST", body: JSON.stringify(body) }
      );
      if (!res.ok) {
        const detail = await res.json().catch(() => ({ message: "Create failed" }));
        throw new Error(detail.message || "Create failed");
      }
      toast.success(`Created ${name}`);
      setCreateDialog(null);
      refreshAfterMutation();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Create failed");
    } finally {
      setMutationBusy(false);
    }
  }, [workspaceId, createDialog, authedFetch, refreshAfterMutation]);

  // Rename. We accept either a basename (rename in place) or a full
  // path (move + rename). The server treats `to` as a full workspace-
  // relative path either way.
  //
  // For files: the input only contains the base name (no extension).
  // The extension rule is applied to the *basename* part of the input:
  //   - if the typed basename already has a "." (i.e. the user typed
  //     a new extension), we use it as-is
  //   - if not, we re-attach the original extension
  // This applies whether the user typed a full path or just a basename,
  // so "src/pages/home" with ext=".html" becomes "src/pages/home.html".
  //
  // For folders: the extension rule doesn't apply.
  const submitRename = useCallback(async () => {
    if (!workspaceId || !renameDialog) return;
    const input = renameDialog.name.trim();
    if (!input) {
      toast.error("Name is required");
      return;
    }

    // Apply the extension rule to the *last* segment of the input,
    // which is the basename. The directory parts (if any) pass through
    // unchanged.
    const hasSeparator = input.includes("/") || input.includes("\\");
    let resolvedPath: string;
    let resolvedName: string;
    if (hasSeparator) {
      const lastSep = Math.max(input.lastIndexOf("/"), input.lastIndexOf("\\"));
      const dirPart = input.slice(0, lastSep);
      const basePart = input.slice(lastSep + 1);
      const basePartWithExt =
        !renameDialog.isDir && renameDialog.ext && !basePart.includes(".")
          ? `${basePart}${renameDialog.ext}`
          : basePart;
      resolvedPath = `${dirPart}/${basePartWithExt}`;
      resolvedName = basePartWithExt;
    } else {
      // Rename in place: parent stays the same, only the basename
      // changes (with extension re-attached if needed).
      const basePartWithExt =
        !renameDialog.isDir && renameDialog.ext && !input.includes(".")
          ? `${input}${renameDialog.ext}`
          : input;
      resolvedPath = joinParentChild(dirnameOf(renameDialog.relativePath), basePartWithExt);
      resolvedName = basePartWithExt;
    }

    if (resolvedPath === renameDialog.relativePath) {
      // No change — close without making a request.
      setRenameDialog(null);
      return;
    }

    setMutationBusy(true);
    try {
      const res = await authedFetch(
        `/workspaces/${encodeURIComponent(workspaceId)}/path`,
        { method: "PATCH", body: JSON.stringify({ from: renameDialog.relativePath, to: resolvedPath }) }
      );
      if (!res.ok) {
        const detail = await res.json().catch(() => ({ message: "Rename failed" }));
        throw new Error(detail.message || "Rename failed");
      }
      toast.success(`Renamed to ${resolvedName}`);
      setRenameDialog(null);
      refreshAfterMutation();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Rename failed");
    } finally {
      setMutationBusy(false);
    }
  }, [workspaceId, renameDialog, authedFetch, refreshAfterMutation]);

  // Delete. Always a single confirmation, no input needed.
  const submitDelete = useCallback(async () => {
    if (!workspaceId || !deleteDialog) return;
    setMutationBusy(true);
    try {
      const res = await authedFetch(
        `/workspaces/${encodeURIComponent(workspaceId)}/path?path=${encodeURIComponent(deleteDialog.relativePath)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const detail = await res.json().catch(() => ({ message: "Delete failed" }));
        throw new Error(detail.message || "Delete failed");
      }
      toast.success(`Deleted ${deleteDialog.name}`);
      setDeleteDialog(null);
      refreshAfterMutation();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setMutationBusy(false);
    }
  }, [workspaceId, deleteDialog, authedFetch, refreshAfterMutation]);

  // === Tier 3 handlers =======================================================

  // Multi-select click handler. The TreeNode calls this on every
  // left-click. We interpret the modifier keys:
  //   - Ctrl/Cmd+click: toggle the path in the selection set
  //   - Shift+click: select the range from the last-clicked path to
  //     this one (in display order, flattened)
  //   - Plain click: clear selection and select just this path
  // We also update lastClickedPath so the next Shift+click has an
  // anchor.
  const handleTreeSelect = useCallback(
    (relativePath: string, modifiers: { ctrl: boolean; shift: boolean }) => {
      setLastClickedPath(relativePath);
      if (modifiers.ctrl) {
        setSelectedPaths((prev) => {
          const next = new Set(prev);
          if (next.has(relativePath)) next.delete(relativePath);
          else next.add(relativePath);
          return next;
        });
        return;
      }
      if (modifiers.shift && lastClickedPath && lastClickedPath !== relativePath) {
        // Range selection: pick the flattened path list from the
        // raw tree (filter is applied to the visible tree later; we
        // use the unfiltered list because it's cheaper to compute
        // and the user is most likely extending a recent selection
        // that already represents what they see). If a row is
        // hidden by the filter, it's simply skipped in the slice.
        const rawTree = tree?.tree ?? [];
        const flatPaths = flattenPaths(rawTree);
        const startIdx = flatPaths.indexOf(lastClickedPath);
        const endIdx = flatPaths.indexOf(relativePath);
        if (startIdx >= 0 && endIdx >= 0) {
          const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
          const range = flatPaths.slice(lo, hi + 1);
          setSelectedPaths(new Set(range));
          return;
        }
      }
      // Plain click — single-row selection.
      setSelectedPaths(new Set([relativePath]));
    },
    [tree, lastClickedPath]
  );

  // When the user opens a file (clicks, presses Enter, or via the
  // viewer button), record it as a recent file so it appears in
  // the "Recent" section at the top of the tree.
  const handleFileOpen = useCallback(
    (relativePath: string) => {
      setSelectedFile(relativePath);
      recordRecentFile(relativePath);
    },
    [recordRecentFile]
  );

  // When the user clicks the bulk-Delete button, we open the
  // confirmation dialog. The actual delete happens in
  // `submitBulkDelete` once they confirm.
  const handleBulkDelete = useCallback(() => {
    if (!workspaceId) return;
    if (selectedPaths.size === 0) return;
    const deduped = dedupePathsByAncestor(Array.from(selectedPaths));
    // We need to know how many of the deduped paths are directories
    // so the dialog can show a folder/file breakdown. Walk the
    // current tree once and build a Set of directory paths.
    const dirSet = new Set<string>();
    const collectDirs = (nodes: WorkspaceTreeNode[]) => {
      for (const n of nodes) {
        if (n.type === "directory") dirSet.add(n.relativePath);
        if (n.children) collectDirs(n.children);
      }
    };
    if (tree?.tree) collectDirs(tree.tree);

    let dirCount = 0;
    for (const p of deduped) if (dirSet.has(p)) dirCount += 1;
    setBulkDeleteDialog({
      paths: deduped.sort(),
      isDirCount: dirCount,
      fileCount: deduped.length - dirCount
    });
  }, [workspaceId, selectedPaths, tree]);

  // Confirm-and-execute the bulk delete. We dedupe again on the way
  // in (in case the selection changed between opening and confirming
  // the dialog — the dialog blocks the UI but the state setter is
  // not synchronous so we re-read).
  const submitBulkDelete = useCallback(async () => {
    if (!workspaceId || !bulkDeleteDialog) return;
    const paths = bulkDeleteDialog.paths;
    if (paths.length === 0) {
      setBulkDeleteDialog(null);
      return;
    }
    setMutationBusy(true);
    try {
      const results = await Promise.allSettled(
        paths.map((p) =>
          authedFetch(
            `/workspaces/${encodeURIComponent(workspaceId)}/path?path=${encodeURIComponent(p)}`,
            { method: "DELETE" }
          )
        )
      );
      const failed = results.filter(
        (r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok)
      );
      if (failed.length === 0) {
        toast.success(`Deleted ${paths.length} item${paths.length === 1 ? "" : "s"}`);
      } else if (failed.length === paths.length) {
        toast.error(`Couldn't delete any of the ${paths.length} items`);
      } else {
        toast.error(
          `${paths.length - failed.length} deleted, ${failed.length} failed — check the file tree for what remains.`
        );
      }
      setSelectedPaths(new Set());
      setBulkDeleteDialog(null);
      refreshAfterMutation();
    } finally {
      setMutationBusy(false);
    }
  }, [workspaceId, bulkDeleteDialog, authedFetch, refreshAfterMutation]);

  // Copy all selected paths (relative) to the clipboard, one per
  // line. Useful for grep / xargs workflows.
  const handleBulkCopyPaths = useCallback(async () => {
    if (selectedPaths.size === 0) return;
    const text = Array.from(selectedPaths).sort().join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`Copied ${selectedPaths.size} path(s) to clipboard`);
    } catch {
      toast.error("Couldn't access the clipboard");
    }
  }, [selectedPaths]);

  // Clear the multi-select set (Esc also does this — see the global
  // keydown handler below).
  const clearSelection = useCallback(() => {
    setSelectedPaths(new Set());
    setLastClickedPath(null);
  }, []);

  // Global keyboard shortcuts that act on the multi-select set:
  //   - Esc:    clear the selection
  //   - Delete: open the bulk-delete confirmation dialog
  // We listen on window so it works regardless of which tree row
  // currently has focus. We skip when the focus is in an input or
  // textarea so inline rename + other inputs aren't hijacked.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (selectedPaths.size === 0) return;
      const target = e.target as HTMLElement | null;
      const inEditableField = target && (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      );
      if (inEditableField) return;
      // Skip if a Radix dialog is open (the dialog itself handles
      // its own keyboard).
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;

      if (e.key === "Escape") {
        e.preventDefault();
        clearSelection();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        handleBulkDelete();
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedPaths.size, clearSelection, handleBulkDelete]);

  // === Cross-component bus =================================================
  // Tier 4 — listen for `workspace:open-file` events dispatched by
  // the Go-to-file and Find-in-files palettes. The detail is the
  // workspace-relative path. We honor it even if the file isn't
  // currently visible in the tree (the viewer can still open it
  // by its path).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { path?: string } | undefined;
      const path = detail?.path;
      if (!path) return;
      handleFileOpen(path);
    };
    window.addEventListener("workspace:open-file", handler);
    return () => window.removeEventListener("workspace:open-file", handler);
  }, [handleFileOpen]);

  // === Inline rename state ==================================================
  // When the user double-clicks or presses F2, we set this state to
  // point at the target node. The TreeNode checks the value and
  // renders an Input instead of a button. On commit (Enter / blur),
  // the parent submits to the rename endpoint and clears the state.
  const [inlineRename, setInlineRename] = useState<InlineRenameState | null>(null);

  // Open the inline-rename editor for a path. Splits the name into
  // base + ext the same way handleRename does, so the input never
  // shows the extension.
  const openInlineRename = useCallback(
    (relativePath: string, isDir: boolean) => {
      const fullName = relativePath.split(/[\\/]+/).pop() ?? "";
      let baseName = fullName;
      let ext = "";
      if (!isDir) {
        const dotIndex = fullName.lastIndexOf(".");
        if (dotIndex > 0 && fullName.length - dotIndex <= 11) {
          baseName = fullName.slice(0, dotIndex);
          ext = fullName.slice(dotIndex);
        }
      }
      setInlineRename({ relativePath, baseName, ext, value: baseName });
    },
    []
  );

  // Wire handleRename (used by the right-click "Rename…" menu) to
  // also open the inline editor. We do this here so the dialog
  // button and the inline shortcut use the same UI.
  const handleRenameInline = useCallback(
    (relativePath: string, isDir: boolean) => {
      // The right-click menu's "Rename…" used to open a dialog. Now
      // we open the inline editor instead — it's faster and matches
      // the double-click / F2 entry points. The dialog is still
      // available for future use if needed.
      openInlineRename(relativePath, isDir);
    },
    [openInlineRename]
  );

  const commitInlineRename = useCallback(async () => {
    if (!workspaceId || !inlineRename) return;
    const input = inlineRename.value.trim();
    if (!input) {
      // Empty name — cancel the rename rather than try to delete.
      setInlineRename(null);
      return;
    }
    const hasSeparator = input.includes("/") || input.includes("\\");
    const userTypedExt = input.includes(".");
    const finalName =
      hasSeparator
        ? input.split(/[\\/]+/).filter(Boolean).pop() ?? input
        : !inlineRename.ext || userTypedExt
          ? input
          : `${input}${inlineRename.ext}`;

    let resolvedPath: string;
    if (hasSeparator) {
      const lastSep = Math.max(input.lastIndexOf("/"), input.lastIndexOf("\\"));
      const dirPart = input.slice(0, lastSep);
      const basePart = input.slice(lastSep + 1);
      const basePartWithExt =
        !inlineRename.ext || basePart.includes(".")
          ? basePart
          : `${basePart}${inlineRename.ext}`;
      resolvedPath = dirPart ? `${dirPart}/${basePartWithExt}` : basePartWithExt;
    } else {
      resolvedPath = joinParentChild(
        inlineRename.relativePath.replace(/[\\/][^\\/]*$/, ""),
        finalName
      );
    }

    if (resolvedPath === inlineRename.relativePath) {
      setInlineRename(null);
      return;
    }

    setMutationBusy(true);
    try {
      const res = await authedFetch(
        `/workspaces/${encodeURIComponent(workspaceId)}/path`,
        { method: "PATCH", body: JSON.stringify({ from: inlineRename.relativePath, to: resolvedPath }) }
      );
      if (!res.ok) {
        const detail = await res.json().catch(() => ({ message: "Rename failed" }));
        throw new Error(detail.message || "Rename failed");
      }
      toast.success(`Renamed to ${finalName}`);
      setInlineRename(null);
      refreshAfterMutation();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Rename failed");
    } finally {
      setMutationBusy(false);
    }
  }, [workspaceId, inlineRename, authedFetch, refreshAfterMutation]);

  const cancelInlineRename = useCallback(() => {
    setInlineRename(null);
  }, []);

  // Duplicate. Server picks a free name following VS Code's " (copy)"
  // convention. We refresh the tree so the new entry appears.
  const handleDuplicate = useCallback(
    async (relativePath: string) => {
      if (!workspaceId) return;
      try {
        const res = await authedFetch(
          `/workspaces/${encodeURIComponent(workspaceId)}/duplicate`,
          { method: "POST", body: JSON.stringify({ path: relativePath }) }
        );
        if (!res.ok) {
          const detail = await res.json().catch(() => ({ message: "Duplicate failed" }));
          throw new Error(detail.message || "Duplicate failed");
        }
        const body = (await res.json()) as { newPath?: string };
        const newName = body.newPath?.split(/[\\/]+/).pop() ?? "file";
        toast.success(`Duplicated as ${newName}`);
        refreshAfterMutation();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Duplicate failed");
      }
    },
    [workspaceId, authedFetch, refreshAfterMutation]
  );

  // Download. We can't fetch() the file and trigger a download
  // simultaneously with a custom filename, so we use a programmatic
  // anchor click with a download attribute. Setting href to the
  // /raw endpoint lets the browser do the heavy lifting (and shows
  // its own progress UI for large files).
  const handleDownload = useCallback(
    (relativePath: string) => {
      if (!workspaceId) return;
      const url = `${API_BASE}/workspaces/${encodeURIComponent(workspaceId)}/raw?path=${encodeURIComponent(relativePath)}`;
      const a = document.createElement("a");
      a.href = url;
      a.download = relativePath.split(/[\\/]+/).pop() ?? "download";
      // Some browsers require the anchor to be in the DOM to click it.
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    },
    [workspaceId]
  );

  // === End actions ===========================================================

  // Filter the tree. When the user has typed a non-empty filter, we
  // include only nodes whose name matches (case-insensitive) AND all of
  // their ancestors, so the matched file is still navigable in context.
  const filteredTree = useMemo(() => {
    if (!tree) return [];
    const baseTree = filterTree(tree.tree);
    const q = filter.trim().toLowerCase();
    if (!q) return baseTree;

    // Mark every node that's a match OR has a matching descendant.
    // We recurse and rebuild the subtree with only matching subtrees.
    function prune(nodes: WorkspaceTreeNode[]): WorkspaceTreeNode[] {
      const out: WorkspaceTreeNode[] = [];
      for (const n of nodes) {
        const selfMatch = n.name.toLowerCase().includes(q);
        const childPruned = n.children ? prune(n.children) : undefined;
        const hasMatchingDescendant = (childPruned?.length ?? 0) > 0;
        if (selfMatch || hasMatchingDescendant) {
          out.push({ ...n, children: childPruned });
        }
      }
      return out;
    }
    return prune(baseTree);
  }, [tree, filter]);

  // When the user starts filtering, auto-expand every directory in the
  // filtered tree so matches are immediately visible. When the filter
  // clears, fall back to whatever the user had expanded before.
  useEffect(() => {
    if (!filter.trim()) return;
    const paths: string[] = [];
    function walk(nodes: WorkspaceTreeNode[]): void {
      for (const n of nodes) {
        if (n.type === "directory") {
          paths.push(n.path);
          if (n.children) walk(n.children);
        }
      }
    }
    walk(filteredTree);
    setExpandedPaths(new Set(paths));
  }, [filter, filteredTree]);

  // Count visible files and dirs
  const countNodes = (nodes: WorkspaceTreeNode[]): { files: number; dirs: number } => {
    let files = 0;
    let dirs = 0;
    for (const node of nodes) {
      if (node.type === "directory") {
        dirs++;
        if (node.children) {
          const child = countNodes(node.children);
          files += child.files;
          dirs += child.dirs;
        }
      } else {
        files++;
      }
    }
    return { files, dirs };
  };

  const counts = countNodes(filteredTree);

  return (
    <>
      {/* Sub-header with workspace info + toolbar (refresh, expand/collapse, filter) */}
      <div className="border-b border-border/30 px-3 py-2 space-y-1.5">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="flex items-center justify-between">
              <div className="min-w-0 flex-1">
                <span className="truncate font-mono-tech text-[10px] text-muted-foreground/70 block">
                  {workspaceName ?? tree?.name ?? "Workspace"}
                </span>
                <span className="font-mono-tech text-[9px] text-muted-foreground/40">
                  {counts.dirs} dirs, {counts.files} files
                </span>
              </div>
              <div className="flex items-center gap-0.5 shrink-0 ml-2">
                <button
                  onClick={handleExpandAllRoot}
                  disabled={!tree || counts.dirs === 0}
                  className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                  title="Expand all"
                  type="button"
                >
                  <Maximize2 size={11} />
                </button>
                <button
                  onClick={handleCollapseAll}
                  disabled={expandedPaths.size === 0}
                  className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                  title="Collapse all"
                  type="button"
                >
                  <Minimize2 size={11} />
                </button>
                <button
                  onClick={() => { void loadTree(); }}
                  disabled={loading}
                  className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                  title="Refresh"
                  type="button"
                >
                  <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
                </button>
              </div>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-56">
            {tree && (
              <ContextMenuItem
                onSelect={() => onCopyPathRoot(tree.path, "absolute")}
                className="font-mono-tech text-[11px]"
              >
                <LinkIcon size={12} />
                Copy workspace path
              </ContextMenuItem>
            )}
            <ContextMenuItem
              onSelect={() => onRevealRoot()}
              disabled={!tree}
              className="font-mono-tech text-[11px]"
            >
              <ExternalLink size={12} />
              Reveal workspace in file explorer
            </ContextMenuItem>
            <ContextMenuSeparator />
            {/* Tier 2 — top-level file/folder creation. The path "." means
                the workspace root, which the server resolves to the
                actual root via resolveWorkspacePath(".", workspace.path). */}
            <ContextMenuItem
              onSelect={() => handleNewFile(".")}
              disabled={!workspaceId}
              className="font-mono-tech text-[11px]"
            >
              <FilePlus size={12} />
              New file…
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => handleNewFolder(".")}
              disabled={!workspaceId}
              className="font-mono-tech text-[11px]"
            >
              <FolderPlus size={12} />
              New folder…
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={handleExpandAllRoot}
              disabled={!tree || counts.dirs === 0}
              className="font-mono-tech text-[11px]"
            >
              <Maximize2 size={12} />
              Expand all
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={handleCollapseAll}
              disabled={expandedPaths.size === 0}
              className="font-mono-tech text-[11px]"
            >
              <Minimize2 size={12} />
              Collapse all
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        {/* Filter input — fuzzy matches file/dir names. Right-click the
            header above for workspace-level actions. */}
        <div className="relative">
          <SearchIcon
            size={11}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/50"
          />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files…"
            className="w-full rounded border border-border/40 bg-card-3/40 py-1 pl-7 pr-6 font-mono-tech text-[10px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-ring"
            spellCheck={false}
            autoComplete="off"
          />
          {filter && (
            <button
              onClick={() => setFilter("")}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
              title="Clear filter"
              type="button"
            >
              <X size={10} />
            </button>
          )}
        </div>

        {/* Bulk action toolbar — visible when at least one row is in
            the multi-select set. Shows the count + a few high-value
            actions. We avoid cramming every action in here because the
            right-click menu already provides per-item access to the
            same operations. */}
        {selectedPaths.size > 0 && (
          <div className="flex items-center gap-1 border-t border-border/30 bg-accent/10 px-2 py-1">
            <span className="font-mono-tech text-[10px] font-semibold text-foreground/80">
              {selectedPaths.size} selected
            </span>
            <button
              type="button"
              onClick={() => void handleBulkCopyPaths()}
              className="ml-auto inline-flex h-6 items-center gap-1 rounded px-2 font-mono-tech text-[10px] text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground"
              title="Copy all selected paths"
            >
              <Copy size={11} />
              Copy paths
            </button>
            <button
              type="button"
              onClick={() => void handleBulkDelete()}
              disabled={mutationBusy}
              className="inline-flex h-6 items-center gap-1 rounded px-2 font-mono-tech text-[10px] text-accent-red transition-colors hover:bg-accent-red/20 disabled:opacity-50"
              title="Delete all selected"
            >
              <Trash2 size={11} />
              Delete
            </button>
            <button
              type="button"
              onClick={clearSelection}
              className="inline-flex h-6 items-center gap-1 rounded px-1.5 font-mono-tech text-[10px] text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground"
              title="Clear selection (Esc)"
            >
              <X size={11} />
            </button>
          </div>
        )}
      </div>

      {/* Tree content */}
      <div className="flex-1 min-h-0 overflow-y-auto py-1 sidebar-scroll">
        {/* === Recent files section (Tier 3) =============================
            Shows the most-recently-opened files at the top of the
            tree. Hidden if there are no recents, or while a filter
            is active (so the recents don't pollute the filtered view).
            Each recent has a small close-button to remove it from
            the list, and clicking the path opens the file. */}
        {!filter && recentPaths.length > 0 && (
          <div className="border-b border-border/30 px-2 py-1.5">
            <div className="flex items-center gap-1.5 px-1 pb-1">
              <Clock size={10} className="text-muted-foreground/60" />
              <span className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
                Recent
              </span>
              <button
                type="button"
                onClick={() => {
                  if (!workspaceId) return;
                  setRecentPaths([]);
                  try {
                    const raw = localStorage.getItem(RECENT_FILES_KEY);
                    const parsed = (raw ? JSON.parse(raw) : {}) as Record<string, string[]>;
                    delete parsed[workspaceId];
                    localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(parsed));
                  } catch {
                    // ignore
                  }
                }}
                className="ml-auto font-mono-tech text-[9px] text-muted-foreground/60 transition-colors hover:text-foreground"
                title="Clear all recent files"
              >
                clear
              </button>
            </div>
            <ul className="space-y-0.5">
              {recentPaths.map((recentPath) => {
                const name = recentPath.split(/[\\/]+/).pop() ?? recentPath;
                return (
                  <li key={recentPath} className="group flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleFileOpen(recentPath)}
                      className="flex flex-1 min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-left font-mono-tech text-[11px] text-foreground/80 transition-colors hover:bg-accent/20"
                      title={recentPath}
                    >
                      <File size={10} className={cn("shrink-0", getFileColor(name))} />
                      <span className="truncate">{name}</span>
                      <span className="truncate text-[10px] text-muted-foreground/60">· {recentPath}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRecentPaths((prev) => prev.filter((p: string) => p !== recentPath));
                        if (!workspaceId) return;
                        try {
                          const raw = localStorage.getItem(RECENT_FILES_KEY);
                          const parsed = (raw ? JSON.parse(raw) : {}) as Record<string, string[]>;
                          const list = parsed[workspaceId];
                          if (list) {
                            parsed[workspaceId] = list.filter((p: string) => p !== recentPath);
                            localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(parsed));
                          }
                        } catch {
                          // ignore
                        }
                      }}
                      className="rounded p-0.5 text-muted-foreground/40 opacity-0 transition-all hover:bg-accent/30 hover:text-foreground group-hover:opacity-100"
                      title="Remove from recents"
                    >
                      <X size={10} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {loading && !tree && (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={18} className="animate-spin text-muted-foreground/40" />
          </div>
        )}

        {error && (
          <div className="px-4 py-6 text-center">
            <p className="font-mono-tech text-[11px] text-accent-red/70">{error}</p>
            <button
              onClick={() => { void loadTree(); }}
              className="mt-2 rounded border border-border/40 px-3 py-1 font-mono-tech text-[10px] text-muted-foreground transition-colors hover:bg-accent/30"
              type="button"
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && filteredTree.length === 0 && (
          <div className="px-4 py-8 text-center">
            <p className="font-mono-tech text-[11px] text-muted-foreground/60">
              {filter
                ? `No files match "${filter}"`
                : workspaceId
                  ? "Workspace is empty"
                  : "No workspace selected"}
            </p>
          </div>
        )}

        {filteredTree.map((node) => (
          <TreeNode
            key={node.path}
            node={node}
            depth={0}
            expandedPaths={expandedPaths}
            onToggle={handleToggle}
            onFileClick={handleFileOpen}
            onExpandAll={handleExpandAll}
            onCopyPath={handleCopyPath}
            onReveal={handleReveal}
            onOpenInTerminal={handleOpenInTerminal}
            onSearchInFolder={handleSearchInFolder}
            onNewFile={handleNewFile}
            onNewFolder={handleNewFolder}
            onRename={handleRenameInline}
            onDelete={handleDelete}
            onDuplicate={handleDuplicate}
            onDownload={handleDownload}
            onSelect={handleTreeSelect}
            isSelected={selectedPaths.has(node.relativePath)}
            inlineRenameState={inlineRename}
            onInlineRenameChange={(v) => setInlineRename(inlineRename ? { ...inlineRename, value: v } : null)}
            onInlineRenameCommit={() => void commitInlineRename()}
            onInlineRenameCancel={cancelInlineRename}
            fetchStat={fetchStat}
          />
        ))}
      </div>

      {/* Footer */}
      <div className="border-t border-border/30 px-4 py-2">
        <span className="font-mono-tech text-[9px] text-muted-foreground/40">
          {tree?.path ?? ""}
        </span>
      </div>

      {/* File viewer dialog */}
      {workspaceId && selectedFile && (
        <FileViewerDialog
          open={!!selectedFile}
          onOpenChange={(open) => { if (!open) setSelectedFile(null); }}
          workspaceId={workspaceId}
          filePath={selectedFile}
        />
      )}

      {/* === Mutation dialogs ================================================
          All three dialogs follow the same pattern as workspace-selector.tsx:
          - Dialog (Radix) for inputs, AlertDialog for confirmations
          - Header with title + description, body with form fields
            (or just description for AlertDialog), footer with Cancel + primary action
          - Pressing Escape or clicking the overlay closes without
            saving (the state setters do nothing on close).
          - The submitter (submitCreate / submitRename / submitDelete) is
            responsible for the network call; the dialogs are pure
            presentation.
      */}

      {/* New file / new folder dialog. One dialog for both kinds, with
          the title + endpoint switching based on `kind`. The Input
          auto-focuses on open so the user can type immediately. */}
      <Dialog
        open={createDialog !== null}
        onOpenChange={(open) => { if (!open && !mutationBusy) setCreateDialog(null); }}
      >
        <DialogContent className="border-border bg-card text-foreground sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle className="text-[18px] font-semibold text-foreground">
              {createDialog?.kind === "folder" ? "New folder" : "New file"}
            </DialogTitle>
            <DialogDescription className="text-[13px] text-muted-foreground">
              {createDialog?.kind === "folder"
                ? "Creates an empty folder at the chosen location inside this workspace."
                : "Creates an empty file at the chosen location inside this workspace."}
            </DialogDescription>
          </DialogHeader>

          {createDialog && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submitCreate();
              }}
              className="space-y-3"
            >
              <div className="space-y-1.5">
                <Label htmlFor="create-name" className="text-[13px] font-medium text-foreground">
                  Name
                </Label>
                <Input
                  id="create-name"
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={createDialog.kind === "folder" ? "src/components" : "notes.md"}
                  value={createDialog.name}
                  onChange={(e) =>
                    setCreateDialog({ ...createDialog, name: e.target.value })
                  }
                  disabled={mutationBusy}
                  className="h-10 border-card-hover bg-card text-primary placeholder:text-muted-foreground"
                />
                {createDialog.parentRelativePath && createDialog.parentRelativePath !== "." && (
                  <p className="font-mono-tech text-[10px] text-muted-foreground/70">
                    Inside: {createDialog.parentRelativePath}
                  </p>
                )}
              </div>

              <DialogFooter className="pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setCreateDialog(null)}
                  disabled={mutationBusy}
                  className="px-4 py-2 h-auto text-muted-foreground hover:text-primary"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={mutationBusy || !createDialog.name.trim()}
                  className="rounded-full bg-primary text-app hover:opacity-90 px-5 py-2 h-auto"
                >
                  {mutationBusy
                    ? "Creating…"
                    : createDialog.kind === "folder"
                      ? "Create folder"
                      : "Create file"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* Rename dialog. The Input is pre-filled with the existing name
          and the entire text is selected on focus so the user can
          immediately type a replacement. Submitting the form (Enter)
          calls submitRename; Esc closes. */}
      <Dialog
        open={renameDialog !== null}
        onOpenChange={(open) => { if (!open && !mutationBusy) setRenameDialog(null); }}
      >
        <DialogContent className="border-border bg-card text-foreground sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle className="text-[18px] font-semibold text-foreground">
              Rename {renameDialog?.isDir ? "folder" : "file"}
            </DialogTitle>
            <DialogDescription className="text-[13px] text-muted-foreground">
              Type a new name. You can also paste a full path to move the
              item to a different location in one step.
            </DialogDescription>
          </DialogHeader>

          {renameDialog && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submitRename();
              }}
              className="space-y-3"
            >
              <div className="space-y-1.5">
                <Label htmlFor="rename-input" className="text-[13px] font-medium text-foreground">
                  {renameDialog.isDir ? "New name or path" : "New name"}
                </Label>

                {/* For files, the input only contains the base name
                    (no extension). The extension is rendered as a
                    static suffix on the right of the input so the
                    user can see what's there, but they don't need to
                    type it (and re-typing it would change the file's
                    extension). For folders, no suffix is shown. */}
                {!renameDialog.isDir ? (
                  <div className="relative">
                    <Input
                      id="rename-input"
                      autoFocus
                      autoComplete="off"
                      spellCheck={false}
                      value={renameDialog.name}
                      onChange={(e) =>
                        setRenameDialog({ ...renameDialog, name: e.target.value })
                      }
                      onFocus={(e) => e.currentTarget.select()}
                      disabled={mutationBusy}
                      className="h-10 border-card-hover bg-card pr-16 font-mono-tech text-[12px] text-primary placeholder:text-muted-foreground"
                    />
                    {renameDialog.ext && (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-y-0 right-3 flex items-center font-mono-tech text-[12px] text-muted-foreground/80"
                      >
                        {renameDialog.ext}
                      </span>
                    )}
                  </div>
                ) : (
                  <Input
                    id="rename-input"
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    value={renameDialog.name}
                    onChange={(e) =>
                      setRenameDialog({ ...renameDialog, name: e.target.value })
                    }
                    onFocus={(e) => e.currentTarget.select()}
                    disabled={mutationBusy}
                    className="h-10 border-card-hover bg-card font-mono-tech text-[12px] text-primary placeholder:text-muted-foreground"
                  />
                )}

                <p className="font-mono-tech text-[10px] text-muted-foreground/70">
                  Current: {renameDialog.relativePath}
                </p>
                {!renameDialog.isDir && (
                  <p className="font-mono-tech text-[10px] text-muted-foreground/60">
                    Tip: paste a full path (with &quot;/&quot;) to move the file at the same time.
                  </p>
                )}
              </div>

              <DialogFooter className="pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setRenameDialog(null)}
                  disabled={mutationBusy}
                  className="px-4 py-2 h-auto text-muted-foreground hover:text-primary"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={mutationBusy || !renameDialog.name.trim()}
                  className="rounded-full bg-primary text-app hover:opacity-90 px-5 py-2 h-auto"
                >
                  {mutationBusy ? "Renaming…" : "Rename"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirmation. AlertDialog is the right primitive for
          destructive actions — it's modal, requires an explicit click
          to dismiss, and the Cancel/Delete buttons are clearly
          differentiated. The Delete button uses bg-destructive (red)
          per the design system. */}
      <AlertDialog
        open={deleteDialog !== null}
        onOpenChange={(open) => { if (!open && !mutationBusy) setDeleteDialog(null); }}
      >
        <AlertDialogContent className="border-border bg-card text-foreground sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteDialog
                ? deleteDialog.isDir
                  ? `Delete folder "${deleteDialog.name}" and all its contents?`
                  : `Delete file "${deleteDialog.name}"?`
                : ""}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              {deleteDialog
                ? deleteDialog.isDir
                  ? "This recursively removes every file and sub-folder inside it. This action cannot be undone."
                  : "This permanently removes the file from your workspace. This action cannot be undone."
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={mutationBusy}
              className="border-card-hover bg-transparent text-foreground hover:bg-card-hover hover:text-foreground"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Prevent the default close behaviour — we want to
                // control when the dialog closes (after the network
                // call resolves). We close it inside submitDelete.
                e.preventDefault();
                void submitDelete();
              }}
              disabled={mutationBusy}
              className="bg-destructive text-destructive-foreground hover:opacity-90"
            >
              {mutationBusy ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk delete confirmation. Uses the same AlertDialog primitive
          as the single-item delete so the visual language matches
          exactly. The body shows a scrollable list of the paths
          that will be deleted, capped at 50 with a "+N more" line
          so the dialog doesn't blow up when the user shift-clicks
          500 items. We dedupe ancestor/descendant pairs so the
          count we display is what will actually be requested. */}
      <AlertDialog
        open={bulkDeleteDialog !== null}
        onOpenChange={(open) => { if (!open && !mutationBusy) setBulkDeleteDialog(null); }}
      >
        <AlertDialogContent className="border-border bg-card text-foreground sm:max-w-[480px]">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {bulkDeleteDialog
                ? `Delete ${bulkDeleteDialog.paths.length} item${bulkDeleteDialog.paths.length === 1 ? "" : "s"}?`
                : ""}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              {bulkDeleteDialog
                ? (() => {
                    const parts: string[] = [];
                    if (bulkDeleteDialog.fileCount > 0) {
                      parts.push(`${bulkDeleteDialog.fileCount} file${bulkDeleteDialog.fileCount === 1 ? "" : "s"}`);
                    }
                    if (bulkDeleteDialog.isDirCount > 0) {
                      parts.push(`${bulkDeleteDialog.isDirCount} folder${bulkDeleteDialog.isDirCount === 1 ? "" : "s"}`);
                    }
                    const breakdown = parts.length > 0 ? ` (${parts.join(" and ")})` : "";
                    return `This permanently removes ${breakdown} from your workspace. Folders are removed recursively, so any nested children are deleted too. This action cannot be undone.`;
                  })()
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {bulkDeleteDialog && bulkDeleteDialog.paths.length > 0 && (
            <div className="max-h-[200px] overflow-y-auto rounded border border-border/40 bg-card-3 px-3 py-2 font-mono text-[11px] leading-relaxed">
              {bulkDeleteDialog.paths.slice(0, 50).map((p) => (
                <div key={p} className="flex items-center gap-1.5 truncate text-foreground/80" title={p}>
                  <Trash2 size={10} className="shrink-0 text-accent-red/70" />
                  <span className="truncate">{p}</span>
                </div>
              ))}
              {bulkDeleteDialog.paths.length > 50 && (
                <div className="mt-1 border-t border-border/30 pt-1 text-muted-foreground/70">
                  + {bulkDeleteDialog.paths.length - 50} more…
                </div>
              )}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={mutationBusy}
              className="border-card-hover bg-transparent text-foreground hover:bg-card-hover hover:text-foreground"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void submitBulkDelete();
              }}
              disabled={mutationBusy}
              className="bg-destructive text-destructive-foreground hover:opacity-90"
            >
              {mutationBusy
                ? `Deleting…`
                : bulkDeleteDialog
                  ? `Delete ${bulkDeleteDialog.paths.length} item${bulkDeleteDialog.paths.length === 1 ? "" : "s"}`
                  : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
