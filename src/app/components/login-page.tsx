import { useState } from "react";
import { useAuth } from "../hooks/use-auth";
import { API_BASE } from "../../lib/api";
import { Loader2 } from "lucide-react";
import { useNavigate } from "react-router";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

/* ── Rapa Mark — monochrome SVG with green accent dot ──────────── */
function RapaMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      data-component="rapa-mark"
    >
      <rect
        x="4"
        y="4"
        width="56"
        height="56"
        rx="16"
        fill="var(--login-logo-bg)"
      />
      <rect
        x="4.75"
        y="4.75"
        width="54.5"
        height="54.5"
        rx="15.25"
        stroke="var(--login-logo-stroke)"
        strokeWidth="1.5"
        fill="none"
      />
      <path
        d="M22 18H32.5C41.06 18 46 22.72 46 30.56C46 36.32 43.14 40.28 38.08 41.8L45.2 49H37.28L31.4 42.68H28.36V49H22V18ZM31.92 37.48C36.56 37.48 39.36 35.04 39.36 30.92C39.36 26.8 36.56 24.48 31.92 24.48H28.36V37.48H31.92Z"
        fill="var(--login-logo-fill)"
      />
      <circle cx="45.5" cy="18.5" r="4" fill="rgba(61,186,122,0.6)" />
    </svg>
  );
}

/* ── Network topology SVG — 30 nodes, connections, pulses, streams ─ */
function NetworkTopology() {
  const nodes = [
    { x: 160, y: 90, r: 3, pulse: false },
    { x: 480, y: 60, r: 3.5, pulse: false },
    { x: 820, y: 40, r: 4, pulse: true },
    { x: 1200, y: 70, r: 3, pulse: false },
    { x: 1580, y: 100, r: 3.5, pulse: false },
    { x: 1820, y: 60, r: 2.5, pulse: false },
    { x: 80, y: 380, r: 3, pulse: false },
    { x: 380, y: 280, r: 4, pulse: true },
    { x: 680, y: 200, r: 4.5, pulse: false },
    { x: 1040, y: 180, r: 3.5, pulse: false },
    { x: 1360, y: 240, r: 4, pulse: true },
    { x: 1700, y: 360, r: 3, pulse: false },
    { x: 240, y: 600, r: 3, pulse: false },
    { x: 540, y: 480, r: 4.5, pulse: false },
    { x: 760, y: 360, r: 4, pulse: false },
    { x: 1160, y: 380, r: 4, pulse: false },
    { x: 1440, y: 520, r: 4, pulse: true },
    { x: 1780, y: 560, r: 2.5, pulse: false },
    { x: 120, y: 840, r: 3, pulse: false },
    { x: 400, y: 760, r: 3.5, pulse: false },
    { x: 720, y: 680, r: 4, pulse: true },
    { x: 1060, y: 700, r: 3.5, pulse: false },
    { x: 1340, y: 800, r: 4, pulse: false },
    { x: 1680, y: 740, r: 3, pulse: false },
    { x: 280, y: 1000, r: 3, pulse: false },
    { x: 640, y: 940, r: 3.5, pulse: false },
    { x: 1000, y: 920, r: 3, pulse: false },
    { x: 1300, y: 980, r: 3.5, pulse: false },
    { x: 1640, y: 960, r: 3, pulse: false },
    { x: 960, y: 120, r: 5, pulse: true },
  ];

  const connections: [number, number][] = [
    [0, 7], [1, 8], [3, 9], [4, 10], [5, 11],
    [6, 12], [6, 18], [11, 16], [11, 17],
    [12, 19], [18, 24], [19, 25],
    [23, 17], [23, 28], [22, 27], [26, 28],
    [7, 13], [8, 14], [9, 15], [10, 16],
    [13, 14], [14, 15], [15, 16],
    [13, 20], [15, 21], [16, 22],
    [14, 20], [15, 21], [20, 21],
    [8, 9], [2, 8], [2, 29], [29, 9],
    [7, 8], [9, 10], [19, 20],
    [21, 22], [25, 26], [26, 27],
  ];

  const streams = [
    { from: 0, to: 7, dur: "3.5s", offset: -30 },
    { from: 5, to: 11, dur: "4.5s", offset: -30 },
    { from: 6, to: 13, dur: "5s", offset: -30 },
    { from: 29, to: 14, dur: "3s", offset: -30 },
    { from: 23, to: 16, dur: "4s", offset: -30 },
    { from: 18, to: 20, dur: "5.5s", offset: -30 },
  ];

  return (
    <svg
      width="100%"
      height="100%"
      viewBox="0 0 1920 1080"
      preserveAspectRatio="xMidYMid slice"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {connections.map(([a, b], i) => (
        <line
          key={`c${i}`}
          x1={nodes[a].x}
          y1={nodes[a].y}
          x2={nodes[b].x}
          y2={nodes[b].y}
          stroke="var(--login-connection-color)"
          strokeWidth="1"
        />
      ))}
      {[14, 15, 20, 21].map((idx, i) => (
        <line
          key={`h${i}`}
          x1={nodes[idx].x}
          y1={nodes[idx].y}
          x2={960}
          y2={540}
          stroke="var(--login-connection-color)"
          strokeWidth="1"
          opacity="0.6"
        />
      ))}
      {streams.map((s, i) => (
        <line
          key={`s${i}`}
          x1={nodes[s.from].x}
          y1={nodes[s.from].y}
          x2={nodes[s.to].x}
          y2={nodes[s.to].y}
          stroke="var(--login-accent)"
          strokeWidth="1.5"
          opacity="0.35"
          className="stream-line"
          style={
            {
              "--stream-dur": s.dur,
              strokeDashoffset: s.offset,
            } as React.CSSProperties
          }
        />
      ))}
      {nodes.map((n, i) => (
        <circle
          key={`n${i}`}
          cx={n.x}
          cy={n.y}
          r={n.r}
          fill={n.pulse ? "var(--login-node-pulse)" : "var(--login-node-color)"}
          opacity={n.pulse ? 0.9 : 0.25}
        />
      ))}
      {nodes
        .filter((n) => n.pulse)
        .map((n, i) => (
          <circle
            key={`p${i}`}
            cx={n.x}
            cy={n.y}
            r={n.r * 3}
            fill="none"
            stroke="var(--login-node-pulse)"
            strokeWidth="1"
            className="node-pulse"
            style={{ animationDelay: `${i * 0.8}s` }}
          />
        ))}
    </svg>
  );
}

/* ── Status indicator ──────────────────────────────────────────── */
function StatusItem({
  label,
  value,
  active = false,
}: {
  label: string;
  value?: string;
  active?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={`status-dot ${
          active ? "status-dot--active" : "status-dot--idle"
        }`}
      />
      <span
        className="font-mono-tech"
        style={{
          fontSize: "11px",
          color: "var(--login-muted)",
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </span>
      {value && (
        <span
          className="font-mono-tech"
          style={{
            fontSize: "11px",
            color: active
              ? "var(--login-accent)"
              : "var(--login-status-idle)",
            letterSpacing: "0.02em",
          }}
        >
          {value}
        </span>
      )}
    </div>
  );
}

/* ── Login page — immersive network topology ───────────────────── */
export function LoginPage() {
  const [email, setEmail] = useState("local@localhost.com");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { login } = useAuth();
  const navigate = useNavigate();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.issues && data.issues.length > 0) {
          throw new Error(data.issues[0].message);
        }
        throw new Error(data.message || "Login failed");
      }

      login(data.token, data.user);
      navigate("/", { replace: true });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "An unknown error occurred",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <main
      className="login-network relative flex min-h-screen w-full items-center justify-center overflow-hidden"
      data-component="login-page"
    >
      {/* Dot grid */}
      <div className="login-dot-grid" aria-hidden="true" />

      {/* Animated network */}
      <div className="login-network-layer" aria-hidden="true">
        <NetworkTopology />
      </div>

      {/* Scan line */}
      <div className="login-scan-line" aria-hidden="true" />

      {/* Floating labels */}
      <div className="hidden md:block" aria-hidden="true">
        <span className="login-float-label" style={{ top: "5%", left: "42%" }}>
          rapa::gateway
        </span>
        <span className="login-float-label" style={{ top: "16%", left: "71%" }}>
          auth::01
        </span>
        <span className="login-float-label" style={{ top: "26%", left: "18%" }}>
          node::primary
        </span>
        <span className="login-float-label" style={{ top: "44%", left: "78%" }}>
          cluster::03
        </span>
        <span className="login-float-label" style={{ top: "63%", left: "36%" }}>
          api::handler
        </span>
        <span className="login-float-label" style={{ top: "66%", left: "72%" }}>
          sys::monitor
        </span>
        <span className="login-float-label" style={{ top: "74%", left: "20%" }}>
          agent::07
        </span>
      </div>

      {/* Status cluster */}
      <div
        className="absolute top-6 left-6 hidden md:flex flex-col gap-2.5 z-10"
        data-component="status-cluster"
      >
        <StatusItem label="SYSTEM" value="ONLINE" active />
      </div>

      {/* Coordinate labels */}
      <span
        className="login-coord-label hidden md:block"
        style={{ top: "8px", left: "12px" }}
      >
        0, 0
      </span>
      <span
        className="login-coord-label hidden md:block"
        style={{ top: "8px", right: "12px" }}
      >
        1920, 0
      </span>
      <span
        className="login-coord-label hidden md:block"
        style={{ bottom: "8px", left: "12px" }}
      >
        0, 1080
      </span>
      <span
        className="login-coord-label hidden md:block"
        style={{ bottom: "8px", right: "12px" }}
      >
        1920, 1080
      </span>

      {/* Form card — the central hub */}
      <div className="relative z-10 w-full max-w-[340px] mx-4 flex flex-col items-center">
        <span
          className="font-mono-tech mb-3"
          style={{
            fontSize: "9px",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: "var(--login-label-color)",
          }}
          aria-hidden="true"
        >
          auth::gateway
        </span>
      <section
        className="login-glass-card w-full rounded-lg px-7 py-7"
        data-component="login-card"
        aria-label="Sign in"
      >
        <header
          className="flex items-center gap-2.5 mb-4 pb-4"
          data-component="card-header"
          style={{ borderBottom: "1px solid var(--login-card-border)" }}
        >
          <RapaMark size={20} />
          <span
            className="font-mono-tech"
            style={{
              fontSize: "12px",
              fontWeight: 500,
              color: "var(--login-fg)",
              letterSpacing: "0.02em",
            }}
          >
            Rapa
          </span>
        </header>

        <div className="mt-4 mb-5" data-component="form-heading">
          <h1
            className="font-mono-tech"
            style={{
              fontSize: "15px",
              fontWeight: 500,
              lineHeight: 1.2,
              letterSpacing: "-0.01em",
              marginBottom: "4px",
              color: "var(--login-fg)",
            }}
          >
            Sign in
          </h1>
          <p
            className="font-mono-tech"
            style={{
              fontSize: "11px",
              fontWeight: 400,
              lineHeight: 1.5,
              color: "var(--login-muted)",
            }}
          >
            Enter your credentials to continue
          </p>
        </div>

        {error && (
          <div
            className="font-mono-tech rounded-md px-3 py-2.5 mb-4 text-[12px]"
            style={{
              background:
                "color-mix(in srgb, var(--destructive) 10%, transparent)",
              border:
                "1px solid color-mix(in srgb, var(--destructive) 20%, transparent)",
              color: "#f87171",
            }}
            role="alert"
            data-component="error-banner"
          >
            {error}
          </div>
        )}

        <form
          onSubmit={handleLogin}
          className="space-y-4"
          data-component="login-form"
        >
          <div className="space-y-2" data-component="email-field">
            <Label
              htmlFor="email"
              className="font-mono-tech"
              style={{
                fontSize: "11px",
                fontWeight: 500,
                letterSpacing: "0.04em",
                color: "var(--login-fg)",
              }}
            >
              Email
            </Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              disabled={loading}
              className="font-mono-tech"
              autoComplete="email"
            />
          </div>
          <div className="space-y-2" data-component="password-field">
            <Label
              htmlFor="password"
              className="font-mono-tech"
              style={{
                fontSize: "11px",
                fontWeight: 500,
                letterSpacing: "0.04em",
                color: "var(--login-fg)",
              }}
            >
              Password
            </Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              required
              minLength={6}
              disabled={loading}
              className="font-mono-tech"
              autoComplete="current-password"
            />
          </div>
          <Button
            type="submit"
            disabled={loading}
            variant="accent"
            className="w-full font-mono-tech"
            style={{
              fontSize: "11px",
              fontWeight: 600,
              letterSpacing: "0.04em",
            }}
            data-component="submit-button"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "Sign In"
            )}
          </Button>
        </form>
      </section>
      </div>

      {/* Footer */}
      <footer
        className="absolute bottom-5 left-0 right-0 text-center z-10"
        data-component="page-footer"
      >
        <p
          className="font-mono-tech"
          style={{
            fontSize: "11px",
            letterSpacing: "0.04em",
            color: "var(--login-muted)",
          }}
        >
          For local deployment, use{" "}
          <strong
            className="font-medium"
            style={{ color: "var(--login-fg)" }}
          >
            local@localhost.com
          </strong>
        </p>
      </footer>
    </main>
  );
}
