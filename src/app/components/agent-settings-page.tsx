import { Boxes, BrainCircuit, GitBranch, ShieldCheck, SlidersHorizontal, Sparkles } from "lucide-react";
import { useAgentSettings, type SandboxMode } from "../../lib/agent-settings";
import { AgentSettingsPanel } from "./agent-settings-panel";
import { AutoApprovePatternsSection } from "./auto-approve-patterns-section";
import { Input } from "./ui/input";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { Switch } from "./ui/switch";
import { cn } from "../../lib/utils";

const SANDBOX_OPTIONS: Array<{ id: SandboxMode; label: string; description: string }> = [
  { id: "native", label: "Native", description: "Commands run on the host with the privilege-escalation blocklist enforced." },
  { id: "docker", label: "Docker", description: "Commands additionally run inside an ephemeral, network-disabled container." },
  { id: "off", label: "Off", description: "No sandboxing — commands run on the host without restrictions." }
];

/* Item 3 — isolation settings (sandbox / classifier / worktree). Each
   section persists through the same localStorage-backed store the rest of
   Agent Settings uses, and rides the agent request payload from there. */
function AgentIsolationSections() {
  const {
    settings,
    setSandboxMode,
    setAutoApproveClassifier,
    setWorktree
  } = useAgentSettings();
  const classifier = settings.autoApproveClassifier;

  return (
    <>
      {/* Command sandbox */}
      <section className="analytics-panel rounded-lg p-5">
        <div className="flex items-start gap-3 pb-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent-blue/15 text-accent-blue">
            <Boxes size={14} />
          </div>
          <div>
            <h2 className="panel-title">Command Sandbox</h2>
            <p className="panel-desc mt-0.5">
              How shell commands issued by the agent are isolated from your machine.
            </p>
          </div>
        </div>
        <RadioGroup
          value={settings.sandboxMode}
          onValueChange={(value) => setSandboxMode(value as SandboxMode)}
          className="gap-1.5"
        >
          {SANDBOX_OPTIONS.map((option) => {
            const selected = settings.sandboxMode === option.id;
            return (
              <label
                key={option.id}
                data-testid={`sandbox-option-${option.id}`}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded border px-3 py-3 transition-colors",
                  selected
                    ? "border-accent-blue/30 bg-accent-blue/10"
                    : "border-border/60 bg-card-3/50 hover:bg-accent/30"
                )}
              >
                <RadioGroupItem value={option.id} className="mt-0.5 size-[14px]" />
                <div className="flex-1 min-w-0">
                  <div className="font-mono-tech text-[10px] font-semibold text-foreground">{option.label}</div>
                  <div className="mt-0.5 font-mono-tech text-[9px] leading-4 text-muted-foreground">{option.description}</div>
                </div>
              </label>
            );
          })}
        </RadioGroup>
      </section>

      {/* Auto-approve classifier */}
      <section className="analytics-panel rounded-lg p-5">
        <div className="flex items-start gap-3 pb-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent-purple/15 text-accent-purple">
            <BrainCircuit size={14} />
          </div>
          <div>
            <h2 className="panel-title">Auto-Approve Classifier</h2>
            <p className="panel-desc mt-0.5">
              Have an LLM classify shell commands approve/deny before they reach you. Destructive commands always require a human regardless.
            </p>
          </div>
        </div>
        <div className="flex items-center justify-between gap-4 panel-card rounded px-4 py-3.5">
          <div>
            <div className="font-mono-tech text-[10px] font-semibold text-foreground">LLM classifier</div>
            <div className="mt-0.5 font-mono-tech text-[9px] text-muted-foreground">
              Optional provider/model below overrides the server default.
            </div>
          </div>
          <Switch
            data-testid="classifier-toggle"
            checked={classifier.enabled}
            onCheckedChange={(checked) => setAutoApproveClassifier({ ...classifier, enabled: checked })}
          />
        </div>
        {classifier.enabled && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="panel-card rounded px-3 py-2.5">
              <span className="panel-label block text-muted-foreground">Provider</span>
              <Input
                data-testid="classifier-provider"
                value={classifier.provider ?? ""}
                placeholder="(server default)"
                onChange={(event) => setAutoApproveClassifier({ ...classifier, provider: event.target.value || undefined })}
                className="mt-1 h-7 border-border/40 bg-card text-[11px]"
              />
            </label>
            <label className="panel-card rounded px-3 py-2.5">
              <span className="panel-label block text-muted-foreground">Model</span>
              <Input
                data-testid="classifier-model"
                value={classifier.model ?? ""}
                placeholder="(provider default)"
                onChange={(event) => setAutoApproveClassifier({ ...classifier, model: event.target.value || undefined })}
                className="mt-1 h-7 border-border/40 bg-card text-[11px]"
              />
            </label>
          </div>
        )}
      </section>

      {/* Worktree isolation */}
      <section className="analytics-panel rounded-lg p-5">
        <div className="flex items-start gap-3 pb-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent-green/15 text-accent-green">
            <GitBranch size={14} />
          </div>
          <div>
            <h2 className="panel-title">Isolate Runs in a Git Worktree</h2>
            <p className="panel-desc mt-0.5">
              Each agent run works in its own git worktree and branch, leaving your checkout untouched. Merge or discard the branch from the run banner when the run ends. Git repositories only.
            </p>
          </div>
        </div>
        <div className="flex items-center justify-between gap-4 panel-card rounded px-4 py-3.5">
          <div>
            <div className="font-mono-tech text-[10px] font-semibold text-foreground">Worktree isolation</div>
            <div className="mt-0.5 font-mono-tech text-[9px] text-muted-foreground">
              Falls back to the original checkout for non-git workspaces.
            </div>
          </div>
          <Switch
            data-testid="worktree-toggle"
            checked={settings.worktree}
            onCheckedChange={setWorktree}
          />
        </div>
      </section>
    </>
  );
}

export function AgentSettingsPage() {
  const { settings, setMaxIterations, setAutoApproveCategories, setShowThinking } = useAgentSettings();

  return (
    <div className="sidebar-scroll flex-1 overflow-y-auto bg-app p-5 text-primary" data-density="comfortable">
      <div
        className="sticky top-[-20px] z-10 w-full h-12 pointer-events-none"
        style={{ backgroundImage: "linear-gradient(to bottom, var(--fade-tint-strong), transparent)" }}
      />
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="space-y-2">
          <div className="inline-flex h-9 w-9 items-center justify-center rounded bg-accent/50 border border-border/40 text-accent-foreground">
            <Sparkles size={16} />
          </div>
          <h1 className="font-mono-tech text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground">Agent Settings</h1>
          <p className="max-w-[65ch] font-mono-tech text-[10px] text-muted-foreground">
            Tune how autonomous runs behave, from iteration limits to approval defaults and live reasoning visibility.
          </p>
        </header>

        <div className="grid gap-4">
          <AgentSettingsPanel
            maxIterations={settings.maxIterations}
            onMaxIterationsChange={setMaxIterations}
            autoApproveCategories={settings.autoApproveCategories}
            onAutoApproveCategoriesChange={setAutoApproveCategories}
            showThinking={settings.showThinking}
            onShowThinkingChange={setShowThinking}
            icons={{
              iterations: <SlidersHorizontal size={14} />,
              approvals: <ShieldCheck size={14} />,
              thinking: <BrainCircuit size={14} />
            }}
          />
          <AgentIsolationSections />
          <AutoApprovePatternsSection />
        </div>
      </div>
      <div
        className="sticky bottom-[-20px] z-10 w-full h-12 pointer-events-none"
        style={{ backgroundImage: "linear-gradient(to top, var(--fade-tint-strong), transparent)" }}
      />
    </div>
  );
}
