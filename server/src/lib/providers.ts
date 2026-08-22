// Shared provider helpers.
//
// `providerAllowsKeylessAccess` used to exist in three hand-maintained
// copies (chat.ts, agent.ts, settings.ts) with DIVERGENT behavior —
// settings.ts accepted both "ollama" and "puter" while chat/agent accepted
// only "ollama", so the same provider could pass validation in one route
// and fail in another. Single source of truth here.

/**
 * Providers that work without a stored API key:
 * - ollama: local inference, no auth
 * - puter: proxies user auth via the browser session; its model catalog is
 *   publicly readable
 */
export function providerAllowsKeylessAccess(provider: string): boolean {
  return provider === "ollama" || provider === "puter";
}
