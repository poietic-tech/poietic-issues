import { describe, expect, it } from 'vitest';
import { CliError } from './errors.ts';
import { retryingFetch } from './transport.ts';

const URL = 'https://issues.example.test/api/v1/issues';

/** A fake network: fails the first `failures` requests at the network level, then answers `status`. */
function network(failures: number, status = 201, failWith: () => Error = () => new TypeError()) {
  const seen: { method: string; key: string | null; body: string }[] = [];
  const inner = async (request: Request) => {
    seen.push({
      method: request.method,
      key: request.headers.get('idempotency-key'),
      body: await request.text(),
    });
    if (seen.length <= failures) throw failWith();
    return new Response(null, { status });
  };
  return { seen, inner };
}

describe('retryingFetch', () => {
  it('retries a POST that fails at the network level, with the same key and body', async () => {
    const { seen, inner } = network(2);
    const fetch = retryingFetch(inner);
    const response = await fetch(new Request(URL, { method: 'POST', body: '{"title":"x"}' }));
    expect(response.status).toBe(201);
    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((s) => s.key)).size).toBe(1);
    expect(seen[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen.map((s) => s.body)).toEqual(Array(3).fill('{"title":"x"}'));
  }, 10_000);

  it('keeps an idempotency key the caller set, and never adds one to a GET', async () => {
    const post = network(0);
    await retryingFetch(post.inner)(
      new Request(URL, { method: 'POST', headers: { 'idempotency-key': 'mine' }, body: '{}' }),
    );
    expect(post.seen[0]!.key).toBe('mine');
    const get = network(0, 200);
    await retryingFetch(get.inner)(new Request(URL));
    expect(get.seen[0]!.key).toBeNull();
  });

  it('never retries an HTTP error response', async () => {
    const { seen, inner } = network(0, 500);
    expect((await retryingFetch(inner)(new Request(URL, { method: 'POST' }))).status).toBe(500);
    expect(seen).toHaveLength(1);
  });

  it('never retries a CliError (a decision, not a network failure)', async () => {
    const { seen, inner } = network(5, 200, () => new CliError('UNAUTHENTICATED', 'refused'));
    await expect(retryingFetch(inner)(new Request(URL))).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(seen).toHaveLength(1);
  });

  it('gives up after two retries', async () => {
    const { seen, inner } = network(5);
    await expect(retryingFetch(inner)(new Request(URL))).rejects.toBeInstanceOf(TypeError);
    expect(seen).toHaveLength(3);
  }, 10_000);
});
