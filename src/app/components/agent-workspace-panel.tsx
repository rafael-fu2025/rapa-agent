import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";

export type AgentWorkspacePanelProps = {
  title: string;
  description?: string;
  icon: LucideIcon;
  badge?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  contentClassName?: string;
  children: ReactNode;
};

export function AgentWorkspacePanel({
  title,
  description,
  icon: Icon,
  badge,
  defaultOpen = true,
  open,
  onOpenChange,
  className,
  contentClassName,
  children
}: AgentWorkspacePanelProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isOpen = open ?? internalOpen;
  const setOpen = useMemo(
    () => onOpenChange ?? setInternalOpen,
    [onOpenChange]
  );

  return (
    <Collapsible open={isOpen} onOpenChange={setOpen} className={cn("overflow-hidden rounded-2xl border border-border bg-card", className)}>
      <CollapsibleTrigger className="w-full cursor-pointer text-left">
        <div className="group flex w-full items-start gap-3 border-b border-card-hover bg-card px-4 py-3.5 transition-colors hover:bg-card-2">
          {/* B/W/grey icon tile — replaces the prior blue-tinted tile so
              colors never stick once the user has interacted with a panel. */}
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-card-strong bg-card-2 text-primary">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-primary">{title}</span>
              {badge ? (
                <span className="rounded-full border border-card-strong bg-card-2 px-2 py-0.5 text-[11px] font-medium text-primary">
                  {badge}
                </span>
              ) : null}
            </div>
            {description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p> : null}
          </div>
          <div className="mt-1 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-0">
            {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent className={cn("px-4 pb-4 pt-3", contentClassName)}>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
