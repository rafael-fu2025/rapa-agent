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
// The values are ESM asset imports so Vite hashes + emits them at build
// time — the previous runtime `/src/assets/...` string paths only worked
// under the dev server and 404'd in production builds (audit M3).

import geminiColor from "../assets/gemini-color.svg";
import puterPng from "../assets/puter.png";
import ollamaWebp from "../assets/ollama.webp";
import nvidiaColor from "../assets/nvidia-color.svg";
import groqWebp from "../assets/groq.webp";
import huggingfaceSvg from "../assets/huggingface.svg";
import minimaxWebp from "../assets/minimax.webp";
import openrouterWebp from "../assets/openrouter.webp";

const ICONS: Record<string, string> = {
  gemini: geminiColor,
  puter: puterPng,
  ollama: ollamaWebp,
  nvidia: nvidiaColor,
  groq: groqWebp,
  huggingface: huggingfaceSvg,
  minimax: minimaxWebp,
  openrouter: openrouterWebp
};

export function getProviderIcon(provider: string | undefined | null): string | undefined {
  if (!provider) return undefined;
  return ICONS[provider.toLowerCase()];
}

export function hasProviderIcon(provider: string | undefined | null): boolean {
  return getProviderIcon(provider) !== undefined;
}
