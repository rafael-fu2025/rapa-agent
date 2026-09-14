import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithAuth, getJwtExpiryMs, API_BASE } from "../http";

// This jsdom setup does not expose a working localStorage global —
// provide an in-memory implementation for the token store.
function makeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    }
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", makeLocalStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function makeJwt(expiresInSeconds: number): string {
  const encode = (obj: unknown) => btoa(JSON.stringify(obj)).replace(/=+$/, "");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ exp: expiresInSeconds })}.sig`;
}

describe("fetchWithAuth silent refresh", () => {
  it("retries once with the new token after a successful refresh", async () => {
    localStorage.setItem("auth_token", "expired-token");
    const calls: Array<{ url: string; auth?: string | null }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const auth = new Headers(init?.headers).get("Authorization");
        calls.push({ url, auth });

        if (url === `${API_BASE}/auth/refresh`) {
          return jsonResponse({ token: "fresh-token" });
        }
        // The data endpoint rejects the old token, accepts the fresh one.
        if (auth === "Bearer fresh-token") return jsonResponse({ ok: true });
        return jsonResponse({ message: "unauthorized" }, 401);
      })
    );

    const response = await fetchWithAuth("/widgets");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    expect(calls).toHaveLength(3); // data (401) + refresh + data retry (200)
    expect(calls[2].url).toBe(`${API_BASE}/widgets`);
    expect(calls[2].auth).toBe("Bearer fresh-token");
    expect(localStorage.getItem("auth_token")).toBe("fresh-token");
  });

  it("shares a single in-flight refresh between concurrent 401s", async () => {
    localStorage.setItem("auth_token", "expired-token");
    const refreshCalls: number[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === `${API_BASE}/auth/refresh`) {
          refreshCalls.push(1);
          // Slow refresh so both callers are in flight simultaneously.
          await new Promise((resolve) => setTimeout(resolve, 50));
          return jsonResponse({ token: "fresh-token" });
        }
        const auth = new Headers(init?.headers).get("Authorization");
        if (auth === "Bearer fresh-token") return jsonResponse({ ok: true });
        return jsonResponse({ message: "unauthorized" }, 401);
      })
    );

    const [a, b] = await Promise.all([fetchWithAuth("/a"), fetchWithAuth("/b")]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(refreshCalls).toHaveLength(1);
  });

  it("logs out when the token is provably invalid", async () => {
    localStorage.setItem("auth_token", "truly-dead-token");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${API_BASE}/auth/refresh`) {
          return jsonResponse({ message: "token expired" }, 401);
        }
        return jsonResponse({ message: "unauthorized" }, 401);
      })
    );

    const response = await fetchWithAuth("/widgets");
    expect(response.status).toBe(401);
    // The redirect itself is not assertable under jsdom (location.href is
    // locked down); token removal is the observable side effect.
    expect(localStorage.getItem("auth_token")).toBeNull();
  });

  it("never refreshes for auth endpoints (no refresh loops)", async () => {
    localStorage.setItem("auth_token", "expired-token");
    const urls: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return jsonResponse({ message: "bad credentials" }, 401);
      })
    );

    const response = await fetchWithAuth("/auth/login", { method: "POST" });
    expect(response.status).toBe(401);
    expect(urls).toEqual([`${API_BASE}/auth/login`]); // no /auth/refresh call
    // An unreachable-in-this-test redirect does not clear the token for
    // auth paths — only a failed refresh does.
  });

  it("wraps network failures with the friendly backend hint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );

    await expect(fetchWithAuth("/widgets")).rejects.toThrow(/Is the backend running/);
  });

  it("does not refresh when no token is stored", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return jsonResponse({ message: "unauthorized" }, 401);
      })
    );

    const response = await fetchWithAuth("/widgets");
    expect(response.status).toBe(401);
    expect(urls).toEqual([`${API_BASE}/widgets`]);
  });
});

describe("getJwtExpiryMs", () => {
  it("decodes the exp claim", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    expect(getJwtExpiryMs(makeJwt(exp))).toBe(exp * 1000);
  });

  it("returns null for malformed tokens", () => {
    expect(getJwtExpiryMs("not-a-jwt")).toBeNull();
    expect(getJwtExpiryMs("a.b.c")).toBeNull(); // payload not valid JSON
  });
});
