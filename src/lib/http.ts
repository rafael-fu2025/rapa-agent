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

/* ------------------------------------------------------------------ */
/* Silent token refresh                                                */
/*                                                                     */
/* The backend issues 7-day JWTs and offers POST /auth/refresh, which  */
/* re-issues a token from the still-valid one in the Authorization     */
/* header. Without this layer, every expiry hard-logs the user out     */
/* mid-session (audit R1 §5). All 401s share a single in-flight        */
/* refresh so a burst of failing requests can't stampede the endpoint. */
/* ------------------------------------------------------------------ */

export type RefreshOutcome = "refreshed" | "invalid" | "unreachable";

let refreshInFlight: Promise<RefreshOutcome> | null = null;

async function performRefresh(): Promise<RefreshOutcome> {
  const token = localStorage.getItem("auth_token");
  if (!token) return "invalid";
  try {
    const response = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });
    if (response.status === 401 || response.status === 403) return "invalid";
    if (!response.ok) return "unreachable";
    const data = (await response.json().catch(() => null)) as { token?: string } | null;
    if (!data?.token) return "unreachable";
    localStorage.setItem("auth_token", data.token);
    return "refreshed";
  } catch {
    // The backend is unreachable — that is not an auth failure. The
    // caller keeps its token and surfaces the network error instead.
    return "unreachable";
  }
}

/** Single-flight wrapper: concurrent callers await the same refresh. */
export function refreshAuthToken(): Promise<RefreshOutcome> {
  if (!refreshInFlight) {
    refreshInFlight = performRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** Clear the token and hard-redirect to login. Used only when the token is provably invalid. */
export function forceAuthLogout(): void {
  if (localStorage.getItem("auth_token") === null) return;
  localStorage.removeItem("auth_token");
  window.location.href = "/login";
}

const NO_REFRESH_PATHS = ["/auth/refresh", "/auth/login", "/auth/me"];

/**
 * Authenticated fetch with silent refresh + 429 backoff.
 *
 * - Injects the Authorization header (re-read per attempt so a refreshed
 *   token is picked up on retry).
 * - On 401 (outside /auth/*): single-flight refresh, retry once with the
 *   new token; a provably invalid token logs out, an unreachable backend
 *   surfaces the original 401 like any other error.
 * - On 429: exponential backoff up to `maxRetries`, mirroring
 *   fetchWithRateLimitRetry.
 */
export async function fetchWithAuth(
  path: string,
  init?: RequestInit,
  maxRetries = 3
): Promise<Response> {
  const buildHeaders = () => {
    const headers = new Headers(init?.headers ?? {});
    if (init?.body != null && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const token = localStorage.getItem("auth_token");
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return headers;
  };

  let refreshedOnce = false;

  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, { ...init, headers: buildHeaders() });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown network error";
      throw new Error(
        `Couldn't reach ${API_BASE}${path}: ${message}. ` +
          "Is the backend running? Try `cd server && npm run dev` in a terminal.",
        { cause: err }
      );
    }

    if (
      response.status === 401 &&
      !refreshedOnce &&
      !NO_REFRESH_PATHS.some((prefix) => path.startsWith(prefix))
    ) {
      const outcome = await refreshAuthToken();
      if (outcome === "refreshed") {
        refreshedOnce = true;
        continue;
      }
      if (outcome === "invalid") forceAuthLogout();
      return response;
    }

    // A second 401 after a successful refresh means the token is not
    // being accepted at all — treat it as invalid rather than looping.
    if (response.status === 401 && refreshedOnce) {
      forceAuthLogout();
      return response;
    }

    if (response.status === 429 && attempt < maxRetries) {
      const retryAfter = response.headers.get("retry-after");
      const retryAfterMs = parseInt(retryAfter ?? "", 10) * 1000;
      const delayMs = Number.isFinite(retryAfterMs) && retryAfterMs >= 0
        ? Math.min(retryAfterMs, 30_000)
        : Math.min(1000 * Math.pow(2, attempt), 10_000);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }

    return response;
  }
}

/** Decode a JWT's `exp` claim into epoch milliseconds (null when unparsable). */
export function getJwtExpiryMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(base64)) as { exp?: unknown };
    if (typeof payload?.exp !== "number") return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}
