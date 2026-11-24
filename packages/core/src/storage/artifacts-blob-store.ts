import { type ArtifactsClient, ArtifactsError } from '@poietic-tech/artifacts';
import type { BlobStore } from './blob-store.ts';

/** The part of `ArtifactsClient` the store uses (a fake in tests). */
export type ArtifactsApi = Pick<ArtifactsClient, 'put' | 'get' | 'content' | 'delete'>;

const isNotFound = (error: unknown) => error instanceof ArtifactsError && error.status === 404;

/**
 * Attachment bytes in an artifacts.poietic.tech collection (ADR 0037). Each blob key is an artifact name in one
 * collection, which is restricted (`read: grants`): only the tracker's own agent holds a grant, so every access
 * decision stays in the tracker, which streams the bytes itself. Artifacts deletes are soft, so `delete` removes the
 * attachment from the index while its bytes stay in Artifacts' bucket.
 */
export class ArtifactsBlobStore implements BlobStore {
  readonly kind = 'artifacts' as const;
  readonly #api: ArtifactsApi;
  readonly #collection: string;

  constructor(api: ArtifactsApi, collection: string) {
    this.#api = api;
    this.#collection = collection;
  }

  #ref(key: string) {
    return `${this.#collection}/${key}`;
  }

  async put(key: string, data: Uint8Array, contentType: string): Promise<void> {
    await this.#api.put(this.#collection, key, data, { contentType, meta: { kind: 'attachment' } });
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const res = await this.#api.content(this.#ref(key));
      return new Uint8Array(await res.arrayBuffer());
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** The stored file's SHA-256 (of the original bytes), or null when there is none. */
  async sha256(key: string): Promise<string | null> {
    try {
      return (await this.#api.get(this.#ref(key))).sha256;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const artifact = await this.#api.get(this.#ref(key));
      await this.#api.delete(artifact.id);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

/**
 * Reads fall back to a second store while files are being copied into the primary one. Writes and deletes go to the
 * primary only: the fallback is read-only, and is retired once the copy is done.
 */
export class FallbackBlobStore implements BlobStore {
  readonly kind: BlobStore['kind'];
  readonly #primary: BlobStore;
  readonly #fallback: BlobStore;

  constructor(primary: BlobStore, fallback: BlobStore) {
    this.kind = primary.kind;
    this.#primary = primary;
    this.#fallback = fallback;
  }

  put(key: string, data: Uint8Array, contentType: string): Promise<void> {
    return this.#primary.put(key, data, contentType);
  }

  async get(key: string): Promise<Uint8Array | null> {
    return (await this.#primary.get(key)) ?? this.#fallback.get(key);
  }

  delete(key: string): Promise<void> {
    return this.#primary.delete(key);
  }
}
