import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIssue, createProject, LocalDiskBlobStore } from '@poietic-tech/issues-core';
import { createTestContext, type TestContext } from '@poietic-tech/issues-core/testing';
import { testDialect } from '@poietic-tech/issues-db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { testSso } from './testing.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const dir = mkdtempSync(join(tmpdir(), 'tracker-api-blobs-'));
let t: TestContext;
let app: ReturnType<typeof createApp>;
let token: string;
let issueKey: string;

beforeAll(async () => {
  t = await createTestContext();
  await createProject(t.ctx, { key: 'UP', name: 'Uploads' });
  issueKey = (await createIssue(t.ctx, 'UP', { title: 'Files' })).key;
  const sso = testSso(t);
  app = createApp({
    db: t.db,
    blobStore: new LocalDiskBlobStore(dir),
    maxUploadBytes: 1024,
    auth: { mode: 'standard', sso: sso.options },
  });
  token = await sso.bearer('admin');
});
afterAll(async () => {
  await t.destroy();
  rmSync(dir, { recursive: true, force: true });
});

async function upload(name: string, bytes: Uint8Array, type = 'application/octet-stream') {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), name);
  return app.request(`http://t/api/v1/issues/${issueKey}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
}
const get = (path: string) =>
  app.request(`http://t/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });

describe(`attachments API (${testDialect()})`, () => {
  it('uploads and serves images inline with protective headers', async () => {
    const res = await upload('shot.png', PNG, 'text/html'); // declared type is ignored
    expect(res.status).toBe(201);
    const att = (await res.json()) as { id: string; contentType: string; url: string };
    expect(att.contentType).toBe('image/png');
    const content = await get(att.url.replace('/api/v1', ''));
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('image/png');
    expect(content.headers.get('content-disposition')).toMatch(/^inline; filename="shot.png"/);
    expect(content.headers.get('x-content-type-options')).toBe('nosniff');
    expect(content.headers.get('content-security-policy')).toContain('sandbox');
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(PNG);
    const list = (await (await get(`/issues/${issueKey}/attachments`)).json()) as {
      data: unknown[];
    };
    expect(list.data).toHaveLength(1);
  });

  it('never serves markup inline (SVG/HTML become downloads as text/plain)', async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    );
    const att = (await (await upload('evil.svg', svg, 'image/svg+xml')).json()) as {
      url: string;
      contentType: string;
    };
    expect(att.contentType).toBe('text/plain');
    const content = await get(att.url.replace('/api/v1', ''));
    expect(content.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(content.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('rejects oversized and malformed uploads', async () => {
    const big = await upload('big.bin', new Uint8Array(4096));
    expect(big.status).toBe(413);
    expect(((await big.json()) as { code: string }).code).toBe('PAYLOAD_TOO_LARGE');
    const notMultipart = await app.request(`http://t/api/v1/issues/${issueKey}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(notMultipart.status).toBe(415);
  });

  it('deletes attachments', async () => {
    const att = (await (await upload('del.png', PNG)).json()) as { id: string };
    const res = await app.request(`http://t/api/v1/attachments/${att.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect((await get(`/attachments/${att.id}`)).status).toBe(404);
  });
});
