import { useEffect, useMemo, useState } from "react";
import { Bot, Eye, EyeOff, Plus, RotateCcw, Save, Sparkles, Loader2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";

import { listAgentSkills, listAgentSpecialists, upsertAgentSkill, type AgentSkill, type AgentSpecialist } from "../../lib/agent-api";

const BUILTIN_SPECIALIST_ORDER = [
  "research_specialist",
  "debug_specialist",
  "planning_specialist",
  "codebase_specialist",
  "design_specialist"
] as const;

type SpecialistEditor = {
  id?: string;
  name: string;
  description: string;
  instructions: string;
  whenToUseText: string;
  suggestedToolsText: string;
  enabled: boolean;
  source: "builtin" | "database";
  isBuiltin: boolean;
  /** True when stored override differs from the current built-in instructions */
  hasStaleOverride: boolean;
  /** The current built-in instructions for comparison/revert */
  builtinInstructions: string;
  builtinDescription: string;
};

function configRecord(config: AgentSkill["config"]): Record<string, unknown> | undefined {
  return config && typeof config === "object" && !Array.isArray(config) ? config : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function linesToText(values: string[]): string {
  return values.join("\n");
}

function textToLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildEditors(activeSpecialists: AgentSpecialist[], storedSkills: AgentSkill[]): SpecialistEditor[] {
  const activeByName = new Map(activeSpecialists.map((specialist) => [specialist.name, specialist]));
  const storedByName = new Map(storedSkills.map((skill) => [skill.name, skill]));

  const builtinEditors = BUILTIN_SPECIALIST_ORDER.map((name) => {
    const active = activeByName.get(name);
    const stored = storedByName.get(name);
    const config = configRecord(stored?.config);

    const storedInstructions = stringValue(config?.instructions) || stringValue(config?.prompt);
    const builtinInstructions = active?.builtinInstructions ?? active?.instructions ?? "";
    const builtinDescription = active?.builtinDescription ?? active?.description ?? "";

    // Detect stale override: stored exists and differs from current built-in
    const hasStaleOverride = !!stored && !!storedInstructions && storedInstructions !== builtinInstructions;

    // When there's a stale override, show the CURRENT built-in (not the stale stored version)
    const useBuiltin = hasStaleOverride || !storedInstructions;

    return {
      id: stored?.id,
      name,
      description: useBuiltin ? builtinDescription : (stored?.description ?? active?.description ?? ""),
      instructions: useBuiltin ? builtinInstructions : storedInstructions,
      whenToUseText: linesToText(stringArrayValue(config?.whenToUse).length > 0 ? stringArrayValue(config?.whenToUse) : (active?.whenToUse ?? [])),
      suggestedToolsText: linesToText(stringArrayValue(config?.suggestedTools).length > 0 ? stringArrayValue(config?.suggestedTools) : (active?.suggestedTools ?? [])),
      enabled: stored?.enabled ?? false,
      source: active?.source ?? "builtin",
      isBuiltin: true,
      hasStaleOverride,
      builtinInstructions,
      builtinDescription
    } satisfies SpecialistEditor;
  });

  const customNames = new Set<string>();
  for (const specialist of activeSpecialists) {
    if (!BUILTIN_SPECIALIST_ORDER.includes(specialist.name as typeof BUILTIN_SPECIALIST_ORDER[number])) {
      customNames.add(specialist.name);
    }
  }
  for (const skill of storedSkills) {
    if (!BUILTIN_SPECIALIST_ORDER.includes(skill.name as typeof BUILTIN_SPECIALIST_ORDER[number])) {
      customNames.add(skill.name);
    }
  }

  const customEditors = Array.from(customNames)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const active = activeByName.get(name);
      const stored = storedByName.get(name);
      const config = configRecord(stored?.config);

      return {
        id: stored?.id,
        name,
        description: stored?.description ?? active?.description ?? "",
        instructions: stringValue(config?.instructions) || stringValue(config?.prompt) || active?.instructions || "",
        whenToUseText: linesToText(stringArrayValue(config?.whenToUse).length > 0 ? stringArrayValue(config?.whenToUse) : (active?.whenToUse ?? [])),
        suggestedToolsText: linesToText(stringArrayValue(config?.suggestedTools).length > 0 ? stringArrayValue(config?.suggestedTools) : (active?.suggestedTools ?? [])),
        enabled: stored?.enabled ?? (active?.source === "database"),
        source: active?.source ?? "database",
        isBuiltin: false,
        hasStaleOverride: false,
        builtinInstructions: "",
        builtinDescription: ""
      } satisfies SpecialistEditor;
    });

  return [...builtinEditors, ...customEditors];
}

export const AgentSpecialistsPage = () => {
  const [specialists, setSpecialists] = useState<SpecialistEditor[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingNames, setSavingNames] = useState<string[]>([]);
  const [previewNames, setPreviewNames] = useState<Set<string>>(new Set());

  const loadSpecialists = async () => {
    setLoading(true);
    try {
      const [{ specialists: activeSpecialists }, { skills: storedSkills }] = await Promise.all([
        listAgentSpecialists(),
        listAgentSkills()
      ]);
      const editors = buildEditors(activeSpecialists, storedSkills);
      setSpecialists(editors);
      // Default to preview mode for every loaded specialist.
      setPreviewNames(new Set(editors.map((editor) => editor.name)));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load specialists");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSpecialists();
  }, []);

  const builtinSpecialists = useMemo(
    () => specialists.filter((specialist) => specialist.isBuiltin),
    [specialists]
  );
  const customSpecialists = useMemo(
    () => specialists.filter((specialist) => !specialist.isBuiltin),
    [specialists]
  );

  const updateSpecialist = (targetName: string, updater: (current: SpecialistEditor) => SpecialistEditor) => {
    setSpecialists((current) => current.map((specialist) => (
      specialist.name === targetName ? updater(specialist) : specialist
    )));
  };

  const togglePreview = (name: string) => {
    setPreviewNames((current) => {
      const next = new Set(current);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const saveSpecialist = async (specialist: SpecialistEditor, enabled = true) => {
    const trimmedName = specialist.name.trim();
    if (!trimmedName) {
      toast.error("Specialist name is required");
      return;
    }

    const payload = {
      id: specialist.id,
      name: trimmedName,
      description: specialist.description.trim() || undefined,
      enabled,
      config: {
        instructions: specialist.instructions.trim(),
        whenToUse: textToLines(specialist.whenToUseText),
        suggestedTools: textToLines(specialist.suggestedToolsText)
      }
    };

    if (!payload.config.instructions) {
      toast.error("Instructions are required");
      return;
    }

    setSavingNames((current) => current.includes(trimmedName) ? current : [...current, trimmedName]);
    try {
      await upsertAgentSkill(payload);
      toast.success(enabled ? `Saved specialist "${trimmedName}"` : `Reverted "${trimmedName}" to built-in behavior`);
      await loadSpecialists();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save specialist");
    } finally {
      setSavingNames((current) => current.filter((name) => name !== trimmedName));
    }
  };

  const addCustomSpecialist = () => {
    const draftName = `custom_specialist_${customSpecialists.length + 1}`;
    if (specialists.some((specialist) => specialist.name === draftName)) {
      toast.error("A draft specialist with that name already exists");
      return;
    }

    setSpecialists((current) => [
      ...current,
      {
        name: draftName,
        description: "",
        instructions: "",
        whenToUseText: "",
        suggestedToolsText: "",
        enabled: true,
        source: "database",
        isBuiltin: false
      }
    ]);
    // Default the new draft to preview mode to match the rest of the page.
    setPreviewNames((current) => {
      const next = new Set(current);
      next.add(draftName);
      return next;
    });
  };

  const inputClassName = "w-full panel-card rounded border-border/60 px-3 py-2 font-mono-tech text-[10px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring";
  const previewClassName = "min-h-[140px] panel-card rounded border-border/60 px-4 py-3 font-mono-tech text-[10px] text-foreground leading-relaxed [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:mb-2 [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-xs [&_h3]:font-semibold [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_strong]:font-semibold [&_code]:rounded [&_code]:bg-card-2 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[10px] [&_code]:text-foreground [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-card-2 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border/60 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground";

  return (
    <div className="sidebar-scroll flex-1 overflow-y-auto bg-app p-5 text-primary">
      <div
        className="sticky top-[-20px] z-10 w-full h-12 pointer-events-none"
        style={{ backgroundImage: "linear-gradient(to bottom, var(--fade-tint-strong), transparent)" }}
      />
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="inline-flex h-9 w-9 items-center justify-center rounded bg-accent/50 border border-border/40 text-accent-foreground">
              <Bot size={16} />
            </div>
            <h1 className="font-mono-tech text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground">Agent Specialists</h1>
            <p className="max-w-[65ch] font-mono-tech text-[10px] text-muted-foreground">
              Same-agent specialist modes the main agent can activate with <code>delegate_task</code>. Override built-ins or create your own.
            </p>
          </div>
          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={addCustomSpecialist}
              className="inline-flex items-center gap-1.5 rounded bg-accent-orange px-3 py-1.5 font-mono-tech text-[10px] font-semibold uppercase tracking-[0.12em] text-white hover:bg-accent-orange/80 transition-colors"
            >
              <Plus size={12} />
              Add Specialist
            </button>
          </div>
        </header>

        {loading ? (
          <div className="analytics-panel rounded-lg p-5 font-mono-tech text-[10px] text-muted-foreground">
            Loading specialists...
          </div>
        ) : (
          <>
            <section className="analytics-panel rounded-lg p-5">
              <div className="flex items-start gap-3 pb-4">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent-blue/15 text-accent-blue">
                  <Sparkles size={14} />
                </div>
                <div>
                  <h2 className="panel-title">Built-In Specialists</h2>
                  <p className="panel-desc mt-0.5">
                    Ship with the agent. Override any of them to customize behavior without changing the source.
                  </p>
                </div>
              </div>
              <div className="space-y-3">
                {builtinSpecialists.map((specialist) => {
                  const isSaving = savingNames.includes(specialist.name);
                  return (
                    <div key={specialist.name} className="panel-card rounded overflow-hidden">
                      <div className="p-4 space-y-3">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="font-mono-tech text-[11px] font-semibold text-foreground">{specialist.name}</h3>
                            <span className={`panel-badge ${specialist.source === "database" ? "border-accent-green/30 bg-accent-green/15 text-accent-green" : ""}`}>
                              {specialist.source === "database" ? "Override Active" : "Built-In Active"}
                            </span>
                            {specialist.hasStaleOverride && (
                              <span className="panel-badge border-accent-orange/30 bg-accent-orange/15 text-accent-orange">
                                Built-in updated — click &quot;Use Built-In&quot; to apply
                              </span>
                            )}
                          </div>
                          <p className="mt-1 max-w-[62ch] panel-desc">
                            Shared same-agent specialist mode used through <code>delegate_task</code>.
                          </p>
                        </div>

                        <div className="space-y-4">
                          <label className="space-y-1.5">
                            <span className="panel-label text-muted-foreground">Description</span>
                            <input
                              value={specialist.description}
                              onChange={(event) => updateSpecialist(specialist.name, (current) => ({ ...current, description: event.target.value }))}
                              className={inputClassName}
                            />
                          </label>
                        <label className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <span className="panel-label text-muted-foreground">Instructions</span>
                            <button
                              type="button"
                              onClick={() => togglePreview(specialist.name)}
                              className="panel-badge inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/30 transition-colors"
                            >
                              {previewNames.has(specialist.name) ? <EyeOff size={10} /> : <Eye size={10} />}
                              {previewNames.has(specialist.name) ? "Edit" : "Preview"}
                            </button>
                          </div>
                          {previewNames.has(specialist.name) ? (
                            <div className={previewClassName}>
                              <ReactMarkdown>{specialist.instructions}</ReactMarkdown>
                            </div>
                          ) : (
                            <textarea
                              value={specialist.instructions}
                              onChange={(event) => updateSpecialist(specialist.name, (current) => ({ ...current, instructions: event.target.value }))}
                              rows={6}
                              className={`${inputClassName} font-mono-tech`}
                            />
                          )}
                        </label>
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                          <label className="space-y-1.5">
                            <span className="panel-label text-muted-foreground">When To Use</span>
                            <textarea
                              value={specialist.whenToUseText}
                              onChange={(event) => updateSpecialist(specialist.name, (current) => ({ ...current, whenToUseText: event.target.value }))}
                              rows={3}
                              placeholder="One trigger per line"
                              className={inputClassName}
                            />
                          </label>
                          <label className="space-y-1.5">
                            <span className="panel-label text-muted-foreground">Suggested Tools</span>
                            <textarea
                              value={specialist.suggestedToolsText}
                              onChange={(event) => updateSpecialist(specialist.name, (current) => ({ ...current, suggestedToolsText: event.target.value }))}
                              rows={3}
                              placeholder="One tool name per line"
                              className={inputClassName}
                            />
                          </label>
                        </div>
                      </div>
                    </div>
                      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 bg-card-3/30 px-4 py-3">
                        <button
                          type="button"
                          onClick={() => void saveSpecialist(specialist, false)}
                          disabled={isSaving || !specialist.id}
                          className="panel-badge inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/30 disabled:opacity-50 transition-colors"
                        >
                          <RotateCcw size={11} />
                          Use Built-In
                        </button>
                        <button
                          type="button"
                          onClick={() => void saveSpecialist(specialist, true)}
                          disabled={isSaving}
                          className="inline-flex items-center gap-1.5 rounded bg-accent-orange px-3 py-1.5 font-mono-tech text-[10px] font-semibold uppercase tracking-[0.12em] text-white hover:bg-accent-orange/80 disabled:opacity-50 transition-colors"
                        >
                          {isSaving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
                          {isSaving ? "Saving" : "Save Override"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="analytics-panel rounded-lg p-5">
              <div className="flex items-start gap-3 pb-4">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent-purple/15 text-accent-purple">
                  <Bot size={14} />
                </div>
                <div>
                  <h2 className="panel-title">Custom Specialists</h2>
                  <p className="panel-desc mt-0.5">
                    Specialists you define. They are stored as <code>AgentSkill</code> rows and injected into the main agent catalog.
                  </p>
                </div>
              </div>
              <div className="space-y-3">
                {customSpecialists.length === 0 ? (
                  <div className="panel-card rounded border-dashed px-4 py-8 text-center font-mono-tech text-[10px] text-muted-foreground">
                    No custom specialists yet. Add one to create a new same-agent skill mode the main agent can activate with <code>delegate_task</code>.
                  </div>
                ) : customSpecialists.map((specialist) => {
                  const isSaving = savingNames.includes(specialist.name.trim());
                  return (
                    <div key={specialist.name} className="panel-card rounded p-4 space-y-4">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="font-mono-tech text-[11px] font-semibold text-foreground">{specialist.name || "New Specialist"}</h3>
                            <span className={`panel-badge ${specialist.enabled ? "border-accent-green/30 bg-accent-green/15 text-accent-green" : "border-accent-red/30 bg-accent-red/15 text-accent-red"}`}>
                              {specialist.enabled ? "Enabled" : "Disabled"}
                            </span>
                          </div>
                          <p className="mt-1 max-w-[62ch] panel-desc">
                            Custom specialists are stored in <code>AgentSkill</code> and injected into the main agent catalog.
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => void saveSpecialist(specialist, true)}
                            disabled={isSaving}
                            className="inline-flex items-center gap-1.5 rounded bg-accent-orange px-3 py-1.5 font-mono-tech text-[10px] font-semibold uppercase tracking-[0.12em] text-white hover:bg-accent-orange/80 disabled:opacity-50 transition-colors"
                          >
                            {isSaving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
                            {isSaving ? "Saving" : specialist.id ? "Save" : "Create"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void saveSpecialist(specialist, false)}
                            disabled={isSaving || !specialist.id}
                            className="panel-badge inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/30 disabled:opacity-50 transition-colors"
                          >
                            <RotateCcw size={11} />
                            Disable
                          </button>
                        </div>
                      </div>

                      <div className="space-y-4">
                        <label className="space-y-1.5">
                          <span className="panel-label text-muted-foreground">Name</span>
                          <input
                            value={specialist.name}
                            onChange={(event) => updateSpecialist(specialist.name, (current) => ({ ...current, name: event.target.value }))}
                            className={inputClassName}
                          />
                        </label>
                        <label className="space-y-1.5">
                          <span className="panel-label text-muted-foreground">Description</span>
                          <input
                            value={specialist.description}
                            onChange={(event) => updateSpecialist(specialist.name, (current) => ({ ...current, description: event.target.value }))}
                            className={inputClassName}
                          />
                        </label>
                        <label className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <span className="panel-label text-muted-foreground">Instructions</span>
                            <button
                              type="button"
                              onClick={() => togglePreview(specialist.name)}
                              className="panel-badge inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/30 transition-colors"
                            >
                              {previewNames.has(specialist.name) ? <EyeOff size={10} /> : <Eye size={10} />}
                              {previewNames.has(specialist.name) ? "Edit" : "Preview"}
                            </button>
                          </div>
                          {previewNames.has(specialist.name) ? (
                            <div className={previewClassName}>
                              <ReactMarkdown>{specialist.instructions}</ReactMarkdown>
                            </div>
                          ) : (
                            <textarea
                              value={specialist.instructions}
                              onChange={(event) => updateSpecialist(specialist.name, (current) => ({ ...current, instructions: event.target.value }))}
                              rows={6}
                              className={`${inputClassName} font-mono-tech`}
                            />
                          )}
                        </label>
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                          <label className="space-y-1.5">
                            <span className="panel-label text-muted-foreground">When To Use</span>
                            <textarea
                              value={specialist.whenToUseText}
                              onChange={(event) => updateSpecialist(specialist.name, (current) => ({ ...current, whenToUseText: event.target.value }))}
                              rows={3}
                              placeholder="One trigger per line"
                              className={inputClassName}
                            />
                          </label>
                          <label className="space-y-1.5">
                            <span className="panel-label text-muted-foreground">Suggested Tools</span>
                            <textarea
                              value={specialist.suggestedToolsText}
                              onChange={(event) => updateSpecialist(specialist.name, (current) => ({ ...current, suggestedToolsText: event.target.value }))}
                              rows={3}
                              placeholder="One tool name per line"
                              className={inputClassName}
                            />
                          </label>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 bg-card-3/30 px-4 py-3">
                        <button
                          type="button"
                          onClick={() => void saveSpecialist(specialist, false)}
                          disabled={isSaving || !specialist.id}
                          className="panel-badge inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/30 disabled:opacity-50 transition-colors"
                        >
                          <RotateCcw size={11} />
                          Disable
                        </button>
                        <button
                          type="button"
                          onClick={() => void saveSpecialist(specialist, true)}
                          disabled={isSaving}
                          className="inline-flex items-center gap-1.5 rounded bg-accent-orange px-3 py-1.5 font-mono-tech text-[10px] font-semibold uppercase tracking-[0.12em] text-white hover:bg-accent-orange/80 disabled:opacity-50 transition-colors"
                        >
                          {isSaving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
                          {isSaving ? "Saving" : specialist.id ? "Save" : "Create"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </>
        )}
      </div>
      <div
        className="sticky bottom-[-20px] z-10 w-full h-12 pointer-events-none"
        style={{ backgroundImage: "linear-gradient(to top, var(--fade-tint-strong), transparent)" }}
      />
    </div>
  );
};
