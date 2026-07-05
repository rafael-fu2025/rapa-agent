import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { MAX_AGENT_ITERATIONS } from "../../lib/agent-settings";
import { Switch } from "./ui/switch";
import { Checkbox } from "./ui/checkbox";

export type AgentSettingsPanelProps = {
  maxIterations: number;
  onMaxIterationsChange: (value: number) => void;
  autoApproveCategories: string[];
  onAutoApproveCategoriesChange: (categories: string[]) => void;
  showThinking?: boolean;
  onShowThinkingChange?: (value: boolean) => void;
  icons?: {
    iterations?: ReactNode;
    approvals?: ReactNode;
    thinking?: ReactNode;
  };
  className?: string;
};

const TOOL_CATEGORIES = [
  { id: "filesystem", label: "Filesystem", description: "Read, write, and manage files" },
  { id: "shell", label: "Shell", description: "Execute terminal commands" },
  { id: "web", label: "Web", description: "Make HTTP requests and browse" },
  { id: "system", label: "System", description: "System operations and info" },
  { id: "code", label: "Code", description: "Code analysis and generation" }
] as const;

export function AgentSettingsPanel({
  maxIterations,
  onMaxIterationsChange,
  autoApproveCategories,
  onAutoApproveCategoriesChange,
  showThinking = true,
  onShowThinkingChange,
  icons,
  className
}: AgentSettingsPanelProps) {
  const handleCategoryToggle = (categoryId: string, checked: boolean) => {
    if (checked) {
      onAutoApproveCategoriesChange([...autoApproveCategories, categoryId]);
    } else {
      onAutoApproveCategoriesChange(autoApproveCategories.filter((c) => c !== categoryId));
    }
  };

  return (
    <div className={cn("space-y-4", className)}>
      {/* Max Iterations Setting */}
      <section className="analytics-panel rounded-lg p-5">
        <div className="flex items-start gap-3 pb-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent-blue/15 text-accent-blue">
            {icons?.iterations}
          </div>
          <div>
            <h2 className="panel-title">Maximum Iterations</h2>
            <p className="panel-desc mt-0.5">
              Controls how long the agent can keep working on larger requests.
            </p>
          </div>
        </div>
        <div className="panel-card rounded px-4 py-4">
          <div className="mb-3 flex items-center justify-between gap-4">
            <div className="panel-label text-muted-foreground">Iteration limit</div>
            <div className="panel-badge">{maxIterations}</div>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="w-3 font-mono-tech text-[9px] text-muted-foreground">1</span>
            <input
              type="range"
              min={1}
              max={MAX_AGENT_ITERATIONS}
              value={maxIterations}
              onChange={(e) => onMaxIterationsChange(Number(e.target.value))}
              className={cn(
                "h-3.5 w-full cursor-pointer appearance-none rounded-full bg-transparent",
                "[&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-muted",
                "[&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-muted [&::-moz-range-track]:border-0",
                "[&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent-orange [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:mt-[-4px] [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:hover:scale-110",
                "[&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-accent-orange [&::-moz-range-thumb]:shadow-sm"
              )}
            />
            <span className="w-5 text-right font-mono-tech text-[9px] text-muted-foreground">{MAX_AGENT_ITERATIONS}</span>
          </div>
        </div>
      </section>

      {/* Auto-Approve Tool Categories */}
      <section className="analytics-panel rounded-lg p-5">
        <div className="flex items-start gap-3 pb-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent-green/15 text-accent-green">
            {icons?.approvals}
          </div>
          <div>
            <h2 className="panel-title">Auto-Approve Tools</h2>
            <p className="panel-desc mt-0.5">
              Pick which tool categories can run without asking for confirmation.
            </p>
          </div>
        </div>
        <div className="space-y-1.5">
          {TOOL_CATEGORIES.map((category) => {
            const isChecked = autoApproveCategories.includes(category.id);
            return (
              <label
                key={category.id}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded border px-3 py-3 transition-colors",
                  isChecked
                    ? "border-accent-green/30 bg-accent-green/10"
                    : "border-border/60 bg-card-3/50 hover:bg-accent/30"
                )}
              >
                <Checkbox
                  checked={isChecked}
                  onCheckedChange={(checked) => handleCategoryToggle(category.id, checked === true)}
                  className={cn(
                    "mt-0.5 size-[14px] border-border bg-background data-[state=checked]:border-foreground data-[state=checked]:bg-foreground data-[state=checked]:text-background"
                  )}
                />
                <div className="flex-1 min-w-0">
                  <div className="font-mono-tech text-[10px] font-semibold text-foreground">{category.label}</div>
                  <div className="mt-0.5 font-mono-tech text-[9px] leading-4 text-muted-foreground">{category.description}</div>
                </div>
              </label>
            );
          })}
        </div>
      </section>

      {/* Show Thinking Toggle */}
      <section className="analytics-panel rounded-lg p-5">
        <div className="flex items-start gap-3 pb-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent-purple/15 text-accent-purple">
            {icons?.thinking}
          </div>
          <div>
            <h2 className="panel-title">Show Thinking Process</h2>
            <p className="panel-desc mt-0.5">
              Display the agent&apos;s reasoning in real-time while it works.
            </p>
          </div>
        </div>
        <div className="flex items-center justify-between gap-4 panel-card rounded px-4 py-3.5">
          <div>
            <div className="font-mono-tech text-[10px] font-semibold text-foreground">Live reasoning</div>
            <div className="mt-0.5 font-mono-tech text-[9px] text-muted-foreground">
              Keep the thought stream visible during agent execution.
            </div>
          </div>
          <Switch
            checked={showThinking}
            onCheckedChange={onShowThinkingChange}
          />
        </div>
      </section>
    </div>
  );
}
