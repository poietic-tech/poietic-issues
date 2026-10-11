/**
 * Verifies the SSO issuer's cookie JWT with `@poietic-tech/auth` (ADR 0022).
 *
 * The package checks ES256, `iss`, `aud`, `exp` and `iat` against the issuer's JWKS and returns claims or null. Its
 * JWKS cache lives in module scope, so one process verifies for one issuer. This wrapper adds the bound the package
 * lacks: a JWKS fetch that never answers is aborted, so `POST /auth/sso` answers 503 instead of hanging.
 */

import { verifyIdentityToken, type IdentityClaims } from '@poietic-tech/auth';

export type SsoClaims = IdentityClaims;

export interface SsoVerifier {
  /** Claims, or null when the token is not genuine or not currently valid. Throws only when no keys could be fetched. */
  verify(token: string): Promise<SsoClaims | null>;
}

export function createSsoVerifier(opts: {
  jwksUrl: string;
  issuer: string;
  audience: string;
  fetchImpl?: typeof fetch;
  /** Abort a JWKS fetch after this many milliseconds (default 5000). */
  fetchTimeoutMs?: number;
}): SsoVerifier {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.fetchTimeoutMs ?? 5000;
  const timedFetch: typeof fetch = (input, init) =>
    fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  return {
    verify: (token) =>
      verifyIdentityToken(token, opts.jwksUrl, {
        issuer: opts.issuer,
        audience: opts.audience,
        fetchImpl: timedFetch,
      }),
  };
}
