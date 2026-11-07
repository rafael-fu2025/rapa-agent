// Mermaid diagram renderer for fenced ```mermaid code blocks.
//
// The mermaid bundle is large, so this component is loaded lazily via
// React.lazy from assistant-markdown and the library itself is only
// pulled (dynamic import) when a diagram actually appears in a response.

import { useEffect, useId, useRef, useState } from "react";

type MermaidBlockProps = {
  code: string;
  theme: "light" | "dark";
};

export function MermaidBlock({ code, theme }: MermaidBlockProps) {
  const rawId = useId();
  // useId yields ids containing colons (e.g. ":r0:") — mermaid puts the id
  // into DOM elements and internal selectors, so sanitize to a safe form.
  const safeId = `mermaid-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  // Each render attempt gets a fresh id: reusing an id across attempts can
  // collide with a leftover temp element from a cancelled render.
  const attemptRef = useRef(0);
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const renderId = `${safeId}-${++attemptRef.current}`;

    const render = async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: theme === "dark" ? "dark" : "default",
          securityLevel: "strict"
        });
        const { svg: rendered } = await mermaid.render(renderId, code);
        if (!cancelled) {
          setSvg(rendered);
          setFailed(false);
        }
      } catch {
        // Parse error, unsupported diagram, or a rendering environment
        // without SVG measurement (e.g. jsdom) — degrade to source view.
        if (!cancelled) {
          setSvg(null);
          setFailed(true);
        }
      }
    };

    void render();
    return () => {
      cancelled = true;
    };
  }, [code, theme, safeId]);

  if (failed) {
    return (
      <div
        data-testid="mermaid-fallback"
        className="mb-3 overflow-hidden rounded border border-accent-red/30 bg-card-3/40"
        style={{ backdropFilter: "blur(16px)" }}
      >
        <div className="border-b border-accent-red/20 bg-card-3/60 px-3 py-1.5 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-accent-red/80">
          diagram failed to render
        </div>
        <pre className="overflow-x-auto px-3 py-2.5 font-mono-tech text-[10px] leading-[1.6] text-muted-foreground">
          {code}
        </pre>
      </div>
    );
  }

  if (!svg) {
    // While parsing/rendering, show the source like a plain code block.
    return (
      <pre
        data-testid="mermaid-loading"
        className="mb-3 overflow-x-auto rounded border border-border/40 bg-card-3/40 px-3 py-2.5 font-mono-tech text-[10px] leading-[1.6] text-muted-foreground"
      >
        {code}
      </pre>
    );
  }

  return (
    <div
      data-testid="mermaid-diagram"
      className="mb-3 overflow-x-auto rounded border border-border/40 bg-card-3/40 p-3 [&_svg]:mx-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
