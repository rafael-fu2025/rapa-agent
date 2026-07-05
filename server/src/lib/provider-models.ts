// Normalize the response from a provider's `/models` endpoint into a flat list
// of model IDs (strings).
//
// Different providers return different shapes:
//   - OpenAI / NVIDIA / Groq / Hugging Face / MiniMax:
//       { data: [{ id: "model-id", object: "model", ... }, ...] }
//       (sometimes `data` is already a plain array)
//   - Gemini (Google):
//       { models: [{ name: "models/gemini-3-pro-preview", ... }, ...] }
//       (the `name` field includes a `models/` prefix we strip)
//   - Some local proxies: a bare array of strings or objects
//
// This helper accepts any of those shapes and returns a sorted, de-duplicated
// list of model IDs.

export type ParsedModelsResponse = {
  models: string[];
  source: "openai" | "gemini" | "bare-array" | "unknown";
};

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Pull a candidate model id from an arbitrary object. Tries common field
 * names in order of how often they appear in real APIs.
 */
function extractModelId(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;

  // OpenAI / NVIDIA / Groq / MiniMax style
  const id = asString(record.id);
  if (id) return id;

  // Gemini style — strip the leading "models/" prefix
  const name = asString(record.name);
  if (name) return name.replace(/^models\//, "");

  // Fallbacks used by some aggregators (OpenRouter, etc.)
  const slug = asString(record.slug);
  if (slug) return slug;
  const model = asString(record.model);
  if (model) return model;

  return null;
}

export function parseModelsResponse(raw: unknown): ParsedModelsResponse {
  if (raw == null) {
    return { models: [], source: "unknown" };
  }

  // Bare array of strings or objects
  if (Array.isArray(raw)) {
    const ids: string[] = [];
    for (const item of raw) {
      if (typeof item === "string") {
        const s = asString(item);
        if (s) ids.push(s);
      } else {
        const id = extractModelId(item);
        if (id) ids.push(id);
      }
    }
    return { models: dedupeAndSort(ids), source: "bare-array" };
  }

  if (typeof raw !== "object") {
    return { models: [], source: "unknown" };
  }

  const record = raw as Record<string, unknown>;

  // OpenAI-compatible: { data: [...] }
  if (Array.isArray(record.data)) {
    const ids: string[] = [];
    for (const item of record.data) {
      const id = extractModelId(item);
      if (id) ids.push(id);
    }
    return { models: dedupeAndSort(ids), source: "openai" };
  }

  // Gemini: { models: [...] }
  if (Array.isArray(record.models)) {
    const ids: string[] = [];
    for (const item of record.models) {
      const id = extractModelId(item);
      if (id) ids.push(id);
    }
    return { models: dedupeAndSort(ids), source: "gemini" };
  }

  return { models: [], source: "unknown" };
}

function dedupeAndSort(ids: string[]): string[] {
  return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
}

/**
 * Compute the diff between the fetched models and the existing saved list.
 * Used by the route to surface what changed in the toast/UI.
 */
export function diffModelLists(existing: string[], fetched: string[]): {
  added: string[];
  removed: string[];
} {
  const existingSet = new Set(existing);
  const fetchedSet = new Set(fetched);
  const added: string[] = [];
  const removed: string[] = [];
  for (const id of fetched) {
    if (!existingSet.has(id)) added.push(id);
  }
  for (const id of existing) {
    if (!fetchedSet.has(id)) removed.push(id);
  }
  return { added: added.sort(), removed: removed.sort() };
}