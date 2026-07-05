// Agent mode toggle component

import { Switch } from "./ui/switch";
import { Label } from "./ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { Bot, MessageSquare } from "lucide-react";

type AgentModeToggleProps = {
  isAgentMode: boolean;
  onToggle: (enabled: boolean) => void;
};

export function AgentModeToggle({ isAgentMode, onToggle }: AgentModeToggleProps) {
  return (
    <TooltipProvider>
      <div className="flex items-center gap-2 px-3 py-2 border border-card-hover rounded-lg bg-card">
        <MessageSquare className="w-4 h-4 text-muted-foreground" />
        <Switch
          checked={isAgentMode}
          onCheckedChange={onToggle}
          className="data-[state=checked]:bg-primary data-[state=unchecked]:bg-card-hover"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-2 cursor-help">
              <Bot className={`w-4 h-4 ${isAgentMode ? "text-primary" : "text-muted-foreground"}`} />
              <Label className="text-sm cursor-pointer text-primary">
                {isAgentMode ? "Agent Mode" : "Chat Mode"}
              </Label>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <p className="max-w-xs">
              {isAgentMode
                ? "Agent mode: AI can use tools to read files, execute commands, and perform actions"
                : "Chat mode: Simple conversation without tool access"}
            </p>
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
