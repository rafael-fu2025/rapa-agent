import { Check, Eye, ListTodo, ShieldCheck, Zap } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Hint } from "./ui/tooltip";
import { cn } from "../../lib/utils";

/** Composer permission ladder — ZCode/Claude-Code style. "plan" mirrors the
 *  interaction-mode toggle (read-only planning); the other three scale how
 *  much the agent may do without confirmation. The server keeps two
 *  non-bypassable guardrails in every mode: the dangerous-command severity
 *  overlay and the destructive/irreversible gate. */
export type SelectorPermissionMode = "plan" | "ask" | "autonomous" | "full";

type ModeDef = {
  value: SelectorPermissionMode;
  label: string;
  description: string;
  icon: typeof Eye;
};

const MODES: ModeDef[] = [
  { value: "plan", label: "Plan mode", description: "Plan before editing.", icon: ListTodo },
  { value: "ask", label: "Ask before changes", description: "Ask before file changes.", icon: Eye },
  { value: "autonomous", label: "Autonomous mode", description: "Auto-approve file changes.", icon: ShieldCheck },
  { value: "full", label: "Full access", description: "Run with fewer confirmations.", icon: Zap }
];

export function permissionModeLabel(value: SelectorPermissionMode): string {
  return MODES.find((m) => m.value === value)?.label ?? "Ask before changes";
}

export function PermissionModeSelector({
  value,
  onChange
}: {
  value: SelectorPermissionMode;
  onChange: (next: SelectorPermissionMode) => void;
}) {
  const active = MODES.find((m) => m.value === value) ?? MODES[1];
  const ActiveIcon = active.icon;

  return (
    <DropdownMenu>
      <Hint label="Permission mode">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded px-2 text-[10px] font-sans text-muted-foreground transition-colors",
              "hover:bg-accent hover:text-foreground focus:outline-none"
            )}
          >
            <ActiveIcon size={12} className={cn(value === "full" && "text-accent-orange", value === "autonomous" && "text-accent-blue")} />
            <span className="max-w-[110px] truncate">{active.label}</span>
          </button>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="start" className="w-64">
        {MODES.map((mode) => {
          const Icon = mode.icon;
          const selected = mode.value === value;
          return (
            <DropdownMenuItem
              key={mode.value}
              onSelect={() => onChange(mode.value)}
              className="gap-2.5"
            >
              <Icon size={13} className={cn("shrink-0 mt-0.5", selected ? "text-foreground" : "text-muted-foreground")} />
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] font-medium text-foreground">{mode.label}</span>
                <span className="block text-[10px] text-muted-foreground">{mode.description}</span>
              </span>
              {selected && <Check size={13} className="shrink-0 text-accent-green" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
