// Auto-approve pattern management — the Agent Settings section for the
// progressive-trust rules created via the "Always allow" checkbox on
// approval prompts. Also surfaces the always-approved baseline so the
// effective permission set is visible, not just deltas (audit M2.3).

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  deleteAutoApprovePattern,
  listAutoApprovePatterns,
  upsertAutoApprovePattern,
  type AutoApprovePattern
} from "../../lib/agent-api";
import { DEFAULT_AUTO_APPROVE_TOOLS } from "../../lib/agent-settings";
import { cn } from "../../lib/utils";
import { Switch } from "./ui/switch";

function formatTimeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function AutoApprovePatternsSection() {
  const [patterns, setPatterns] = useState<AutoApprovePattern[]>([]);
  const [loading, setLoading] = useState(true);
  const [baselineOpen, setBaselineOpen] = useState(false);
  const [busyIds, setBusyIds] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { patterns: next } = await listAutoApprovePatterns();
      setPatterns(next);
    } catch {
      toast.error("Failed to load auto-approve patterns");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const togglePattern = async (pattern: AutoApprovePattern, enabled: boolean) => {
    setBusyIds((prev) => [...prev, pattern.id]);
    try {
      await upsertAutoApprovePattern({
        id: pattern.id,
        name: pattern.name,
        pattern: pattern.pattern,
        matchType: pattern.matchType,
        toolName: pattern.toolName ?? undefined,
        scope: pattern.scope,
        enabled
      });
      setPatterns((prev) => prev.map((p) => (p.id === pattern.id ? { ...p, enabled } : p)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update pattern");
    } finally {
      setBusyIds((prev) => prev.filter((id) => id !== pattern.id));
    }
  };

  const removePattern = async (pattern: AutoApprovePattern) => {
    setBusyIds((prev) => [...prev, pattern.id]);
    try {
      await deleteAutoApprovePattern(pattern.id);
      setPatterns((prev) => prev.filter((p) => p.id !== pattern.id));
      toast.success(`Removed auto-approve rule "${pattern.name}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete pattern");
    } finally {
      setBusyIds((prev) => prev.filter((id) => id !== pattern.id));
    }
  };

  return (
    <section className="analytics-panel rounded-lg p-5">
      <div className="flex items-start gap-3 pb-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent-yellow/15 text-accent-yellow">
          <ShieldCheck size={14} />
        </div>
        <div>
          <h2 className="panel-title">Auto-Approve Rules</h2>
          <p className="panel-desc mt-0.5">
            Rules created when you tick &ldquo;Always allow&rdquo; on an approval. Destructive commands are always confirmed regardless of these rules.
          </p>
        </div>
      </div>

      {/* Effective-permissions expander: the baseline that ships enabled. */}
      <button
        type="button"
        onClick={() => setBaselineOpen((v) => !v)}
        aria-expanded={baselineOpen}
        className="mb-3 flex w-full items-center gap-1.5 rounded border border-border/40 bg-card-3/40 px-3 py-2 text-left transition-colors hover:bg-accent/20"
      >
        {baselineOpen ? <ChevronDown size={12} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={12} className="shrink-0 text-muted-foreground" />}
        <span className="font-mono-tech text-[10px] text-muted-foreground">
          {DEFAULT_AUTO_APPROVE_TOOLS.length} read-only tools always run without approval — review
        </span>
      </button>
      {baselineOpen && (
        <div className="mb-3 flex flex-wrap gap-1.5 rounded border border-border/30 bg-card-3/30 p-2.5">
          {DEFAULT_AUTO_APPROVE_TOOLS.map((tool) => (
            <code key={tool} className="rounded border border-border/40 bg-card-3/60 px-1.5 py-0.5 font-mono-tech text-[9px] text-muted-foreground">
              {tool}
            </code>
          ))}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 size={16} className="animate-spin text-muted-foreground/40" />
        </div>
      ) : patterns.length === 0 ? (
        <p className="px-1 py-4 font-mono-tech text-[10px] text-muted-foreground/60">
          No rules yet. Next time a tool asks for approval, tick &ldquo;Always allow&rdquo; to create one.
        </p>
      ) : (
        <div className="space-y-1.5">
          {patterns.map((pattern) => {
            const busy = busyIds.includes(pattern.id);
            return (
              <div
                key={pattern.id}
                className={cn(
                  "flex items-center gap-3 rounded border px-3 py-2.5",
                  pattern.enabled ? "border-accent-green/30 bg-accent-green/[0.06]" : "border-border/50 bg-card-3/40"
                )}
              >
                <Switch
                  checked={pattern.enabled}
                  onCheckedChange={(v) => { void togglePattern(pattern, v === true); }}
                  disabled={busy}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono-tech text-[10px] font-semibold text-foreground">
                    {pattern.pattern}
                    <span className="ml-1.5 rounded border border-border/40 px-1 text-[8px] font-normal uppercase text-muted-foreground/60">
                      {pattern.matchType}
                    </span>
                    {pattern.toolName && (
                      <span className="ml-1.5 font-normal text-muted-foreground/50">· {pattern.toolName}</span>
                    )}
                  </div>
                  <div className="mt-0.5 font-mono-tech text-[9px] text-muted-foreground/60">
                    {pattern.scope}
                    {pattern.useCount > 0 && ` · used ${pattern.useCount}×`}
                    {pattern.lastUsedAt && ` · last ${formatTimeAgo(pattern.lastUsedAt)}`}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => { void removePattern(pattern); }}
                  disabled={busy}
                  aria-label={`Delete auto-approve rule ${pattern.pattern}`}
                  className="shrink-0 rounded p-1.5 text-muted-foreground/50 transition-colors hover:bg-accent-red/10 hover:text-accent-red disabled:opacity-40"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
