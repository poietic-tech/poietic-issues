import { createHash } from 'node:crypto';
import { ArtifactsClient } from '@poietic-tech/artifacts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactsBlobStore, FallbackBlobStore } from './artifacts-blob-store.ts';
import { type BlobStore, S3BlobStore } from './blob-store.ts';
import { copyBlobs } from './copy-blobs.ts';

const enc = new TextEncoder();
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** An in-memory artifacts.poietic.tech, enough for the routes the store uses. */
function fakeArtifacts() {
  const files = new Map<string, { id: string; sha256: string; data: Uint8Array; type: string }>();
  let n = 0;
  const calls: string[] = [];
  const problem = (status: number) =>
    new Response(JSON.stringify({ error: 'not_found', message: 'gone' }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.pathname}`);
    const file = /^\/v1\/collections\/([^/]+)\/files\/(.+)$/.exec(url.pathname);
    if (file && method === 'PUT') {
      const data = new Uint8Array(init!.body as Uint8Array);
      const headers = init!.headers as Record<string, string>;
      if (headers['x-content-sha256'] !== sha(data)) return problem(400);
      const id = `art_00${String(++n).padStart(26, '0')}`;
      const entry = { id, sha256: sha(data), data, type: headers['content-type']! };
      files.set(`${file[1]}/${decodeURIComponent(file[2]!)}`, entry);
      return Response.json({ id, sha256: entry.sha256 });
    }
    if (file && method === 'GET') {
      const f = files.get(`${file[1]}/${decodeURIComponent(file[2]!)}`);
      return f ? Response.json({ id: f.id, sha256: f.sha256 }) : problem(404);
    }
    const del = /^\/v1\/artifacts\/(art_\w+)$/.exec(url.pathname);
    if (del && method === 'DELETE') {
      for (const [k, f] of files) if (f.id === del[1]) files.delete(k);
      return new Response(null, { status: 204 });
    }
    const f = files.get(decodeURIComponent(url.pathname.slice(1)));
    return f ? new Response(f.data as Uint8Array<ArrayBuffer>) : problem(404);
  };
  const client = new ArtifactsClient({ fetch, origin: 'https://artifacts.test' });
  return { files, calls, store: new ArtifactsBlobStore(client, 'issues-attachments') };
}

describe('ArtifactsBlobStore', () => {
  it('puts, gets and deletes a blob under its key in the collection', async () => {
    const { files, store } = fakeArtifacts();
    const data = enc.encode('hello');
    await store.put('att/ab/abc', data, 'text/plain');
    expect([...files.keys()]).toEqual(['issues-attachments/att/ab/abc']);
    expect(await store.get('att/ab/abc')).toEqual(data);
    expect(await store.sha256('att/ab/abc')).toBe(sha(data));
    await store.delete('att/ab/abc');
    expect(await store.get('att/ab/abc')).toBeNull();
    expect(await store.sha256('att/ab/abc')).toBeNull();
  });

  it('treats a missing blob as null, and deleting it as done', async () => {
    const { store } = fakeArtifacts();
    expect(await store.get('att/no/such')).toBeNull();
    await expect(store.delete('att/no/such')).resolves.toBeUndefined();
  });

  it('has no presigned URLs: the tracker streams the bytes itself', () => {
    expect((fakeArtifacts().store as BlobStore).presignedGetUrl).toBeUndefined();
  });
});

describe('FallbackBlobStore', () => {
  const memory = (): BlobStore & { data: Map<string, Uint8Array> } => {
    const data = new Map<string, Uint8Array>();
    return {
      kind: 's3',
      data,
      put: async (k, d) => void data.set(k, d),
      get: async (k) => data.get(k) ?? null,
      delete: async (k) => void data.delete(k),
    };
  };

  it('reads the fallback when the primary has nothing, and never writes to it', async () => {
    const primary = memory();
    const fallback = memory();
    fallback.data.set('old', enc.encode('old'));
    const store = new FallbackBlobStore(primary, fallback);
    expect(await store.get('old')).toEqual(enc.encode('old'));
    await store.put('new', enc.encode('new'), 'text/plain');
    expect(fallback.data.has('new')).toBe(false);
    await store.delete('old');
    expect(fallback.data.has('old')).toBe(true);
    expect(await store.get('new')).toEqual(enc.encode('new'));
  });
});

describe('copyBlobs', () => {
  const source = (blobs: Record<string, string>) => ({
    async *keys() {
      yield* Object.keys(blobs);
    },
    get: async (k: string) => (k in blobs ? enc.encode(blobs[k]!) : null),
  });

  it('copies each key once, and a re-run skips what is already there', async () => {
    const { files, store } = fakeArtifacts();
    const from = source({ 'att/aa/1': 'one', 'att/bb/2': '%PDF-1.7 two' });
    const first = await copyBlobs(from, store);
    expect(first).toEqual({ copied: ['att/aa/1', 'att/bb/2'], skipped: 0, failed: [] });
    expect(files.get('issues-attachments/att/bb/2')!.type).toBe('application/pdf');
    const again = await copyBlobs(from, store);
    expect(again).toEqual({ copied: [], skipped: 2, failed: [] });
  });

  it('writes nothing on a dry run', async () => {
    const { files, store } = fakeArtifacts();
    const result = await copyBlobs(source({ 'att/aa/1': 'one' }), store, { dryRun: true });
    expect(result.copied).toEqual(['att/aa/1']);
    expect(files.size).toBe(0);
  });

  it('records a failure and carries on', async () => {
    const { store } = fakeArtifacts();
    const from = {
      async *keys() {
        yield 'att/aa/bad';
        yield 'att/aa/good';
      },
      get: async (k: string) => {
        if (k.endsWith('bad')) throw new Error('S3 GET failed: 500');
        return enc.encode('fine');
      },
    };
    const result = await copyBlobs(from, store);
    expect(result.copied).toEqual(['att/aa/good']);
    expect(result.failed).toEqual([{ key: 'att/aa/bad', error: 'S3 GET failed: 500' }]);
  });
});

describe('S3BlobStore.keys', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('follows continuation tokens across pages', async () => {
    const pages = [
      '<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>att/aa/1</Key></Contents><NextContinuationToken>t&amp;2</NextContinuationToken></ListBucketResult>',
      '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>att/bb/2</Key></Contents></ListBucketResult>',
    ];
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (req: Request) => {
      urls.push(req.url);
      return new Response(pages[urls.length - 1]);
    });
    const s3 = new S3BlobStore({
      endpoint: 'https://r2.test',
      bucket: 'b',
      accessKeyId: 'k',
      secretAccessKey: 's',
    });
    const keys: string[] = [];
    for await (const k of s3.keys('att/')) keys.push(k);
    expect(keys).toEqual(['att/aa/1', 'att/bb/2']);
    expect(new URL(urls[0]!).pathname).toBe('/b');
    expect(new URL(urls[0]!).searchParams.get('prefix')).toBe('att/');
    expect(new URL(urls[1]!).searchParams.get('continuation-token')).toBe('t&2');
  });
});
