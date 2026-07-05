"use client";

import { Bot, MessageSquare, Sparkles } from "lucide-react";

export function ModeSwitchPrompt({
  targetMode,
  prompt,
  sourceConversationId,
  approveLabel,
  cancelLabel,
  onApprove,
  onStayInChat
}: {
  targetMode: "agent" | "plan";
  prompt: string;
  sourceConversationId?: string;
  approveLabel?: string;
  cancelLabel?: string;
  onApprove: (targetMode: "agent" | "plan", prompt: string, sourceConversationId?: string) => void;
  onStayInChat?: () => void;
}) {
  const modeLabel = targetMode === "plan" ? "plan" : "agent";

  return (
    <section className="my-2 overflow-hidden rounded-lg border border-border/40 bg-card-3/40" style={{ backdropFilter: "blur(16px)" }}>
      {/* Header */}
      <div className="flex items-center gap-2.5 border-b border-border/30 px-3 py-2">
        <div className={`flex h-5 w-5 items-center justify-center rounded ${targetMode === "plan" ? "bg-accent-purple/15 text-accent-purple" : "bg-accent-blue/15 text-accent-blue"}`}>
          <Sparkles size={11} />
        </div>
        <span className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          mode switch → {modeLabel}
        </span>
      </div>

      {/* Body */}
      <div className="space-y-2.5 p-3">
        {/* Explanation */}
        <div className="flex items-start gap-2.5 rounded border border-border/30 bg-card/50 px-3 py-2.5">
          <Bot size={12} className="mt-0.5 shrink-0 text-muted-foreground/60" />
          <div className="min-w-0">
            <div className="font-mono-tech text-[10px] font-semibold text-foreground">
              This request is better handled in {modeLabel} mode.
            </div>
            <p className="mt-0.5 font-mono-tech text-[10px] leading-4 text-muted-foreground/60">
              Approve to switch modes and resend your request automatically.
            </p>
          </div>
        </div>

        {/* Original request */}
        <div className="rounded border border-border/30 bg-card/50 px-3 py-2.5">
          <div className="mb-1.5 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/50">
            Original request
          </div>
          <div className="whitespace-pre-wrap font-mono-tech text-[10px] leading-5 text-foreground">
            {prompt}
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onStayInChat}
            className="inline-flex items-center justify-center gap-2 rounded border border-border/40 bg-card-3/50 px-3 py-1.5 font-mono-tech text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:border-border hover:text-foreground"
          >
            <MessageSquare size={11} />
            {cancelLabel ?? "Stay in Chat"}
          </button>
          <button
            type="button"
            onClick={() => onApprove(targetMode, prompt, sourceConversationId)}
            className="inline-flex items-center justify-center gap-2 rounded bg-accent-orange hover:bg-accent-orange/80 px-3 py-1.5 font-mono-tech text-[10px] font-semibold uppercase tracking-[0.12em] text-white transition-opacity"
          >
            <Bot size={11} />
            {approveLabel ?? `Switch to ${modeLabel}`}
          </button>
        </div>
      </div>
    </section>
  );
}
