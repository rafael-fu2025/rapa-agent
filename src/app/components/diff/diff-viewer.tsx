import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "../../../lib/utils";
import { FileTypeIcon } from "../file-type-icon";
import {
  computeDiffStats,
  computeHunks,
  hashEntry,
  type DiffEntry,
  type DiffHunkLineType
} from "./diff-hunks";

/* DiffViewer — two-pane file diff review surface shared by the message
   trace (DiffView wrapper), the review dialog and the persisted-run
   checkpoint panel. Left pane: file list with +/- stats and per-file
   seen state; right pane: hunk sections with prev/next navigation.
   Tone "bw" keeps the deliberate black/white/grey scheme from the old
   per-file cards; tone "color" keeps the green/red tints from the old
   dialog. Seen state persists per-path as path -> content hash, so a
   file whose content changed automatically un-seens. */

const DEFAULT_SEEN_STORAGE_KEY = "rapa.diffSeen";

type SeenMap = Record<string, string>;

type DiffViewerProps = {
  entries: DiffEntry[];
  /** localStorage key for per-file seen state (path -> content hash). */
  storageKey?: string;
  /** "bw" (default) = strict black/white/grey; "color" = green/red tints. */
  tone?: "bw" | "color";
  /** Overrides the empty-state headline copy. */
  emptyMessage?: string;
  className?: string;
};

function readSeenMap(storageKey: string): SeenMap {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: SeenMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function useSeenState(entries: DiffEntry[], storageKey: string) {
  const [marked, setMarked] = useState<SeenMap>(() => readSeenMap(storageKey));

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(marked));
    } catch {
      /* ignore */
    }
  }, [marked, storageKey]);

  const hashes = useMemo(() => {
    const map: Record<string, string> = {};
    for (const entry of entries) map[entry.path] = hashEntry(entry);
    return map;
  }, [entries]);

  const isSeen = useCallback(
    (path: string) => marked[path] != null && marked[path] === hashes[path],
    [marked, hashes]
  );

  const toggleSeen = useCallback(
    (path: string) => {
      setMarked((prev) => {
        const next = { ...prev };
        if (next[path] != null && next[path] === hashes[path]) {
          delete next[path];
        } else {
          next[path] = hashes[path];
        }
        return next;
      });
    },
    [hashes]
  );

  const markAllSeen = useCallback(() => {
    setMarked((prev) => ({ ...prev, ...hashes }));
  }, [hashes]);

  const seenCount = entries.filter((entry) => isSeen(entry.path)).length;

  return { isSeen, toggleSeen, markAllSeen, seenCount };
}

const TONE_CLASSES: Record<"bw" | "color", Record<DiffHunkLineType, string>> = {
  bw: {
    // Strict B/W/grey palette. Added/removed rows are differentiated by
    // background opacity (full vs. reduced), not by green/red tint.
    add: "bg-card text-primary font-medium",
    del: "bg-card-3 text-muted-foreground line-through opacity-70",
    ctx: "bg-transparent text-muted-foreground"
  },
  color: {
    add: "bg-accent-green/[0.08] text-accent-green font-medium",
    del: "bg-accent-red/[0.06] text-accent-red line-through opacity-80",
    ctx: "bg-transparent text-muted-foreground"
  }
};

export function DiffViewer({ entries, storageKey, tone = "bw", emptyMessage, className }: DiffViewerProps) {
  const resolvedStorageKey = storageKey ?? DEFAULT_SEEN_STORAGE_KEY;
  const { isSeen, toggleSeen, markAllSeen, seenCount } = useSeenState(entries, resolvedStorageKey);
  const [selectedPath, setSelectedPath] = useState<string | null>(entries[0]?.path ?? null);
  const [activeHunk, setActiveHunk] = useState(0);
  const hunkRefs = useRef<Array<HTMLDivElement | null>>([]);

  // One row per unique path — repeat edits to the same file collapse
  // into the newest entry (extractDiffs returns newest-first).
  const uniqueEntries = useMemo(() => {
    const seen = new Set<string>();
    const out: DiffEntry[] = [];
    for (const entry of entries) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      out.push(entry);
    }
    return out;
  }, [entries]);

  useEffect(() => {
    if (uniqueEntries.length === 0) {
      setSelectedPath(null);
      return;
    }
    if (!selectedPath || !uniqueEntries.some((entry) => entry.path === selectedPath)) {
      setSelectedPath(uniqueEntries[0].path);
    }
  }, [uniqueEntries, selectedPath]);

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.path === selectedPath) ?? entries[0] ?? null,
    [entries, selectedPath]
  );

  const hunks = useMemo(
    () => (selectedEntry ? computeHunks(selectedEntry.before, selectedEntry.after) : []),
    [selectedEntry]
  );

  // A stale activeHunk (hunk count changed) clamps instead of breaking nav.
  const currentHunk = hunks.length === 0 ? 0 : Math.min(activeHunk, hunks.length - 1);

  // Reset hunk navigation when the selected file changes.
  useEffect(() => {
    setActiveHunk(0);
    hunkRefs.current = [];
  }, [selectedPath]);

  const statsByPath = useMemo(() => {
    const map = new Map<string, { added: number; removed: number }>();
    for (const entry of uniqueEntries) {
      map.set(entry.path, computeDiffStats(entry.before, entry.after));
    }
    return map;
  }, [uniqueEntries]);

  const goToHunk = useCallback(
    (index: number) => {
      if (hunks.length === 0) return;
      const next = Math.max(0, Math.min(hunks.length - 1, index));
      setActiveHunk(next);
      const node = hunkRefs.current[next];
      // jsdom (tests) does not implement scrollIntoView.
      if (node && typeof node.scrollIntoView === "function") {
        node.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    },
    [hunks.length]
  );

  if (entries.length === 0) {
    return (
      <div className={cn("rounded border border-dashed border-border/40 bg-card-3/30 px-4 py-8 text-center", className)}>
        {emptyMessage ? (
          <>
            <div className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
              no file changes
            </div>
            <p className="mx-auto mt-1.5 max-w-md text-sm leading-6 text-muted-foreground">{emptyMessage}</p>
          </>
        ) : (
          <div className="font-mono-tech text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            No file changes in this run
          </div>
        )}
      </div>
    );
  }

  const showFileList = uniqueEntries.length > 1;
  const toneClasses = TONE_CLASSES[tone];
  const allSeen = seenCount >= uniqueEntries.length;

  const seenToggle = (path: string, label: string) => {
    const seen = isSeen(path);
    return (
      <span
        role="checkbox"
        aria-checked={seen}
        aria-label={`Mark ${label} seen`}
        tabIndex={0}
        onClick={(event) => {
          event.stopPropagation();
          toggleSeen(path);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            toggleSeen(path);
          }
        }}
        className={cn(
          "flex h-3.5 w-3.5 shrink-0 cursor-pointer items-center justify-center rounded-sm border transition-colors",
          seen ? "border-accent-green/50 bg-accent-green/15 text-accent-green" : "border-border/50 bg-transparent text-transparent"
        )}
      >
        <Check className="h-2.5 w-2.5" />
      </span>
    );
  };

  return (
    <div className={cn("flex min-h-0 overflow-hidden rounded border border-border/40", className)}>
      {showFileList && (
        <div className="flex w-52 shrink-0 flex-col border-r border-border/40 bg-card-3/30">
          <div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5">
            <span className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
              Files
            </span>
            <button
              type="button"
              onClick={markAllSeen}
              disabled={allSeen}
              className="rounded border border-border/40 px-1.5 py-0.5 font-mono-tech text-[8px] font-semibold uppercase tracking-[0.08em] text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              Mark all seen
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {uniqueEntries.map((entry) => {
              const stats = statsByPath.get(entry.path) ?? { added: 0, removed: 0 };
              const selected = entry.path === selectedEntry?.path;
              return (
                <div
                  role="button"
                  tabIndex={0}
                  key={entry.path}
                  aria-label={`Select ${entry.path}`}
                  onClick={() => setSelectedPath(entry.path)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedPath(entry.path);
                    }
                  }}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 border-b border-border/30 px-2.5 py-2 text-left transition-colors last:border-b-0",
                    selected ? "bg-card" : "hover:bg-card-3/50"
                  )}
                >
                  {seenToggle(entry.path, entry.path)}
                  <span className="min-w-0 flex-1 truncate font-mono-tech text-[10px] text-foreground" title={entry.path}>
                    {entry.path}
                  </span>
                  <span className="shrink-0 font-mono-tech text-[9px] text-muted-foreground">
                    +{stats.added} −{stats.removed}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border/40 bg-card-3/40 px-3 py-1.5">
          {selectedEntry && (
            <FileTypeIcon
              name={selectedEntry.path.split(/[\\/]/).pop() ?? selectedEntry.path}
              className="h-3.5 w-3.5 shrink-0"
            />
          )}
          <span className="min-w-0 flex-1 truncate font-mono-tech text-[10px] text-foreground" title={selectedEntry?.path}>
            {selectedEntry?.path}
          </span>
          {!showFileList && selectedEntry && seenToggle(selectedEntry.path, selectedEntry.path)}
          {hunks.length > 0 && (
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                aria-label="Previous hunk"
                onClick={() => goToHunk(currentHunk - 1)}
                disabled={currentHunk <= 0}
                className="rounded border border-border/40 p-0.5 text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronUp className="h-3 w-3" />
              </button>
              <span className="min-w-[28px] text-center font-mono-tech text-[9px] text-muted-foreground">
                {currentHunk + 1}/{hunks.length}
              </span>
              <button
                type="button"
                aria-label="Next hunk"
                onClick={() => goToHunk(currentHunk + 1)}
                disabled={currentHunk >= hunks.length - 1}
                className="rounded border border-border/40 p-0.5 text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronDown className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto bg-app p-2">
          {hunks.length > 0 ? (
            <div className="space-y-2">
              {hunks.map((hunk, index) => (
                <div
                  key={hunk.header + index}
                  ref={(node) => {
                    hunkRefs.current[index] = node;
                  }}
                  className="overflow-hidden rounded border border-border/40"
                >
                  <div className="border-b border-border/40 bg-card-3/60 px-3 py-1">
                    <span className="font-mono-tech text-[9px] text-muted-foreground">{hunk.header}</span>
                  </div>
                  <div>
                    {hunk.lines.map((line, lineIndex) => (
                      <div
                        key={`${index}-${lineIndex}`}
                        className={cn(
                          "grid grid-cols-[40px_44px_1fr] px-3 font-mono-tech text-[11px] leading-[1.6]",
                          toneClasses[line.type]
                        )}
                      >
                        <span className="select-none text-muted-foreground/70">
                          {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
                        </span>
                        <span className="select-none text-right text-muted-foreground/50">
                          {line.type === "del" ? line.oldLine : line.newLine ?? line.oldLine}
                        </span>
                        <span className="whitespace-pre-wrap break-words">{line.text || " "}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : selectedEntry?.rawPreview ? (
            <div className="overflow-hidden rounded border border-border/40">
              <div className="border-b border-border/40 bg-card-3/60 px-3 py-1">
                <span className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
                  raw preview
                </span>
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words bg-app px-3 py-2 font-mono-tech text-[10px] leading-[1.6] text-foreground">
                {selectedEntry.rawPreview}
              </pre>
            </div>
          ) : (
            <div className="rounded border border-dashed border-border/40 px-4 py-6 text-center font-mono-tech text-[10px] text-muted-foreground">
              No hunks to display for this file
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
