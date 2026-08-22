// Shared CORS origin resolution for SSE endpoints.
//
// SSE responses are written on `reply.raw` (bypassing Fastify's CORS plugin),
// so streaming routes set the header manually. The old code reflected ANY
// request origin (`request.headers.origin ?? "*"`), defeating the configured
// CORS_ORIGINS allowlist. These helpers restore allowlist semantics: an
// origin is echoed only when it matches the configured list.

export function getAllowedOrigins(): string[] {
  return (process.env.CORS_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Return the value for Access-Control-Allow-Origin, or undefined to omit the
 * header entirely (unrecognized origins get no CORS grant).
 */
export function resolveSseAllowOrigin(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  return getAllowedOrigins().includes(origin) ? origin : undefined;
}
