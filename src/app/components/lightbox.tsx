import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";

/* Global image lightbox. Mounted once in routes.tsx Layout; markdown
   images (assistant-markdown) call open() on click. v1 covers a single
   image with zoom-on-click (contain ↔ cover); gallery/list navigation
   is deferred. */

type LightboxContextValue = {
  /** Open the fullscreen viewer for a single image source. */
  open: (src: string, alt?: string) => void;
};

const LightboxContext = createContext<LightboxContextValue | null>(null);

export function useLightbox(): LightboxContextValue {
  const ctx = useContext(LightboxContext);
  // Graceful no-op outside a provider (detached renders, tests) — the
  // triggering image simply keeps its default behavior.
  return ctx ?? { open: () => undefined };
}

type LightboxState = { src: string; alt: string } | null;

export function LightboxProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LightboxState>(null);
  const [zoomed, setZoomed] = useState(false);

  const open = useCallback((src: string, alt?: string) => {
    setState({ src, alt: alt ?? "" });
    setZoomed(false);
  }, []);

  const close = useCallback(() => setState(null), []);

  useEffect(() => {
    if (!state) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [state, close]);

  const value = useMemo(() => ({ open }), [open]);

  return (
    <LightboxContext.Provider value={value}>
      {children}
      {state
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-label={state.alt || "Image preview"}
              onClick={close}
              className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85"
            >
              <img
                src={state.src}
                alt={state.alt}
                onClick={(event) => {
                  event.stopPropagation();
                  setZoomed((prev) => !prev);
                }}
                className={cn(
                  zoomed
                    ? "h-full w-full cursor-zoom-out object-cover"
                    : "max-h-full max-w-full cursor-zoom-in object-contain"
                )}
              />
              <button
                type="button"
                aria-label="Close image preview"
                onClick={close}
                className="absolute top-4 right-4 rounded border border-white/20 bg-black/60 p-2 text-white/80 transition-colors hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>,
            document.body
          )
        : null}
    </LightboxContext.Provider>
  );
}
