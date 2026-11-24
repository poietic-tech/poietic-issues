import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { ArtifactsClient } from '@poietic-tech/artifacts';
import { agentFromEnv } from '@poietic-tech/auth';
import { AwsClient } from 'aws4fetch';
import { ArtifactsBlobStore, FallbackBlobStore } from './artifacts-blob-store.ts';

/**
 * Where attachment bytes live. Metadata is in the `attachments` table; bytes are stored under random keys
 * (never user-supplied names). Implementations: local disk (development, single node) and S3-compatible
 * object storage (AWS S3, R2, SeaweedFS, MinIO, …), and an artifacts.poietic.tech collection (ADR 0037).
 */
export interface BlobStore {
  readonly kind: 'local' | 's3' | 'artifacts';
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  /**
   * A short-lived URL the client can download from directly (S3), carrying the given response headers.
   * Undefined when the server must stream the bytes itself (local disk).
   */
  presignedGetUrl?(
    key: string,
    opts: { contentType: string; disposition: string; expiresIn?: number },
  ): Promise<string>;
}

/** Generates a random, path-safe storage key. */
export function newBlobKey(): string {
  const id = randomUUID().replace(/-/g, '');
  return `att/${id.slice(0, 2)}/${id}`;
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export class LocalDiskBlobStore implements BlobStore {
  readonly kind = 'local' as const;
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  #path(key: string): string {
    const path = resolve(this.#root, key);
    if (!path.startsWith(this.#root + sep)) throw new Error('Invalid blob key');
    return path;
  }

  async put(key: string, data: Uint8Array, _contentType?: string): Promise<void> {
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, path);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.#path(key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    return stat(this.#path(key)).then(
      () => true,
      () => false,
    );
  }
}

export interface S3Config {
  endpoint: string;
  bucket: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style URLs (`endpoint/bucket/key`), needed for most S3-compatible stores. Default true. */
  forcePathStyle?: boolean;
  /**
   * Serve downloads by redirecting to presigned URLs (default true). Turn off to stream bytes through the
   * server, e.g. when the object store is not reachable from browsers.
   */
  presign?: boolean;
  /** Browser-facing endpoint for presigned URLs when it differs from `endpoint` (e.g. behind a proxy). */
  publicEndpoint?: string;
}

/** Drops trailing slashes. A loop, not `/\/+$/`, which backtracks quadratically on long runs of `/`. */
export function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}

/** S3-compatible object storage using SigV4 (aws4fetch — no AWS SDK needed). */
export class S3BlobStore implements BlobStore {
  readonly kind = 's3' as const;
  readonly #client: AwsClient;
  readonly #config: S3Config;

  constructor(config: S3Config) {
    this.#config = config;
    this.#client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: config.region ?? 'us-east-1',
      service: 's3',
    });
    if (config.presign !== false) this.presignedGetUrl = (key, opts) => this.#presign(key, opts);
  }

  #url(key: string, base = this.#config.endpoint): string {
    const endpoint = trimTrailingSlashes(base);
    const path = key.split('/').map(encodeURIComponent).join('/');
    if (this.#config.forcePathStyle ?? true) return `${endpoint}/${this.#config.bucket}/${path}`;
    const url = new URL(endpoint);
    return `${url.protocol}//${this.#config.bucket}.${url.host}/${path}`;
  }

  async #check(res: Response, action: string): Promise<Response> {
    if (!res.ok)
      throw new Error(`S3 ${action} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res;
  }

  async put(key: string, data: Uint8Array, contentType: string): Promise<void> {
    const res = await this.#client.fetch(this.#url(key), {
      method: 'PUT',
      body: data as Uint8Array<ArrayBuffer>, // DOM typings (web build) reject ArrayBufferLike views
      headers: { 'content-type': contentType, 'content-length': String(data.byteLength) },
    });
    await this.#check(res, 'PUT');
  }

  async get(key: string): Promise<Uint8Array | null> {
    const res = await this.#client.fetch(this.#url(key));
    if (res.status === 404) return null;
    await this.#check(res, 'GET');
    return new Uint8Array(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const res = await this.#client.fetch(this.#url(key), { method: 'DELETE' });
    if (res.status !== 404) await this.#check(res, 'DELETE');
  }

  /** Every key under `prefix` (ListObjectsV2, a page at a time). Used to copy a bucket to another store. */
  async *keys(prefix = ''): AsyncGenerator<string, void, undefined> {
    let token: string | undefined;
    do {
      const url = new URL(this.#url('').replace(/\/$/, ''));
      url.searchParams.set('list-type', '2');
      if (prefix) url.searchParams.set('prefix', prefix);
      if (token) url.searchParams.set('continuation-token', token);
      const xml = await (
        await this.#check(await this.#client.fetch(url.toString()), 'LIST')
      ).text();
      for (const [, key] of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) yield unescapeXml(key!);
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? unescapeXml(
            /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '',
          )
        : undefined;
    } while (token);
  }

  /** Present unless presigning is turned off (then the server streams downloads itself). */
  readonly presignedGetUrl?: (
    key: string,
    opts: { contentType: string; disposition: string; expiresIn?: number },
  ) => Promise<string>;

  async #presign(
    key: string,
    opts: { contentType: string; disposition: string; expiresIn?: number },
  ): Promise<string> {
    const url = new URL(this.#url(key, this.#config.publicEndpoint));
    url.searchParams.set('X-Amz-Expires', String(opts.expiresIn ?? 300));
    url.searchParams.set('response-content-type', opts.contentType);
    url.searchParams.set('response-content-disposition', opts.disposition);
    const signed = await this.#client.sign(url.toString(), {
      method: 'GET',
      aws: { signQuery: true },
    });
    return signed.url;
  }
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const need = (env: Record<string, string | undefined>, name: string, why: string) => {
  const value = env[name];
  if (!value) throw new Error(`${name} is required when ${why}`);
  return value;
};

export function s3FromEnv(env: Record<string, string | undefined>, why: string): S3BlobStore {
  return new S3BlobStore({
    endpoint: need(env, 'POIETIC_ISSUES_S3_ENDPOINT', why),
    bucket: need(env, 'POIETIC_ISSUES_S3_BUCKET', why),
    region: env.POIETIC_ISSUES_S3_REGION ?? 'us-east-1',
    accessKeyId: need(env, 'POIETIC_ISSUES_S3_ACCESS_KEY_ID', why),
    secretAccessKey: need(env, 'POIETIC_ISSUES_S3_SECRET_ACCESS_KEY', why),
    forcePathStyle: env.POIETIC_ISSUES_S3_FORCE_PATH_STYLE !== 'false',
    presign: !['0', 'false'].includes(env.POIETIC_ISSUES_S3_PRESIGN ?? ''),
    ...(env.POIETIC_ISSUES_S3_PUBLIC_ENDPOINT && {
      publicEndpoint: env.POIETIC_ISSUES_S3_PUBLIC_ENDPOINT,
    }),
  });
}

export const DEFAULT_ARTIFACTS_COLLECTION = 'issues-attachments';

/** The artifacts store, acting as the agent whose token is POIETIC_ISSUES_ARTIFACTS_AGENT_TOKEN. */
export function artifactsFromEnv(
  env: Record<string, string | undefined>,
  why = 'POIETIC_ISSUES_BLOB_STORE=artifacts',
): ArtifactsBlobStore {
  const token = need(env, 'POIETIC_ISSUES_ARTIFACTS_AGENT_TOKEN', why);
  const agent = agentFromEnv({ POIETIC_AGENT_TOKEN: token })!;
  const client = new ArtifactsClient({
    fetch: (input, init) => agent.fetch(input, init),
    ...(env.POIETIC_ISSUES_ARTIFACTS_ORIGIN && { origin: env.POIETIC_ISSUES_ARTIFACTS_ORIGIN }),
  });
  return new ArtifactsBlobStore(
    client,
    env.POIETIC_ISSUES_ARTIFACTS_COLLECTION ?? DEFAULT_ARTIFACTS_COLLECTION,
  );
}

/** Builds the configured blob store from environment-style settings. */
export function blobStoreFromEnv(
  env: Record<string, string | undefined>,
  defaultDir = './data/blobs',
): BlobStore {
  const kind = env.POIETIC_ISSUES_BLOB_STORE ?? 'local';
  if (kind === 's3') return s3FromEnv(env, 'POIETIC_ISSUES_BLOB_STORE=s3');
  if (kind === 'artifacts') {
    const store = artifactsFromEnv(env);
    const fallback = env.POIETIC_ISSUES_BLOB_FALLBACK;
    if (!fallback) return store;
    if (fallback !== 's3')
      throw new Error(`POIETIC_ISSUES_BLOB_FALLBACK must be s3, not ${JSON.stringify(fallback)}`);
    return new FallbackBlobStore(store, s3FromEnv(env, 'POIETIC_ISSUES_BLOB_FALLBACK=s3'));
  }
  if (kind !== 'local')
    throw new Error(
      `POIETIC_ISSUES_BLOB_STORE must be local, s3 or artifacts, not ${JSON.stringify(kind)}`,
    );
  return new LocalDiskBlobStore(env.POIETIC_ISSUES_BLOB_DIR ?? defaultDir);
}
