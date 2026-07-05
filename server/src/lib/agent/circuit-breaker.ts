// Per-tool circuit breaker.
//
// Prevents cascading failures when a downstream (shell, web, git, etc.) starts
// failing repeatedly. State machine: closed → open → half_open → closed.
//
// References: agentic-reliability SKILL.md, Forge error handling reference,
// MavikLabs 2026.

export type CircuitState = "closed" | "open" | "half_open";

export class CircuitOpenError extends Error {
  readonly name = "CircuitOpenError";
  readonly toolName: string;
  readonly recoveryAt: number;

  constructor(toolName: string, recoveryAt: number) {
    super(`Circuit open for tool ${toolName} until ${new Date(recoveryAt).toISOString()}`);
    this.toolName = toolName;
    this.recoveryAt = recoveryAt;
  }
}

export type CircuitBreakerOptions = {
  failureThreshold: number;
  /** Time to wait in `open` state before allowing a probe (`half_open`). */
  recoveryTimeoutMs: number;
  /** Number of consecutive successes in `half_open` before returning to `closed`. */
  successThreshold: number;
  /** Time window for counting failures (rolling). */
  windowMs: number;
};

const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  recoveryTimeoutMs: 60_000,
  successThreshold: 2,
  windowMs: 60_000
};

type BreakerState = {
  state: CircuitState;
  failures: number[]; // timestamps
  halfOpenSuccesses: number;
  openedAt?: number;
};

export class CircuitBreaker {
  private options: CircuitBreakerOptions;
  private states = new Map<string, BreakerState>();

  constructor(options: Partial<CircuitBreakerOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  private getState(toolName: string): BreakerState {
    let state = this.states.get(toolName);
    if (!state) {
      state = { state: "closed", failures: [], halfOpenSuccesses: 0 };
      this.states.set(toolName, state);
    }
    return state;
  }

  private pruneFailures(state: BreakerState, now: number): void {
    const cutoff = now - this.options.windowMs;
    while (state.failures.length > 0 && state.failures[0] < cutoff) {
      state.failures.shift();
    }
  }

  /**
   * Check if the call is allowed to proceed. Throws CircuitOpenError if not.
   * If the recovery timeout has elapsed, transitions open → half_open.
   */
  guard(toolName: string, now: number = Date.now()): void {
    const state = this.getState(toolName);
    this.pruneFailures(state, now);

    if (state.state === "open") {
      if (state.openedAt && now - state.openedAt >= this.options.recoveryTimeoutMs) {
        state.state = "half_open";
        state.halfOpenSuccesses = 0;
      } else {
        throw new CircuitOpenError(
          toolName,
          (state.openedAt ?? now) + this.options.recoveryTimeoutMs
        );
      }
    }
  }

  recordSuccess(toolName: string, now: number = Date.now()): void {
    const state = this.getState(toolName);
    this.pruneFailures(state, now);

    if (state.state === "half_open") {
      state.halfOpenSuccesses += 1;
      if (state.halfOpenSuccesses >= this.options.successThreshold) {
        state.state = "closed";
        state.failures = [];
        state.halfOpenSuccesses = 0;
        state.openedAt = undefined;
      }
    } else if (state.state === "closed") {
      // Successful calls in closed state prune the failure history a bit.
      if (state.failures.length > 0 && Math.random() < 0.1) {
        state.failures.shift();
      }
    }
  }

  recordFailure(toolName: string, now: number = Date.now()): void {
    const state = this.getState(toolName);
    state.failures.push(now);
    this.pruneFailures(state, now);

    if (state.state === "half_open") {
      // Probe failed → back to open.
      state.state = "open";
      state.openedAt = now;
      state.halfOpenSuccesses = 0;
    } else if (
      state.state === "closed"
      && state.failures.length >= this.options.failureThreshold
    ) {
      state.state = "open";
      state.openedAt = now;
    }
  }

  /** Snapshot for telemetry/dashboards. */
  snapshot(toolName: string) {
    const state = this.getState(toolName);
    return {
      state: state.state,
      recentFailures: state.failures.length,
      openedAt: state.openedAt
    };
  }
}

/** Process-wide singleton keyed by tool name. */
export const toolCircuitBreaker = new CircuitBreaker();
