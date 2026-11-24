import type { ArtifactsBlobStore } from './artifacts-blob-store.ts';
import { sha256Hex } from './blob-store.ts';
import { sniffContentType } from './content-type.ts';

export interface CopySource {
  keys(prefix?: string): AsyncIterable<string>;
  get(key: string): Promise<Uint8Array | null>;
}

export interface CopyResult {
  copied: string[];
  /** Already in the target with the same SHA-256. */
  skipped: number;
  failed: { key: string; error: string }[];
}

/**
 * Copies every blob from a source bucket into the artifacts store under the same key (ADR 0037). Idempotent: a key
 * the target already holds with the same SHA-256 is skipped, so the copy can be re-run until nothing is left. Bytes
 * are checked against their hash after the round trip. One failure doesn't stop the rest.
 */
export async function copyBlobs(
  from: CopySource,
  to: ArtifactsBlobStore,
  opts: { prefix?: string; dryRun?: boolean; onKey?: (key: string, outcome: string) => void } = {},
): Promise<CopyResult> {
  const result: CopyResult = { copied: [], skipped: 0, failed: [] };
  for await (const key of from.keys(opts.prefix ?? 'att/')) {
    try {
      const data = await from.get(key);
      if (!data) continue; // deleted while listing
      const sha = sha256Hex(data);
      if ((await to.sha256(key)) === sha) {
        result.skipped++;
        opts.onKey?.(key, 'skipped');
        continue;
      }
      if (!opts.dryRun) {
        await to.put(key, data, sniffContentType(data, ''));
        const stored = await to.sha256(key);
        if (stored !== sha) throw new Error(`stored SHA-256 ${stored ?? 'missing'} ≠ ${sha}`);
      }
      result.copied.push(key);
      opts.onKey?.(key, opts.dryRun ? 'would copy' : 'copied');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failed.push({ key, error: message });
      opts.onKey?.(key, `failed: ${message}`);
    }
  }
  return result;
}
