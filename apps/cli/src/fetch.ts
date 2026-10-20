import { randomUUID } from 'node:crypto';
import { CliError } from './errors.ts';

const RETRY_DELAYS_MS = [250, 1000];
const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Remote fetch with agent-safe retries (for a remote host of the command tree; the operator tool itself is
 * local only): every POST carries an Idempotency-Key, and requests that fail at the
 * network level (no response) are retried up to twice with the same key — so a retried create never
 * duplicates. HTTP error responses are never retried.
 */
export function retryingFetch(
  inner: (r: Request) => Promise<Response> = (r) => fetch(r),
  /** Whether a thrown error is worth another attempt: by default anything but a CliError, which is a decision
   *  (e.g. a refused agent token), not a network failure. */
  retryable: (error: unknown) => boolean = (error) => !(error instanceof CliError),
) {
  return async (request: Request): Promise<Response> => {
    if (request.method === 'POST' && !request.headers.has('idempotency-key'))
      request.headers.set('idempotency-key', randomUUID());
    const body = MUTATING.has(request.method) ? await request.clone().arrayBuffer() : undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        const init: RequestInit = { method: request.method, headers: request.headers };
        if (body) init.body = body;
        return await inner(new Request(request.url, init));
      } catch (error) {
        if (!retryable(error) || attempt >= RETRY_DELAYS_MS.length) throw error;
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
  };
}
