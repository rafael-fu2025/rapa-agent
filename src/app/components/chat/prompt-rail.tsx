import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../types/chat";
import { cn } from "../../../lib/utils";

/** Scroll the chat to a message and flash-highlight it. */
function scrollToMessageElement(messageId: string): void {
  const el = document.querySelector(`[data-message-id="${messageId}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("message-highlight-flash");
  window.setTimeout(() => el.classList.remove("message-highlight-flash"), 2400);
}

/** ZCode-style prompt timeline rail: pinned to the left edge of the chat,
 *  one tick per user prompt at a fixed compact rhythm. Hovering a tick
 *  elongates and brightens it, and opens a floating preview dialog anchored
 *  consistently to the right of the rail, vertically centered on the tick.
 *  Clicking navigates to that exchange with a flash-highlight.
 *
 * Hit-testing: the rail renders as a sibling BEFORE the scroll container in
 * DOM order, so the container would paint over it and swallow every pointer
 * event — the rail lifts itself with z-20 and keeps its own strip
 * pointer-events-none (only the tick buttons and the preview card take
 * hits), so message text selection beside it is unaffected. */
export function PromptRail({
  messages,
  bottomOffset
}: {
  messages: ChatMessage[];
  bottomOffset: number;
}) {
  const prompts = messages.filter((m) => m.role === "user");
  const railRef = useRef<HTMLDivElement>(null);
  const clearHoverTimer = useRef<number | undefined>(undefined);
  const [hovered, setHovered] = useState<{ index: number; top: number } | null>(null);

  // The preview card is unmounted when the rail itself unmounts.
  useEffect(() => () => window.clearTimeout(clearHoverTimer.current), []);

  const scheduleClear = () => {
    window.clearTimeout(clearHoverTimer.current);
    clearHoverTimer.current = window.setTimeout(() => setHovered(null), 180);
  };
  const cancelClear = () => window.clearTimeout(clearHoverTimer.current);

  const handleHover = (index: number, el: HTMLElement) => {
    cancelClear();
    const railRect = railRef.current?.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    if (!railRect) return;
    setHovered({ index, top: rect.top - railRect.top + rect.height / 2 });
  };

  if (prompts.length === 0) return null;

  return (
    <div
      ref={railRef}
      aria-label="Prompt timeline"
      className="pointer-events-none absolute left-0.5 z-20 w-3.5"
      style={{ top: 12, bottom: bottomOffset }}
    >
      {prompts.map((message, index) => {
        const isHovered = hovered?.index === index;
        return (
          <button
            key={message.id}
            type="button"
            aria-label={`Go to prompt ${index + 1} of ${prompts.length}`}
            className="pointer-events-auto group/tick relative flex h-[60px] w-3.5 items-center"
            onMouseEnter={(e) => handleHover(index, e.currentTarget)}
            onFocus={(e) => handleHover(index, e.currentTarget)}
            onMouseLeave={scheduleClear}
            onClick={() => scrollToMessageElement(message.id)}
          >
            {/* Tick on the rail — elongates and brightens on hover */}
            <span
              aria-hidden
              className={cn(
                "h-px transition-all duration-150",
                isHovered
                  ? "w-4 bg-foreground"
                  : "w-2.5 bg-muted-foreground/35 group-hover/tick:w-4 group-hover/tick:bg-muted-foreground/70"
              )}
            />
          </button>
        );
      })}

      {/* Floating preview dialog — anchored to the right of the rail,
          vertically centered on the hovered tick. Stays open while the
          pointer moves into it (180ms clear delay). */}
      {hovered && prompts[hovered.index] && (
        <button
          type="button"
          onClick={() => {
            window.clearTimeout(clearHoverTimer.current);
            scrollToMessageElement(prompts[hovered.index].id);
            setHovered(null);
          }}
          onMouseEnter={cancelClear}
          onMouseLeave={scheduleClear}
          className={cn(
            "pointer-events-auto absolute left-6 z-30 w-72 -translate-y-1/2 rounded-lg px-3 py-2.5 text-left",
            "border border-border/60 bg-popover shadow-xl",
            "cursor-pointer transition-colors hover:border-ring/60"
          )}
          style={{ top: hovered.top }}
        >
          <p className="whitespace-pre-wrap text-[11px] leading-[1.6] text-popover-foreground">
            {prompts[hovered.index].content.replace(/\s+/g, " ").trim().slice(0, 320) || "(empty prompt)"}
          </p>
        </button>
      )}
    </div>
  );
}
