import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env.ts';

/** Every method the API routes use. */
export const CORS_ALLOW_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE';
/**
 * Request headers a browser client sends: JSON bodies, a write's reason, optimistic concurrency, safe retries and
 * request correlation. `Authorization` is not needed for the cookie flow but lets a page send an identity token.
 */
export const CORS_ALLOW_HEADERS =
  'Content-Type, Authorization, X-Change-Reason, If-Match, Idempotency-Key, X-Request-Id';
/** Response headers a cross-origin script may read beyond the CORS-safelisted ones. */
export const CORS_EXPOSE_HEADERS = 'ETag, Location, X-Request-Id';
/** How long (seconds) a browser may cache a preflight answer. */
export const CORS_MAX_AGE = '600';

/**
 * CORS with credentials for exactly the origins in `POIETIC_ISSUES_ALLOWED_ORIGINS` (the CSRF allow-list), so a page
 * on another subdomain can call the API as the signed-in person. An allowed `Origin` is echoed back (never `*`) with
 * `Access-Control-Allow-Credentials: true`; a preflight from it is answered here with 204, before authentication. Any
 * other origin, and a request without one, gets no CORS headers and passes through unchanged. This only lets the
 * browser hand the response to the page: whether a cookie-authenticated write is accepted is still decided by the
 * same-origin check in `authenticate`.
 */
export function cors(allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins);
  return createMiddleware<AppEnv>(async (c, next) => {
    if (allowed.size === 0) return next();
    const origin = c.req.header('origin');
    if (origin === undefined || !allowed.has(origin)) {
      await next();
      // Responses differ by Origin, so a shared cache must not serve one origin's answer to another.
      c.header('Vary', 'Origin', { append: true });
      return;
    }
    if (c.req.method === 'OPTIONS' && c.req.header('access-control-request-method') !== undefined)
      return c.body(null, 204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods': CORS_ALLOW_METHODS,
        'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
        'Access-Control-Max-Age': CORS_MAX_AGE,
        Vary: 'Origin',
      });
    await next();
    // After the handler, so error and problem responses carry them too and the page can read the problem.
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Access-Control-Expose-Headers', CORS_EXPOSE_HEADERS);
    c.header('Vary', 'Origin', { append: true });
  });
}
