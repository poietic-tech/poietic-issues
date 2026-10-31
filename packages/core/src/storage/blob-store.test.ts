import { describe, expect, it } from 'vitest';
import { trimTrailingSlashes } from './blob-store.ts';

describe('trimTrailingSlashes', () => {
  it.each([
    ['http://s3:8333', 'http://s3:8333'],
    ['http://s3:8333/', 'http://s3:8333'],
    ['http://s3:8333///', 'http://s3:8333'],
    ['http://s3:8333/a/b/', 'http://s3:8333/a/b'],
    ['///', ''],
    ['', ''],
  ])('trims %s', (input, expected) => expect(trimTrailingSlashes(input)).toBe(expected));

  it('runs in linear time on a long run of slashes', () => {
    const started = performance.now();
    const input = `http://h${'/'.repeat(100_000)}x`;
    expect(trimTrailingSlashes(input)).toBe(input);
    expect(trimTrailingSlashes(`${input}${'/'.repeat(100_000)}`)).toBe(input);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
