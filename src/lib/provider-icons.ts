// Single source of truth for provider logo assets.
//
// Why this exists: previously the same `Record<string, string>` map was
// duplicated inline in 3 components (model-selector, settings-page, sidebar).
// When OpenRouter was added, only 2 of the 3 sites got updated — the sidebar
// silently fell back to a generic letter tile. Centralising the map here
// means new providers only need to be registered in one place.
//
// The keys are normalised lowercase provider ids (matching the `provider`
// field on the `ProviderSetting` DB row and the route slug).
//
// The values are absolute paths under /src/assets/. Vite's static asset
// handler resolves these at build time, so we can use the literal path
// without any import statement.

const ICONS: Record<string, string> = {
  gemini: "/src/assets/gemini-color.svg",
  puter: "/src/assets/puter.png",
  ollama: "/src/assets/ollama.webp",
  nvidia: "/src/assets/nvidia-color.svg",
  groq: "/src/assets/groq.webp",
  huggingface: "/src/assets/huggingface.svg",
  minimax: "/src/assets/minimax.webp",
  openrouter: "/src/assets/openrouter.webp"
};

export function getProviderIcon(provider: string | undefined | null): string | undefined {
  if (!provider) return undefined;
  return ICONS[provider.toLowerCase()];
}

export function hasProviderIcon(provider: string | undefined | null): boolean {
  return getProviderIcon(provider) !== undefined;
}
