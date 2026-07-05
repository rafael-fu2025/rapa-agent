// Tier 4 — Go-to-file and Find-in-files dialogs.
//
// Both dialogs follow the same shape: a modal with a search input
// at the top and a results list below. They use the cmdk primitive
// for the input (we get keyboard navigation, fuzzy match built in,
// and a clean a11y story for free).
//
// We use the same `cmdk` Command primitive but render different
// children for each dialog so the look-and-feel can be tuned per
// use case. Both are controlled via `open` + `onOpenChange`.
//
// The Go-to-file palette (Ctrl+P) fuzzy-matches file paths in the
// workspace. Enter or click opens the file in the viewer. The
// Find-in-files palette (Ctrl+Shift+F) shows every line that
// contains the query, across all files. Enter jumps to that
// location — but since we don't have an in-app code viewer with
// line numbers yet, we open the file and copy the line number to
// the toast so the user knows where the match was.

import { useEffect, useState, useCallback } from "react";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem
} from "./ui/command";
import { useDebounce } from "../hooks/use-debounce";
import {
  matchWorkspaceFiles,
  searchWorkspaceContents,
  type FileMatch,
  type ContentMatch
} from "../../lib/workspace-api";
import { File, Loader2, Search as SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "../../lib/utils";

// === Go to file (Ctrl+P) ====================================================

type GoToFileDialogProps = {
  workspaceId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFileOpen: (relativePath: string) => void;
};

export function GoToFileDialog({
  workspaceId,
  open,
  onOpenChange,
  onFileOpen
}: GoToFileDialogProps) {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounce(query, 120);
  const [matches, setMatches] = useState<FileMatch[]>([]);
  const [loading, setLoading] = useState(false);

  // Reset state every time the dialog opens so a previous query
  // doesn't leak into the next session.
  useEffect(() => {
    if (open) {
      setQuery("");
      setMatches([]);
    }
  }, [open]);

  // Debounced fetch. We cancel in-flight requests via a flag so
  // rapid typing doesn't race the server.
  useEffect(() => {
    if (!open || !workspaceId || debouncedQuery.trim().length === 0) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void matchWorkspaceFiles(workspaceId, debouncedQuery.trim(), 30)
      .then((results) => {
        if (cancelled) return;
        setMatches(results);
      })
      .catch((err) => {
        if (cancelled) return;
        toast.error(err instanceof Error ? err.message : "Search failed");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, open, workspaceId]);

  const handleSelect = useCallback(
    (match: FileMatch) => {
      onFileOpen(match.path);
      onOpenChange(false);
    },
    [onFileOpen, onOpenChange]
  );

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Go to File" description="Open any file in this workspace">
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Type a file name or path…"
      />
      <CommandList>
        {loading && (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/60" />
          </div>
        )}
        {!loading && query.trim().length > 0 && matches.length === 0 && (
          <CommandEmpty>No matching files</CommandEmpty>
        )}
        {!loading && query.trim().length === 0 && (
          <div className="py-6 text-center text-[12px] text-muted-foreground/60">
            Start typing to search files in this workspace
          </div>
        )}
        {matches.length > 0 && (
          <CommandGroup heading="Files">
            {matches.map((m) => (
              <CommandItem
                key={m.path}
                value={`${m.path} ${m.name}`}
                onSelect={() => handleSelect(m)}
                className="font-mono-tech text-[12px]"
              >
                <File className="mr-2 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                <span className="truncate font-medium text-foreground/90">{m.name}</span>
                <span className="ml-2 truncate text-[11px] text-muted-foreground/60">
                  {m.path}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}

// === Find in files (Ctrl+Shift+F) ===========================================

type FindInFilesDialogProps = {
  workspaceId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFileOpen: (relativePath: string) => void;
};

export function FindInFilesDialog({
  workspaceId,
  open,
  onOpenChange,
  onFileOpen
}: FindInFilesDialogProps) {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounce(query, 250);
  const [results, setResults] = useState<{ query: string; count: number; matches: ContentMatch[] }>({
    query: "",
    count: 0,
    matches: []
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setQuery("");
      setResults({ query: "", count: 0, matches: [] });
    }
  }, [open]);

  useEffect(() => {
    if (!open || !workspaceId || debouncedQuery.trim().length === 0) {
      setResults({ query: "", count: 0, matches: [] });
      return;
    }
    let cancelled = false;
    setLoading(true);
    void searchWorkspaceContents(workspaceId, debouncedQuery.trim(), 200)
      .then((res) => {
        if (cancelled) return;
        setResults(res);
      })
      .catch((err) => {
        if (cancelled) return;
        toast.error(err instanceof Error ? err.message : "Search failed");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, open, workspaceId]);

  const handleSelect = useCallback(
    (match: ContentMatch) => {
      onFileOpen(match.path);
      toast.success(`Opened ${match.path} (line ${match.line})`);
      onOpenChange(false);
    },
    [onFileOpen, onOpenChange]
  );

  // Group matches by file path so the result list shows file
  // headers (matching VS Code's "Find in Files" presentation).
  const grouped = groupMatchesByPath(results.matches);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Find in Files"
      description="Search the contents of every file in this workspace"
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search text…"
      />
      <CommandList>
        {loading && (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/60" />
          </div>
        )}
        {!loading && query.trim().length > 0 && results.matches.length === 0 && (
          <CommandEmpty>No matches in this workspace</CommandEmpty>
        )}
        {!loading && query.trim().length === 0 && (
          <div className="py-6 text-center text-[12px] text-muted-foreground/60">
            <SearchIcon className="mx-auto mb-2 h-5 w-5 text-muted-foreground/40" />
            Type to search file contents across the workspace
          </div>
        )}
        {!loading && results.count > 0 && (
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">
            {results.count} match{results.count === 1 ? "" : "es"}
          </div>
        )}
        {grouped.map(({ path, matches: fileMatches }) => (
          <CommandGroup key={path} heading={path}>
            {fileMatches.map((m) => (
              <CommandItem
                key={`${m.path}:${m.line}:${m.column}`}
                value={`${m.path} ${m.line} ${m.preview}`}
                onSelect={() => handleSelect(m)}
                className="font-mono-tech text-[11px]"
              >
                <span className="mr-2 inline-block w-10 shrink-0 text-right text-[10px] text-muted-foreground/60">
                  {m.line}
                </span>
                <span
                  className={cn(
                    "truncate",
                    m.preview.toLowerCase().includes(query.toLowerCase())
                      ? "text-foreground/90"
                      : "text-muted-foreground/70"
                  )}
                >
                  {m.preview}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}

function groupMatchesByPath(
  matches: ContentMatch[]
): { path: string; matches: ContentMatch[] }[] {
  const map = new Map<string, ContentMatch[]>();
  for (const m of matches) {
    const list = map.get(m.path) ?? [];
    list.push(m);
    map.set(m.path, list);
  }
  return Array.from(map.entries()).map(([path, matches]) => ({ path, matches }));
}
