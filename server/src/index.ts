import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import compress from "@fastify/compress";
import jwt from "@fastify/jwt";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prisma } from "./lib/db.js";
import { loadAndValidateEnv, EnvValidationError } from "./lib/env.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { registerAgentRoutes } from "./routes/agent.js";
import { registerAgentControlRoutes } from "./routes/agent-control.js";
import { registerTerminalRoutes } from "./routes/terminal.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerServiceKeyRoutes } from "./routes/service-keys.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerAllTools, toolRegistry } from "./tools/index.js";
import { configureTracing, consoleSpanExporter, type SpanExporter } from "./lib/agent/tracing.js";
import { toolCircuitBreaker } from "./lib/agent/circuit-breaker.js";
import { startScheduler, stopScheduler } from "./lib/scheduler-tick.js";

const serverDir = dirname(fileURLToPath(import.meta.url));
const defaultWebDistDir = resolve(serverDir, "../../web-dist");
const webDistDir = process.env.WEB_DIST_DIR ? resolve(process.env.WEB_DIST_DIR) : defaultWebDistDir;

export async function createServer(options: { skipEnvValidation?: boolean } = {}): Promise<FastifyInstance> {
  // Validate environment first so we fail fast and loud rather than booting
  // with a known-bad APP_SECRET. Tests can opt out via `skipEnvValidation`.
  const env = options.skipEnvValidation
    ? null
    : loadAndValidateEnv();
  if (env) {
    // Sync back into process.env so downstream consumers (Prisma, etc.) see
    // the normalized values without us having to thread `env` everywhere.
    process.env.DATABASE_URL = env.databaseUrl;
    process.env.APP_SECRET = env.appSecret;
    process.env.PORT = String(env.port);
    process.env.DEFAULT_PROVIDER = env.defaultProvider;
    process.env.AGENT_LLM_TIMEOUT_MS = String(env.agentLlmTimeoutMs);
    process.env.TOOL_OUTPUT_MAX_CHARS = String(env.toolOutputMaxChars);
    process.env.MEMORY_COMPACTION_THRESHOLD = String(env.memoryCompactionThreshold);
  }

  const app = Fastify({ logger: true });

  // Tracing init (research O1): enable the lightweight span recorder. By
  // default we ship spans to the console exporter so operators can see them
  // in the terminal during development. Production deployments can swap in
  // a Langfuse or OTLP exporter by calling configureTracing({ exporter: ... })
  // before the agent runs.
  let exporter: SpanExporter | undefined = env?.agentTracingExporter === "off" ? undefined : consoleSpanExporter;
  if (env?.langfuse.publicKey && env?.langfuse.secretKey) {
    try {
      const { createLangfuseExporter } = await import("./lib/agent/langfuse-exporter.js");
      exporter = createLangfuseExporter({
        publicKey: env.langfuse.publicKey,
        secretKey: env.langfuse.secretKey,
        baseUrl: env.langfuse.baseUrl,
        environment: env.langfuse.environment
      });
      app.log.info("Langfuse tracing exporter enabled.");
    } catch (err) {
      app.log.warn({ err }, "Failed to enable Langfuse exporter, falling back to console");
    }
  }
  configureTracing({
    enabled: env?.agentTracingEnabled ?? process.env.AGENT_TRACING !== "false",
    exporter
  });

  registerAllTools();
  if (toolRegistry.list().length === 0) {
    throw new Error("No agent tools were registered");
  }

  // Start the §2.4 background scheduler. Polls ScheduledTask every
  // minute and fires any task whose nextRunAt is in the past. The
  // handle is kept on the app for graceful shutdown.
  startScheduler();
  app.addHook("onClose", async () => {
    stopScheduler();
  });

  await app.register(websocket);
  await app.register(compress, { global: true, encodings: ["gzip", "br"] });

  await app.register(jwt, {
    secret: process.env.APP_SECRET ?? "super-secret-default-key-change-me"
  });

  app.decorate("authenticate", async function (request: FastifyRequest, reply: FastifyReply) {
    try {
      await request.jwtVerify();
    } catch (err) {
      reply.send(err);
    }
  });

  await app.register(rateLimit, {
    max: 500,
    timeWindow: "1 minute",
    keyGenerator: (request) => {
      return request.ip;
    },
    // Exempt loopback connections from rate limiting entirely.
    // Rapa is a local-first dev tool — the frontend polling agent runs,
    // the registry, and the conversation list from localhost should never
    // be throttled.  External IPs (if the server is ever exposed) still
    // get the 500 req/min budget.
    allowList: (_req, _key) => {
      const ip = _req.ip;
      return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    },
    errorResponseBuilder: () => {
      return {
        statusCode: 429,
        error: "Too Many Requests",
        message: "Rate limit exceeded. Try again in 1 minute."
      };
    }
  });

  const allowedOrigins = env?.corsOrigins ?? (process.env.CORS_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} is not allowed by CORS`), false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
  });

  await app.register(async (api) => {
    // Public routes — no authentication required
    await registerHealthRoutes(api);
    await registerAuthRoutes(api);

    // Protected routes — JWT authentication required
    await api.register(async (protectedApi) => {
      protectedApi.addHook("preValidation", async (request, reply) => {
        // WebSocket upgrade requests can't carry Authorization headers —
        // accept the JWT token as a query parameter instead.
        if (request.headers.upgrade?.toLowerCase() === "websocket") {
          const query = request.query as Record<string, string> | undefined;
          const token = query?.token;
          if (token) {
            try {
              request.headers.authorization = `Bearer ${token}`;
            } catch {
              // ignore — jwtVerify below will fail naturally
            }
          }
        }
        await app.authenticate(request, reply);
      });
      await registerSettingsRoutes(protectedApi);
      await registerConversationRoutes(protectedApi);
      await registerChatRoutes(protectedApi);
      await registerWorkspaceRoutes(protectedApi);
      await registerAgentRoutes(protectedApi);
      await registerTerminalRoutes(protectedApi);
      await registerServiceKeyRoutes(protectedApi);
      await registerMcpRoutes(protectedApi);
      await registerAgentControlRoutes(protectedApi);
    });
  }, { prefix: "/api" });

  if (existsSync(webDistDir)) {
    await app.register(fastifyStatic, {
      root: webDistDir
    });

    app.setNotFoundHandler((request, reply) => {
      if (request.raw.method === "GET" && !request.raw.url?.startsWith("/api")) {
        return reply.sendFile("index.html");
      }

      return reply.code(404).send({ message: "Not found" });
    });
  }

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
    // Flush the tracing exporter so in-flight spans ship to Langfuse before
    // the process exits. Failures here are best-effort.
    const tracing = await import("./lib/agent/tracing.js");
    if (tracing.getActiveExporter) {
      try {
        await tracing.getActiveExporter().shutdown?.();
      } catch (err) {
        app.log.warn({ err }, "Tracing exporter shutdown failed");
      }
    }
  });

  process.on("SIGINT", async () => {
    app.log.info("SIGINT received, shutting down gracefully...");
    await app.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    app.log.info("SIGTERM received, shutting down gracefully...");
    await app.close();
    process.exit(0);
  });

  return app;
}

export async function bootstrap(options?: { port?: number; host?: string; skipEnvValidation?: boolean }): Promise<FastifyInstance> {
  let env;
  try {
    env = loadAndValidateEnv();
  } catch (err) {
    if (err instanceof EnvValidationError) {
      // Print the human-readable error and exit non-zero.
      // eslint-disable-next-line no-console
      console.error("\n" + err.message + "\n");
      process.exit(2);
    }
    throw err;
  }

  const app = await createServer({ skipEnvValidation: true });
  const port = options?.port ?? env.port;
  // Default to loopback (127.0.0.1) for personal-machine safety.
  // Override by passing `bootstrap({ host: "0.0.0.0" })` or by
  // setting `HOST=0.0.0.0` in `server/.env`.
  const host = options?.host ?? env.host;

  try {
    await app.listen({ port, host });
    app.log.info(`API listening on http://localhost:${port}`);
    return app;
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

const isEntrypoint = process.argv[1] != null && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isEntrypoint) {
  void bootstrap();
}
