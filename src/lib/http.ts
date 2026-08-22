// Shared HTTP plumbing for the API clients (api.ts, agent-api.ts,
// workspace-api.ts). Previously the rate-limit retry wrapper, the auth
// header helper, and API_BASE each existed in two or three copies.

export const API_BASE = (import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8787") + "/api";

export function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("auth_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Retry wrapper for 429 (rate limit) with exponential backoff, plus a clear
 * message for network-level failures so the UI can hint "is the backend
 * running?" instead of showing a raw TypeError.
 */
export async function fetchWithRateLimitRetry(
  url: string,
  init?: RequestInit,
  maxRetries = 3
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown network error";
      throw new Error(
        `Couldn't reach ${url}: ${message}. ` +
          "Is the backend running? Try `cd server && npm run dev` in a terminal.",
        { cause: err }
      );
    }
    if (response.status !== 429 || attempt === maxRetries) return response;
    const retryAfter = response.headers.get("retry-after");
    const retryAfterMs = parseInt(retryAfter ?? "", 10) * 1000;
    const delayMs = Number.isFinite(retryAfterMs) && retryAfterMs >= 0
      ? Math.min(retryAfterMs, 30_000)
      : Math.min(1000 * Math.pow(2, attempt), 10_000);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  // Unreachable, but TS needs it
  return fetch(url, init);
}
