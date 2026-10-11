import { describe, expect, it } from 'vitest';
import { createSsoLiveness } from './liveness.ts';

const URL_ = 'https://auth.example.test/session/live';
const T0 = new Date('2026-10-11T12:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

/** A fake issuer: answers `live` for each token from `state`, recording every request. */
function issuer(state: Record<string, boolean>) {
  const calls: { url: string; authorization: string | null }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const authorization = new Headers(init?.headers).get('authorization');
    calls.push({ url: String(input), authorization });
    const token = authorization?.replace(/^Bearer /, '') ?? '';
    return Response.json({ live: state[token] ?? false });
  };
  return { calls, fetchImpl };
}

describe('SSO session liveness', () => {
  it('asks the issuer with the token as a bearer and returns its answer', async () => {
    const { calls, fetchImpl } = issuer({ a: true, b: false });
    const liveness = createSsoLiveness({ url: URL_, fetchImpl });
    expect(await liveness.isLive('a', T0)).toBe(true);
    expect(await liveness.isLive('b', T0)).toBe(false);
    expect(calls).toEqual([
      { url: URL_, authorization: 'Bearer a' },
      { url: URL_, authorization: 'Bearer b' },
    ]);
  });

  it('reuses an answer for the TTL by the given clock, then asks again', async () => {
    const state = { a: true };
    const { calls, fetchImpl } = issuer(state);
    const liveness = createSsoLiveness({ url: URL_, fetchImpl, ttlMs: 30_000 });
    expect(await liveness.isLive('a', T0)).toBe(true);
    state.a = false;
    expect(await liveness.isLive('a', at(29_999))).toBe(true);
    expect(calls).toHaveLength(1);
    expect(await liveness.isLive('a', at(30_000))).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('throws on a non-200 answer or a body without a boolean "live"', async () => {
    const answers = [
      new Response('nope', { status: 502 }),
      Response.json({ live: 'yes' }),
      new Response('not json'),
    ];
    const liveness = createSsoLiveness({ url: URL_, fetchImpl: async () => answers.shift()! });
    await expect(liveness.isLive('a', T0)).rejects.toThrow(/502/);
    await expect(liveness.isLive('a', T0)).rejects.toThrow(/live/);
    await expect(liveness.isLive('a', T0)).rejects.toThrow();
  });

  it('does not cache a failure', async () => {
    let fail = true;
    const liveness = createSsoLiveness({
      url: URL_,
      fetchImpl: async () =>
        fail ? new Response('', { status: 503 }) : Response.json({ live: true }),
    });
    await expect(liveness.isLive('a', T0)).rejects.toThrow();
    fail = false;
    expect(await liveness.isLive('a', T0)).toBe(true);
  });

  it('aborts a request that never answers', async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)),
      );
    const liveness = createSsoLiveness({ url: URL_, fetchImpl: hang, fetchTimeoutMs: 20 });
    await expect(liveness.isLive('a', T0)).rejects.toThrow();
  });

  it('keeps at most maxEntries answers, dropping the oldest', async () => {
    const { calls, fetchImpl } = issuer({ a: true, b: true, c: true });
    const liveness = createSsoLiveness({ url: URL_, fetchImpl, maxEntries: 2 });
    for (const token of ['a', 'b', 'c']) await liveness.isLive(token, T0);
    expect(calls).toHaveLength(3);
    await liveness.isLive('c', T0);
    await liveness.isLive('b', T0);
    expect(calls).toHaveLength(3);
    await liveness.isLive('a', T0);
    expect(calls).toHaveLength(4);
  });
});
