import { ShieldAlert, AlertTriangle, CheckCircle, XCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { cn } from "../../lib/utils";

export type RiskLevel = "low" | "medium" | "high";

export type ToolApprovalDialogProps = {
  tool: {
    name: string;
    parameters: Record<string, unknown>;
  };
  riskLevel?: RiskLevel;
  onApprove: () => void;
  onDeny: () => void;
  open: boolean;
};

function getRiskConfig(riskLevel: RiskLevel) {
  // Strict B/W/grey palette. The risk level is communicated by
  // border weight + label weight, not by hue. Replacing the prior
  // red/amber/blue tints with a single grey-on-grey scale so colors
  // never "stick" once a tool is approved or denied.
  if (riskLevel === "high") {
    return {
      icon: AlertTriangle,
      label: "High Risk",
      iconWeight: "text-primary",
      // Solid border for high risk — strong visual weight without
      // introducing a hue.
      badgeClass: "border-card-strong bg-card-2 text-primary font-semibold",
      description: "This action may have significant consequences and cannot be easily undone.",
    };
  }
  if (riskLevel === "medium") {
    return {
      icon: ShieldAlert,
      label: "Medium Risk",
      iconWeight: "text-primary",
      badgeClass: "border-card-strong bg-card-2 text-primary",
      description: "This action requires your approval before proceeding.",
    };
  }
  return {
    icon: ShieldAlert,
    label: "Low Risk",
    iconWeight: "text-muted-foreground",
    badgeClass: "border-card-hover bg-card text-muted-foreground",
    description: "This action requires confirmation.",
  };
}

export function ToolApprovalDialog({
  tool,
  riskLevel = "medium",
  onApprove,
  onDeny,
  open,
}: ToolApprovalDialogProps) {
  const riskConfig = getRiskConfig(riskLevel);
  const RiskIcon = riskConfig.icon;
  const hasParameters = Object.keys(tool.parameters).length > 0;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onDeny()}>
      <DialogContent className="border-card-hover bg-app text-primary sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-3">
            {/* Risk icon — B/W/grey only. The risk level is signalled by the
                border weight (card-hover vs card-strong), not by a hue. */}
            <div
              className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border",
                riskLevel === "low"
                  ? "border-card-hover bg-card"
                  : "border-card-strong bg-card-2"
              )}
            >
              <RiskIcon className={cn("h-4.5 w-4.5", riskConfig.iconWeight)} />
            </div>
            <div>
              <DialogTitle className="text-primary text-[12px] font-bold">
                Tool Approval Required
              </DialogTitle>
              <DialogDescription className="mt-1 text-[11px] text-muted-foreground">
                {riskConfig.description}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Tool details */}
        <div className="mt-4 space-y-3">
          {/* Tool name and risk badge */}
          <div className="rounded-[10px] border border-card-hover bg-card-2 px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  Tool
                </span>
              </div>
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px] font-medium",
                  riskConfig.badgeClass
                )}
              >
                {riskConfig.label}
              </span>
            </div>
            <code className="mt-1.5 block text-[11px] font-medium text-primary">
              {tool.name}
            </code>
          </div>

          {/* Parameters */}
          {hasParameters && (
            <div className="rounded-[10px] border border-card-hover bg-card-2 px-3 py-2.5">
              <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Parameters
              </div>
              <pre className="mt-1.5 max-h-48 overflow-auto rounded-lg border border-card-hover bg-card p-2 text-[10px] leading-4 text-primary">
                {JSON.stringify(tool.parameters, null, 2)}
              </pre>
            </div>
          )}
        </div>

        <DialogFooter className="mt-5 gap-2 sm:gap-2">
          <Button
            variant="outline"
            onClick={onDeny}
            className="border-card-hover bg-card text-primary hover:bg-card-2 hover:text-primary text-[11px]"
          >
            <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
            Deny
          </Button>
          {/* Approve is the primary action — B/W/grey only. The risk
              level no longer drives the button color; the risk badge
              already conveys that. */}
          <Button
            onClick={onApprove}
            className="bg-primary text-app hover:opacity-90 text-[11px]"
          >
            <CheckCircle className="h-3.5 w-3.5" />
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
