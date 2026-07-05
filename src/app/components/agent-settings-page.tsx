import { Brain, ShieldCheck, SlidersHorizontal, Sparkles } from "lucide-react";
import { useAgentSettings } from "../../lib/agent-settings";
import { AgentSettingsPanel } from "./agent-settings-panel";

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
              thinking: <Brain size={14} />
            }}
          />
        </div>
      </div>
      <div
        className="sticky bottom-[-20px] z-10 w-full h-12 pointer-events-none"
        style={{ backgroundImage: "linear-gradient(to top, var(--fade-tint-strong), transparent)" }}
      />
    </div>
  );
}
