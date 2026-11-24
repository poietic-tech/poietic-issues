import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDialect } from '@poietic-tech/issues-db/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';
import { startServer } from './server.ts';

const dir = mkdtempSync(join(tmpdir(), 'tracker-server-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.runIf(testDialect() === 'sqlite')('server lifecycle', () => {
  it('validates configuration', () => {
    expect(() => loadConfig({ POIETIC_ISSUES_PORT: 'abc' })).toThrow(/POIETIC_ISSUES_PORT/);
    expect(() => loadConfig({ NODE_ENV: 'production', POIETIC_ISSUES_AUTH_MODE: 'dev' })).toThrow(
      /not allowed/,
    );
    expect(() =>
      loadConfig({ NODE_ENV: 'production', POIETIC_ISSUES_WEBHOOK_ALLOW_PRIVATE: '1' }),
    ).toThrow(/not allowed/);
    expect(() => loadConfig({ POIETIC_ISSUES_BLOB_STORE: 's3' })).toThrow(
      /POIETIC_ISSUES_S3_ENDPOINT/,
    );
    expect(() => loadConfig({ POIETIC_ISSUES_BLOB_STORE: 'artifacts' })).toThrow(
      /POIETIC_ISSUES_ARTIFACTS_AGENT_TOKEN is required/,
    );
    expect(() =>
      loadConfig({
        POIETIC_ISSUES_BLOB_STORE: 'artifacts',
        POIETIC_ISSUES_ARTIFACTS_AGENT_TOKEN: 'tok',
        POIETIC_ISSUES_BLOB_FALLBACK: 's3',
      }),
    ).toThrow(/POIETIC_ISSUES_S3_ENDPOINT is required when POIETIC_ISSUES_BLOB_FALLBACK=s3/);
    expect(() => loadConfig({ POIETIC_ISSUES_BLOB_FALLBACK: 's3' })).toThrow(
      /needs POIETIC_ISSUES_BLOB_STORE=artifacts/,
    );
    expect(loadConfig({ NODE_ENV: 'production' })).toMatchObject({
      POIETIC_ISSUES_AUTH_MODE: 'standard',
      POIETIC_ISSUES_LOG_FORMAT: 'json',
      POIETIC_ISSUES_SEED: false,
      POIETIC_ISSUES_WEBHOOK_ALLOW_PRIVATE: false,
    });
  });

  it('reports readiness and shuts down gracefully, ending live streams', async () => {
    const server = await startServer(
      loadConfig({
        POIETIC_ISSUES_DATABASE_URL: `sqlite:${join(dir, 'life.db')}`,
        POIETIC_ISSUES_PORT: '0',
        POIETIC_ISSUES_SEED: '1',
        POIETIC_ISSUES_SHUTDOWN_TIMEOUT_MS: '5000',
        POIETIC_ISSUES_BLOB_DIR: join(dir, 'blobs'),
      }),
    );
    expect((await fetch(`${server.url}/readyz`)).status).toBe(200);
    const login = await fetch(`${server.url}/api/v1/auth/dev-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body: JSON.stringify({ user: 'ada' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const stream = await fetch(`${server.url}/api/v1/events/stream`, { headers: { cookie } });
    const reader = stream.body!.getReader();
    let text = '';
    const readAll = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        text += new TextDecoder().decode(value);
      }
    })();
    while (!text.includes('event: ready')) await new Promise((r) => setTimeout(r, 20));

    const started = Date.now();
    await server.close();
    await readAll;
    expect(Date.now() - started).toBeLessThan(3000);
    expect(text).toContain('event: shutdown');
    expect(text).toContain('retry: 1000');
    await expect(fetch(`${server.url}/healthz`)).rejects.toThrow();
  });
});
