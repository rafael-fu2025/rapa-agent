// Appearance settings page — controls the UI theme, accent color, and
// message-density. Persists each setting in localStorage and applies it
// immediately so changes are visible without a page reload.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, Monitor, Moon, Palette, Sparkles, Sun, Type } from "lucide-react";
import { toast } from "sonner";
import { useTheme, type ResolvedTheme, type ThemeMode } from "../hooks/use-theme";
import { Switch } from "./ui/switch";

const STORAGE_DENSITY = "rapa_density";
const STORAGE_ACCENT = "rapa_accent";
const STORAGE_FONT_SIZE = "rapa_font_size";

type Density = "comfortable" | "compact";
type FontSize = "small" | "medium" | "large";
type AccentColor = "indigo" | "blue" | "emerald" | "rose" | "amber" | "violet";

type AccentPreset = {
  id: AccentColor;
  label: string;
  /** Swatch color used for the picker dot. */
  hex: string;
  /** Preview text color when this accent is active. */
  textClass: string;
  /** Preview border color when this accent is active. */
  borderClass: string;
};

const ACCENTS: AccentPreset[] = [
  { id: "indigo",  label: "Indigo",  hex: "#6366F1", textClass: "text-[#6366F1]", borderClass: "border-[#6366F1]" },
  { id: "blue",    label: "Blue",    hex: "#3B82F6", textClass: "text-[#3B82F6]", borderClass: "border-[#3B82F6]" },
  { id: "emerald", label: "Emerald", hex: "#10B981", textClass: "text-[#10B981]", borderClass: "border-[#10B981]" },
  { id: "rose",    label: "Rose",    hex: "#F43F5E", textClass: "text-[#F43F5E]", borderClass: "border-[#F43F5E]" },
  { id: "amber",   label: "Amber",   hex: "#F59E0B", textClass: "text-[#F59E0B]", borderClass: "border-[#F59E0B]" },
  { id: "violet",  label: "Violet",  hex: "#8B5CF6", textClass: "text-[#8B5CF6]", borderClass: "border-[#8B5CF6]" }
];

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const v = window.localStorage.getItem(key);
    if (v && (allowed as readonly string[]).includes(v)) return v as T;
  } catch { /* ignore */ }
  return fallback;
}

function applyAccent(accent: AccentColor) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  // Wipe any previous custom accent properties.
  root.style.removeProperty("--accent-color");
  const preset = ACCENTS.find((a) => a.id === accent);
  if (preset) root.style.setProperty("--accent-color", preset.hex);
  root.dataset.accent = accent;
}

function applyFontSize(size: FontSize) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  // Map to a multiplier applied to the base 16px font size.
  const scale = size === "small" ? 0.9375 : size === "large" ? 1.0625 : 1;
  root.style.setProperty("--font-size-multiplier", String(scale));
  root.dataset.fontSize = size;
}

function applyDensity(density: Density) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.density = density;
  // Compact mode: tightening padding on message rows. The actual spacing is
  // picked up by the components that respect `data-density="compact"`.
  root.style.setProperty("--density-row-gap", density === "compact" ? "8px" : "16px");
}

/* ------------------------------------------------------------------ */
/* Sub-components                                                       */
/* ------------------------------------------------------------------ */

function SectionHeader({ icon, title, description, iconTint }: { icon: ReactNode; title: string; description: string; iconTint?: string }) {
  return (
    <div className="flex items-start gap-3 pb-4">
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-accent-blue"
        style={{ background: iconTint ?? "color-mix(in srgb, var(--accent-blue) 15%, transparent)" }}
      >
        {icon}
      </div>
      <div>
        <h2 className="panel-title">{title}</h2>
        <p className="panel-desc mt-0.5">{description}</p>
      </div>
    </div>
  );
}

function ThemePreview({ mode, active, onSelect }: { mode: ThemeMode; active: boolean; onSelect: () => void }) {
  const isLight = mode === "light";
  const isDark = mode === "dark";
  const label = isLight ? "Light" : isDark ? "Dark" : "System";
  const Icon = isLight ? Sun : isDark ? Moon : Monitor;

  // Each preview is a tiny mock of the chat surface.
  const previewBg = isLight ? "bg-white" : isDark ? "bg-[#0C0C0C]" : "bg-gradient-to-br from-white to-[#0C0C0C]";
  const previewText = isLight ? "text-zinc-800" : isDark ? "text-zinc-100" : "text-zinc-800";

  const accentStyle = active
    ? { borderColor: "var(--accent-color, #6366F1)", boxShadow: "0 0 0 1px var(--accent-color, #6366F1)" }
    : undefined;

  return (
    <button
      type="button"
      onClick={onSelect}
      style={accentStyle}
      className={
        "group relative flex flex-col items-stretch gap-3 rounded border p-4 text-left transition-all " +
        (active
          ? "bg-accent/30"
          : "border-border/60 bg-card-3/50 hover:border-muted-foreground/40 hover:bg-accent/20")
      }
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon size={14} className={active ? "text-foreground" : "text-muted-foreground"} />
          <span className={"font-mono-tech text-[10px] font-semibold " + (active ? "text-foreground" : "text-foreground/80")}>
            {label}
          </span>
        </div>
        {active && (
          <span
            className="flex h-4 w-4 items-center justify-center rounded-full text-white"
            style={{ backgroundColor: "var(--accent-color, #6366F1)" }}
          >
            <Check size={9} strokeWidth={3} />
          </span>
        )}
      </div>

      <div
        className={"overflow-hidden rounded border " + (active ? "" : "border-border/60")}
        style={active ? { borderColor: "var(--accent-color, #6366F1)" } : undefined}
      >
        <div className={"flex items-center gap-1.5 border-b border-border/60 px-2 py-1.5 " + (isLight ? "bg-zinc-50" : "bg-zinc-900")}>
          <div className="h-1.5 w-1.5 rounded-full bg-rose-400/70" />
          <div className="h-1.5 w-1.5 rounded-full bg-amber-400/70" />
          <div className="h-1.5 w-1.5 rounded-full bg-emerald-400/70" />
        </div>
        <div className={"p-2.5 " + previewBg + " " + previewText}>
          <div className="mb-1.5 flex justify-end">
            <div className={"rounded px-2 py-1 text-[8px] " + (isLight ? "bg-zinc-100" : "bg-zinc-800")}>
              Hello there
            </div>
          </div>
          <div className="flex">
            <div className={"rounded px-2 py-1 text-[8px] " + (isLight ? "bg-indigo-100 text-indigo-900" : "bg-indigo-500/20 text-indigo-200")}>
              Hi! How can I help?
            </div>
          </div>
        </div>
      </div>
    </button>
  );
}

function AccentSwatch({ accent, active, onSelect }: { accent: AccentPreset; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={
        "group relative flex h-12 w-full items-center justify-center rounded border transition-all " +
        (active ? "border-foreground/60 bg-card-3" : "border-border/40 bg-card-3/30 hover:border-muted-foreground/30")
      }
      title={accent.label}
      aria-label={accent.label}
    >
      <span
        className="h-6 w-6 rounded-full shadow-sm transition-transform group-hover:scale-110"
        style={{ backgroundColor: accent.hex }}
      />
      {active && (
        <span
          className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full text-white"
          style={{ backgroundColor: accent.hex }}
        >
          <Check size={10} strokeWidth={3} />
        </span>
      )}
    </button>
  );
}

function Toggle({ checked, onChange, label, description }: { checked: boolean; onChange: (next: boolean) => void; label: string; description: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 rounded panel-card px-4 py-3 transition-colors hover:bg-accent/30">
      <div>
        <div className="font-mono-tech text-[10px] font-semibold text-foreground">{label}</div>
        <div className="font-mono-tech text-[9px] text-muted-foreground">{description}</div>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
      />
    </label>
  );
}

function FontSizeOption({ size, active, onSelect }: { size: FontSize; active: boolean; onSelect: () => void }) {
  const label = size === "small" ? "Small" : size === "medium" ? "Medium" : "Large";
  const sample = size === "small" ? "text-[12px]" : size === "medium" ? "text-[14px]" : "text-[16px]";
  return (
    <button
      type="button"
      onClick={onSelect}
      style={active ? { borderColor: "var(--accent-color, #6366F1)" } : undefined}
      className={
        "flex flex-col items-start gap-1 rounded border px-4 py-3 text-left transition-colors " +
        (active
          ? "bg-accent/30"
          : "border-border/60 bg-card-3/50 hover:bg-accent/20")
      }
    >
      <div className="flex w-full items-center justify-between">
        <span className="font-mono-tech text-[10px] font-semibold text-foreground">{label}</span>
        {active && (
          <span
            className="flex h-4 w-4 items-center justify-center rounded-full text-white"
            style={{ backgroundColor: "var(--accent-color, #6366F1)" }}
          >
            <Check size={10} strokeWidth={3} />
          </span>
        )}
      </div>
      <span className={"text-foreground/70 " + sample}>The quick brown fox</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Main page                                                            */
/* ------------------------------------------------------------------ */

export const AppearancePage = () => {
  const theme = useTheme();
  const [density, setDensity] = useState<Density>(() => readStored<Density>(STORAGE_DENSITY, ["comfortable", "compact"] as const, "comfortable"));
  const [accent, setAccent] = useState<AccentColor>(() => readStored<AccentColor>(STORAGE_ACCENT, ["indigo", "blue", "emerald", "rose", "amber", "violet"] as const, "indigo"));
  const [fontSize, setFontSize] = useState<FontSize>(() => readStored<FontSize>(STORAGE_FONT_SIZE, ["small", "medium", "large"] as const, "medium"));

  // Apply density / accent / font size on mount + whenever they change.
  useEffect(() => { applyDensity(density); }, [density]);
  useEffect(() => { applyAccent(accent); }, [accent]);
  useEffect(() => { applyFontSize(fontSize); }, [fontSize]);

  // Persist.
  function persist<K extends "density" | "accent" | "fontSize">(key: K, value: string) {
    const map = { density: STORAGE_DENSITY, accent: STORAGE_ACCENT, fontSize: STORAGE_FONT_SIZE } as const;
    try { window.localStorage.setItem(map[key], value); } catch { /* ignore */ }
  }

  function onSelectMode(mode: ThemeMode) {
    theme.setMode(mode);
    toast.success(`Theme set to ${mode === "system" ? "System" : mode === "light" ? "Light" : "Dark"}`, { duration: 1500 });
  }

  function onSelectAccent(next: AccentColor) {
    setAccent(next);
    persist("accent", next);
  }

  function onSelectDensity(next: Density) {
    setDensity(next);
    persist("density", next);
  }

  function onSelectFontSize(next: FontSize) {
    setFontSize(next);
    persist("fontSize", next);
  }

  function onResetToDefaults() {
    onSelectMode("dark");
    onSelectAccent("indigo");
    onSelectDensity("comfortable");
    onSelectFontSize("medium");
    toast.success("Appearance settings reset to defaults");
  }

  // The current effective theme. We compute it on the fly so the toggle
  // row reflects what the user is actually seeing right now.
  const effectiveLabel: Record<ResolvedTheme, string> = { light: "Light", dark: "Dark" };
  const effective: ResolvedTheme = theme.resolved;

  const themeDescription = useMemo(() => {
    if (theme.mode === "system") return `Currently showing ${effectiveLabel[effective]} — follows your OS preference.`;
    return `Currently showing ${effectiveLabel[effective]}.`;
  }, [theme.mode, effective]);

  return (
    <div className="sidebar-scroll flex-1 overflow-y-auto bg-app p-5 text-primary" data-density={density}>
      <div
        className="sticky top-[-20px] z-10 w-full h-12 pointer-events-none"
        style={{ backgroundImage: "linear-gradient(to bottom, var(--fade-tint-strong), transparent)" }}
      />
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="space-y-2">
          <div className="inline-flex h-9 w-9 items-center justify-center rounded bg-accent/50 border border-border/40 text-accent-foreground">
            <Palette size={16} />
          </div>
          <h1 className="font-mono-tech text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground">Appearance</h1>
          <p className="max-w-[65ch] font-mono-tech text-[10px] text-muted-foreground">
            Customize how Rapa looks and feels. Changes apply instantly.
          </p>
        </header>

        {/* Theme */}
        <section className="analytics-panel rounded-lg p-5">
          <SectionHeader
            icon={<Palette size={14} />}
            title="Theme"
            description={themeDescription}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <ThemePreview mode="light"  active={theme.mode === "light"}  onSelect={() => onSelectMode("light")} />
            <ThemePreview mode="dark"   active={theme.mode === "dark"}   onSelect={() => onSelectMode("dark")} />
            <ThemePreview mode="system" active={theme.mode === "system"} onSelect={() => onSelectMode("system")} />
          </div>
        </section>

        {/* Accent */}
        <section className="analytics-panel rounded-lg p-5">
          <SectionHeader
            icon={<Sparkles size={14} />}
            title="Accent color"
            description="Used for highlights, focus rings, and selected items."
            iconTint="color-mix(in srgb, var(--accent-purple) 15%, transparent)"
          />
          <div className="grid grid-cols-6 gap-2">
            {ACCENTS.map((a) => (
              <AccentSwatch key={a.id} accent={a} active={accent === a.id} onSelect={() => onSelectAccent(a.id)} />
            ))}
          </div>
        </section>

        {/* Font size */}
        <section className="analytics-panel rounded-lg p-5">
          <SectionHeader
            icon={<Type size={14} />}
            title="Message text size"
            description="Scales the size of chat message bodies across the app."
            iconTint="color-mix(in srgb, var(--accent-green) 15%, transparent)"
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <FontSizeOption size="small"  active={fontSize === "small"}  onSelect={() => onSelectFontSize("small")} />
            <FontSizeOption size="medium" active={fontSize === "medium"} onSelect={() => onSelectFontSize("medium")} />
            <FontSizeOption size="large"  active={fontSize === "large"}  onSelect={() => onSelectFontSize("large")} />
          </div>
        </section>

        {/* Density */}
        <section className="analytics-panel rounded-lg p-5">
          <SectionHeader
            icon={<Type size={14} />}
            title="Message density"
            description="Comfortable gives each message more breathing room; compact fits more on screen."
            iconTint="color-mix(in srgb, var(--accent-orange) 15%, transparent)"
          />
          <div className="space-y-2">
            <Toggle
              checked={density === "compact"}
              onChange={(v) => onSelectDensity(v ? "compact" : "comfortable")}
              label="Compact messages"
              description="Tighten spacing between messages and assistant turns."
            />
          </div>
        </section>

        {/* Reset */}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onResetToDefaults}
            className="rounded border border-border/60 bg-card-3/50 px-4 py-2 font-mono-tech text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground transition-colors hover:bg-accent/30"
          >
            Reset to defaults
          </button>
        </div>
      </div>
      <div
        className="sticky bottom-[-20px] z-10 w-full h-12 pointer-events-none"
        style={{ backgroundImage: "linear-gradient(to top, var(--fade-tint-strong), transparent)" }}
      />
    </div>
  );
};
