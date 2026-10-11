/**
 * Asks the SSO issuer whether an identity token's session is still live (issue #20 step 5, ADR 0023).
 *
 * A verified identity token stays valid until it expires (ten minutes at poietic.tech), even after the agent token it
 * was exchanged for is revoked or its owner loses the right to own agents. Before a write, the tracker asks the
 * issuer's `GET /session/live` with the token as `Authorization: Bearer`; the issuer answers 200 `{ "live": boolean }`.
 *
 * Answers are cached per token for `ttlMs` (default 30 s) against the injected clock, so an agent making many writes
 * costs one round trip per half-minute, and a revocation takes effect within that. The fetch is aborted after
 * `fetchTimeoutMs` like the JWKS fetch (`verifier.ts`). Anything but a well-formed 200 throws: the caller fails
 * closed with 503 rather than letting a write through unchecked.
 */

export interface SsoLiveness {
  /** Whether the issuer still vouches for this token. Throws when the issuer can't be asked or answers oddly. */
  isLive(token: string, now: Date): Promise<boolean>;
}

export function createSsoLiveness(opts: {
  url: string;
  fetchImpl?: typeof fetch;
  /** Abort the request after this many milliseconds (default 5000). */
  fetchTimeoutMs?: number;
  /** How long an answer is reused (default 30 000). */
  ttlMs?: number;
  /** Most answers kept; the oldest are dropped first (default 10 000). */
  maxEntries?: number;
}): SsoLiveness {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.fetchTimeoutMs ?? 5000;
  const ttlMs = opts.ttlMs ?? 30_000;
  const maxEntries = opts.maxEntries ?? 10_000;
  // Insertion-ordered, so the first key is the oldest answer.
  const cache = new Map<string, { live: boolean; expiresAt: number }>();

  async function ask(token: string): Promise<boolean> {
    const res = await fetchImpl(opts.url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200) throw new Error(`${opts.url} answered ${res.status}`);
    const body = (await res.json()) as { live?: unknown } | null;
    if (typeof body?.live !== 'boolean') throw new Error(`${opts.url} answered without "live"`);
    return body.live;
  }

  return {
    async isLive(token, now) {
      const at = now.getTime();
      const hit = cache.get(token);
      if (hit && hit.expiresAt > at) return hit.live;
      const live = await ask(token);
      cache.delete(token);
      for (const [key, entry] of cache) {
        if (cache.size < maxEntries && entry.expiresAt > at) break;
        cache.delete(key);
      }
      cache.set(token, { live, expiresAt: at + ttlMs });
      return live;
    },
  };
}
