import { describe, expect, it } from 'vitest';
import { createClient } from './index.ts';

async function requestedUrl(baseUrl: string): Promise<string> {
  let url = '';
  const client = createClient({
    baseUrl,
    fetch: async (request) => {
      url = request.url;
      return Response.json({});
    },
  });
  await client.GET('/me' as never);
  return url;
}

describe('createClient', () => {
  it.each([
    ['http://127.0.0.1:3000', 'http://127.0.0.1:3000/api/v1/me'],
    ['http://127.0.0.1:3000/', 'http://127.0.0.1:3000/api/v1/me'],
    ['http://127.0.0.1:3000///', 'http://127.0.0.1:3000/api/v1/me'],
    ['https://example.com/tracker/', 'https://example.com/tracker/api/v1/me'],
  ])('joins %s with the API prefix', async (baseUrl, expected) =>
    expect(await requestedUrl(baseUrl)).toBe(expected),
  );

  it('trims a long run of slashes in linear time', async () => {
    const started = performance.now();
    // Slashes not at the end are kept, so the run defeats a backtracking /\/+$/ without being trimmed.
    const url = await requestedUrl(`http://h${'/'.repeat(100_000)}x`);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(url.endsWith('x/api/v1/me')).toBe(true);
  });
});
