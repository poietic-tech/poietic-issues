import { ERROR_CODES, type ErrorCode } from '@poietic-tech/issues-schema';
import { CliError } from '../errors.ts';
import type { Reference } from '../tree/runtime.ts';

/** A failure as the poietic-tech host takes it: `ctx.fail(code, message, { status })`. */
export interface HostError {
  code: string;
  message: string;
  status?: number;
}

/** Codes that keep their own (lowercased) name, with status 409 so the host exits 2. */
const CONFLICTS: ReadonlySet<ErrorCode> = new Set([
  'CONFLICT',
  'VERSION_MISMATCH',
  'IDEMPOTENCY_IN_PROGRESS',
  'IDEMPOTENCY_KEY_REUSED',
]);

/** The host code for an issues code, by meaning (the spec's error table). */
const BY_CODE: Partial<Record<ErrorCode, string>> = {
  VALIDATION_FAILED: 'bad_request',
  PAYLOAD_TOO_LARGE: 'bad_request',
  UNSUPPORTED_MEDIA_TYPE: 'bad_request',
  INVALID_RELATION: 'bad_request',
  UNAUTHENTICATED: 'not_logged_in',
  NOT_FOUND: 'not_found',
  FORBIDDEN: 'not_allowed',
  PENDING_APPROVAL: 'not_allowed',
  UNAVAILABLE: 'server_error',
  INTERNAL: 'internal',
};

const isServerFailure = (status: number | undefined) =>
  status !== undefined && (status === 429 || status >= 500);

/**
 * Maps a CLI error onto the host's exit-code table:
 *
 * - a network failure (no answer) is `network`;
 * - the CLI's own usage errors (no project, a bad server, a bad flag) are `bad_usage`, the server's validation
 *   failures `bad_request`;
 * - conflicts keep a distinct code (`version_mismatch`, …) with status 409;
 * - `UNAVAILABLE`, and any other 429 or 5xx answer, is `server_error`.
 *
 * Field errors are appended to the message, one `path: message` per line.
 */
export function toHostError(e: CliError): HostError {
  const message = `${e.message}${(e.errors ?? []).map((f) => `\n  ${f.path}: ${f.message}`).join('')}`;
  const status = e.status !== undefined ? { status: e.status } : {};
  if (e.network) return { code: 'network', message };
  if (e.code === 'VALIDATION_FAILED' && e.status === undefined)
    return { code: 'bad_usage', message };
  if (CONFLICTS.has(e.code)) return { code: e.code.toLowerCase(), message, status: 409 };
  // A 5xx other than a server's own INTERNAL (a proxy's 504, say) is the server failing, not this CLI.
  if (
    e.code === 'INTERNAL' &&
    e.status !== undefined &&
    e.status !== 500 &&
    isServerFailure(e.status)
  )
    return { code: 'server_error', message, ...status };
  const named = BY_CODE[e.code];
  if (named) return { code: named, message, ...status };
  return { code: isServerFailure(e.status) ? 'server_error' : 'internal', message, ...status };
}

/** The host's exit code for each code the module fails with (the host's `EXIT_ROWS`). */
const HOST_EXIT: Record<string, number> = {
  internal: 1,
  bad_usage: 2,
  bad_request: 2,
  not_logged_in: 3,
  not_found: 4,
  not_allowed: 5,
  network: 8,
  server_error: 8,
};

/** How the module's failures exit under `poietic-tech`, for `issues commands`. */
export const MODULE_REFERENCE: Reference = {
  exitCodes: {
    0: 'Success',
    1: 'Unexpected failure (internal)',
    2: 'Usage error, invalid request or conflict (bad_usage, bad_request, conflict, version_mismatch, idempotency_in_progress, idempotency_key_reused)',
    3: 'Not logged in, or the login was refused (not_logged_in): run `poietic-tech login`',
    4: 'Not found (not_found)',
    5: 'Not allowed (not_allowed)',
    8: 'Network or server failure (network, server_error)',
  },
  errorCodes: Object.fromEntries(
    Object.entries(ERROR_CODES).map(([code, v]) => {
      // As the server sends it: with its status.
      const host = toHostError(
        new CliError(code as ErrorCode, v.title, undefined, { status: v.status }),
      );
      // Conflicts are not in the host's table: their status 409 exits 2.
      return [
        code,
        { status: host.status ?? v.status, code: host.code, exit: HOST_EXIT[host.code] ?? 2 },
      ];
    }),
  ),
  environment: {
    POIETIC_ISSUES_SERVER:
      'Issues server, https on a *.poietic.tech host (default https://issues.poietic.tech)',
    POIETIC_ISSUES_PROJECT: 'Default project key',
    POIETIC_IDENTITY: 'Act as one of your agents (read by poietic-tech)',
    POIETIC_AGENT_TOKEN: 'Act as an agent with its token, e.g. in CI (read by poietic-tech)',
  },
};
