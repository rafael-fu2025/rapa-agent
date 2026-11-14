import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
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

/** ZCode-style prompt timeline rail — a scroll minimap pinned to the left
 *  edge of the chat: one faint tick per user prompt, positioned
 *  proportionally to where that prompt sits in the conversation scroll.
 *  The tick for the exchange currently in view renders as a long bright
 *  line; hovering any tick elongates it and opens the floating preview
 *  dialog; clicking scrolls to that exchange.
 *
 * Hit-testing: the rail renders as a sibling BEFORE the scroll container in
 * DOM order, so the container would paint over it and swallow every pointer
 * event — the rail lifts itself with z-20 and keeps its own strip
 * pointer-events-none (only the tick buttons and the preview dialog take
 * hits), so message text selection beside it is unaffected. */
export function PromptRail({
  messages,
  scrollRef,
  bottomOffset
}: {
  messages: ChatMessage[];
  scrollRef: RefObject<HTMLDivElement | null>;
  bottomOffset: number;
}) {
  const prompts = useMemo(() => messages.filter((m) => m.role === "user"), [messages]);
  const railRef = useRef<HTMLDivElement>(null);
  const clearHoverTimer = useRef<number | undefined>(undefined);
  const [hovered, setHovered] = useState<{ index: number; top: number } | null>(null);
  // Tick positions as fractions of the rail height (0 = top of the
  // conversation, 1 = bottom), and the fraction of the exchange currently
  // in view (drives the long bright tick).
  const [tickFractions, setTickFractions] = useState<number[]>([]);
  const [activeFraction, setActiveFraction] = useState<number | null>(null);

  const promptsKey = prompts.map((m) => m.id).join(",");

  const measure = useCallback(() => {
    const sc = scrollRef.current;
    if (!sc || prompts.length === 0) {
      setTickFractions([]);
      setActiveFraction(null);
      return;
    }
    const scRect = sc.getBoundingClientRect();
    const maxScroll = Math.max(1, sc.scrollHeight - sc.clientHeight);
    const viewCenter = sc.scrollTop + sc.clientHeight / 2;
    const fracs: number[] = [];
    let active: number | null = null;
    let activeDist = Number.POSITIVE_INFINITY;
    prompts.forEach((m) => {
      const el = sc.querySelector(`[data-message-id="${m.id}"]`);
      if (!el) {
        fracs.push(-1);
        return;
      }
      const rel = (el as HTMLElement).getBoundingClientRect().top - scRect.top + sc.scrollTop;
      const frac = Math.min(1, Math.max(0, rel / maxScroll));
      fracs.push(frac);
      const dist = Math.abs(rel - viewCenter);
      if (dist < activeDist) {
        activeDist = dist;
        active = frac;
      }
    });
    setTickFractions(fracs);
    setActiveFraction(active);
  }, [promptsKey, scrollRef]);

  // Re-measure when the message set changes, on scroll (the active tick
  // follows the view), and on resize (heights shift as markdown renders).
  useEffect(() => {
    measure();
    const sc = scrollRef.current;
    if (!sc) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      sc.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [measure, scrollRef]);

  // The preview dialog is unmounted when the rail itself unmounts.
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

  const railHeight = railRef.current?.getBoundingClientRect().height ?? 0;
  const tickTop = (frac: number) =>
    railHeight > 0 ? Math.min(railHeight - 2, Math.max(1, frac * railHeight)) : 1;

  return (
    <div
      ref={railRef}
      aria-label="Prompt timeline"
      className="pointer-events-none absolute left-0.5 z-20 w-3.5"
      style={{ top: 12, bottom: bottomOffset }}
    >
      {prompts.map((message, index) => {
        const frac = tickFractions[index];
        if (frac === undefined || frac < 0) return null;
        const isHovered = hovered?.index === index;
        const isActive = !isHovered && activeFraction !== null && Math.abs(activeFraction - frac) < 0.02;
        const isLong = isHovered || isActive;
        return (
          <button
            key={message.id}
            type="button"
            aria-label={`Go to prompt ${index + 1} of ${prompts.length}`}
            className={cn(
              "pointer-events-auto group/tick absolute left-0 flex h-5 w-3.5 -translate-y-1/2 items-center",
              isLong ? "z-10" : "z-0"
            )}
            style={{ top: tickTop(frac) }}
            onMouseEnter={(e) => handleHover(index, e.currentTarget)}
            onFocus={(e) => handleHover(index, e.currentTarget)}
            onMouseLeave={scheduleClear}
            onClick={() => scrollToMessageElement(message.id)}
          >
            {/* The active tick is a long bright line; idle ticks are short
                and faint — both centered on the rail. */}
            <span
              aria-hidden
              className={cn(
                "h-[2px] rounded-full transition-all duration-150",
                isLong ? "w-4 bg-foreground" : "w-2.5 bg-muted-foreground/45 group-hover/tick:w-4 group-hover/tick:bg-muted-foreground/80"
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
