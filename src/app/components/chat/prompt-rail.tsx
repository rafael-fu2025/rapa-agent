import { Hint } from "../ui/tooltip";
import type { ChatMessage } from "../../types/chat";

/** Scroll the chat to a message and flash-highlight it. */
function scrollToMessageElement(messageId: string): void {
  const el = document.querySelector(`[data-message-id="${messageId}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("message-highlight-flash");
  window.setTimeout(() => el.classList.remove("message-highlight-flash"), 2400);
}

/** ZCode-style prompt timeline rail: pinned to the left edge of the chat,
 *  one tick per user prompt. Clicking a tick scrolls the conversation to
 *  that exchange; hovering previews the prompt text. */
export function PromptRail({
  messages,
  bottomOffset
}: {
  messages: ChatMessage[];
  bottomOffset: number;
}) {
  const prompts = messages.filter((m) => m.role === "user");
  if (prompts.length === 0) return null;

  return (
    <div
      aria-label="Prompt timeline"
      className="absolute left-0.5 flex w-3.5 flex-col items-start justify-evenly"
      style={{ top: 12, bottom: bottomOffset }}
    >
      {prompts.map((message) => (
        <Hint key={message.id} label={message.content.slice(0, 100)}>
          <button
            type="button"
            aria-label="Scroll to this prompt"
            onClick={() => scrollToMessageElement(message.id)}
            className="group/tick flex h-5 w-3.5 items-center"
          >
            <span
              aria-hidden
              className="h-px w-2.5 bg-muted-foreground/35 transition-colors group-hover/tick:bg-accent-blue"
            />
          </button>
        </Hint>
      ))}
    </div>
  );
}
