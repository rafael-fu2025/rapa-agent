import { Brain } from "lucide-react";
import { cn } from "../../lib/utils";

export type AgentThinkingIndicatorProps = {
  isThinking: boolean;
  reasoningText?: string;
  statusText?: string;
  className?: string;
};

export function AgentThinkingIndicator({
  isThinking,
  reasoningText,
  statusText,
  className,
}: AgentThinkingIndicatorProps) {
  if (!isThinking) return null;

  return (
    <div className={cn("analytics-panel rounded-lg overflow-hidden", className)}>
      <div className="flex items-start gap-3 px-4 py-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-accent-blue/15 text-accent-blue">
          <Brain className="h-3.5 w-3.5 animate-pulse" />
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1 space-y-2">
          {/* Status header */}
          <div className="flex items-center gap-2">
            <span className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-foreground">
              {statusText || "Thinking..."}
            </span>
            {/* Animated dots */}
            <span className="flex gap-0.5">
              <span className="h-1 w-1 rounded-full bg-accent-blue animate-bounce [animation-delay:0ms]" />
              <span className="h-1 w-1 rounded-full bg-accent-blue animate-bounce [animation-delay:150ms]" />
              <span className="h-1 w-1 rounded-full bg-accent-blue animate-bounce [animation-delay:300ms]" />
            </span>
          </div>

          {/* Streaming reasoning text */}
          {reasoningText && (
            <div className="panel-card rounded px-3 py-2">
              <p className="whitespace-pre-wrap break-words font-mono-tech text-[10px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                {reasoningText}
                {/* Blinking cursor for streaming effect */}
                <span className="ml-0.5 inline-block h-3 w-0.5 bg-accent-blue animate-pulse" />
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Bottom progress shimmer */}
      <div className="h-px w-full overflow-hidden bg-border/30">
        <div className="h-full w-1/3 animate-[shimmer_1.5s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-accent-blue/40 to-transparent" />
      </div>
    </div>
  );
}
