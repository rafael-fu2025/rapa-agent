// Appearance token application — shared by the Appearance settings page
// (live preview) and the app boot (restores the stored choices before
// first paint). Previously these three settings set CSS variables that
// nothing consumed (audit M1.9); theme.css and the message components
// now read them.

export type AccentColor = "indigo" | "blue" | "emerald" | "rose" | "amber" | "violet";
export type FontSize = "small" | "medium" | "large";
export type Density = "comfortable" | "compact";

export const APPEARANCE_STORAGE_KEYS = {
  accent: "rapa_accent",
  fontSize: "rapa_font_size",
  density: "rapa_density"
} as const;

export type AccentPreset = {
  id: AccentColor;
  label: string;
  /** Swatch color used for the picker dot. */
  hex: string;
  /** Preview text color when this accent is active. */
  textClass: string;
  /** Preview border color when this accent is active. */
  borderClass: string;
};

export const ACCENT_PRESETS: AccentPreset[] = [
  { id: "indigo", label: "Indigo", hex: "#6366F1", textClass: "text-[#6366F1]", borderClass: "border-[#6366F1]" },
  { id: "blue", label: "Blue", hex: "#3B82F6", textClass: "text-[#3B82F6]", borderClass: "border-[#3B82F6]" },
  { id: "emerald", label: "Emerald", hex: "#10B981", textClass: "text-[#10B981]", borderClass: "border-[#10B981]" },
  { id: "rose", label: "Rose", hex: "#F43F5E", textClass: "text-[#F43F5E]", borderClass: "border-[#F43F5E]" },
  { id: "amber", label: "Amber", hex: "#F59E0B", textClass: "text-[#F59E0B]", borderClass: "border-[#F59E0B]" },
  { id: "violet", label: "Violet", hex: "#8B5CF6", textClass: "text-[#8B5CF6]", borderClass: "border-[#8B5CF6]" }
];

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const v = window.localStorage.getItem(key);
    if (v && (allowed as readonly string[]).includes(v)) return v as T;
  } catch { /* ignore */ }
  return fallback;
}

export function applyAccent(accent: AccentColor) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  // Wipe any previous custom accent properties.
  root.style.removeProperty("--accent-color");
  root.style.removeProperty("--accent-color-dark");
  const preset = ACCENT_PRESETS.find((a) => a.id === accent);
  if (preset) {
    root.style.setProperty("--accent-color", preset.hex);
    // Dark mode lifts the accent toward white so mid-tone choices stay
    // readable on the dark surface. Consumed by the dark theme block.
    root.style.setProperty(
      "--accent-color-dark",
      `color-mix(in srgb, ${preset.hex} 78%, white)`
    );
  }
  root.dataset.accent = accent;
}

export function applyFontSize(size: FontSize) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const scale = size === "small" ? 0.9375 : size === "large" ? 1.0625 : 1;
  root.style.setProperty("--font-size-multiplier", String(scale));
  root.dataset.fontSize = size;
}

export function applyDensity(density: Density) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.density = density;
  // Comfortable (20px) matches the pre-variable space-y-5 default so the
  // setting changes nothing until the user picks compact.
  root.style.setProperty("--density-row-gap", density === "compact" ? "8px" : "20px");
}

/** Read the stored choices and apply them all. Called at app boot. */
export function applyStoredAppearance() {
  applyAccent(readStored(APPEARANCE_STORAGE_KEYS.accent, ACCENT_PRESETS.map((a) => a.id), "blue"));
  applyFontSize(readStored(APPEARANCE_STORAGE_KEYS.fontSize, ["small", "medium", "large"] as const, "medium"));
  applyDensity(readStored(APPEARANCE_STORAGE_KEYS.density, ["comfortable", "compact"] as const, "comfortable"));
}
