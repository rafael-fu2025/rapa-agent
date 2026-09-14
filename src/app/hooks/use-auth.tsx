import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { API_BASE } from "../../lib/api";
import { getJwtExpiryMs, refreshAuthToken } from "../../lib/http";

export type AuthUser = {
  id: string;
  email: string;
};

type AuthContextType = {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  /** True when the token is present but the backend could not be reached to verify it. */
  connectionError: boolean;
  login: (token: string, user: AuthUser) => void;
  logout: () => void;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Refresh the token this long before it expires so mid-stream 401s
// essentially never happen.
const REFRESH_LEAD_MS = 60 * 60 * 1000;
// When boot verification fails because the backend is unreachable, retry
// at this interval instead of logging the user out.
const RETRY_INTERVAL_MS = 15_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(() => localStorage.getItem("auth_token"));
  const [isLoading, setIsLoading] = useState(true);
  const [connectionError, setConnectionError] = useState(false);
  const retryTimerRef = useRef<number | null>(null);
  const refreshTimerRef = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const verify = async (): Promise<void> => {
      // Read the token fresh on every attempt — a silent refresh may have
      // replaced it since this effect last ran.
      const current = localStorage.getItem("auth_token");
      if (!current) {
        if (!cancelled) {
          setUser(null);
          setIsLoading(false);
          setConnectionError(false);
        }
        return;
      }

      try {
        const res = await fetch(`${API_BASE}/auth/me`, {
          headers: { Authorization: `Bearer ${current}` }
        });

        if (cancelled) return;

        if (res.status === 401) {
          // The token was rejected. One silent refresh before logout —
          // clock skew or a just-rotated secret should not lose the session.
          const outcome = await refreshAuthToken();
          if (cancelled) return;
          if (outcome === "refreshed") {
            setToken(localStorage.getItem("auth_token"));
            return;
          }
          if (outcome === "invalid") {
            localStorage.removeItem("auth_token");
            setToken(null);
            setUser(null);
            setIsLoading(false);
            setConnectionError(false);
            return;
          }
          // Refresh endpoint unreachable — same policy as a network
          // failure below: keep the token, retry shortly.
          scheduleRetry();
          return;
        }

        const data = (await res.json().catch(() => null)) as { user?: AuthUser } | null;
        if (cancelled) return;

        if (data?.user) {
          setUser(data.user);
          setConnectionError(false);
          setIsLoading(false);
          scheduleProactiveRefresh();
        } else {
          // Reachable but no user — treat as invalid session.
          localStorage.removeItem("auth_token");
          setToken(null);
          setUser(null);
          setIsLoading(false);
          setConnectionError(false);
        }
      } catch {
        // Network failure ≠ invalid token. A backend that is momentarily
        // down must not wipe a still-valid token (audit R1 §5): keep the
        // session and retry in the background.
        if (cancelled) return;
        setConnectionError(true);
        setIsLoading(false);
        scheduleRetry();
      }
    };

    const scheduleRetry = () => {
      if (retryTimerRef.current !== null) return;
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        void verify();
      }, RETRY_INTERVAL_MS);
    };

    const scheduleProactiveRefresh = () => {
      const current = localStorage.getItem("auth_token");
      if (!current) return;
      const expiry = getJwtExpiryMs(current);
      if (expiry === null) return;
      const delay = expiry - REFRESH_LEAD_MS - Date.now();
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        void refreshAuthToken().then((outcome) => {
          if (cancelled || outcome !== "refreshed") return;
          const next = localStorage.getItem("auth_token");
          // Updating state re-runs this effect, which re-verifies and
          // schedules the next refresh — a self-perpetuating cycle.
          setToken((prev) => (prev === next ? prev : next));
        });
      }, Math.max(delay, 5_000));
    };

    if (token) {
      void verify();
    } else {
      setIsLoading(false);
      setConnectionError(false);
    }

    return () => {
      cancelled = true;
      clearTimers();
    };
  }, [token, clearTimers]);

  const login = (newToken: string, newUser: AuthUser) => {
    localStorage.setItem("auth_token", newToken);
    setToken(newToken);
    setUser(newUser);
    setConnectionError(false);
  };

  const logout = () => {
    clearTimers();
    localStorage.removeItem("auth_token");
    setToken(null);
    setUser(null);
    setConnectionError(false);
  };

  return (
    <AuthContext.Provider value={{ user, token, isLoading, connectionError, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
