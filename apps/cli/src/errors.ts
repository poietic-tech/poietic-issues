import { ApiError } from '@poietic-tech/issues-client';
import { ERROR_CODES, type ErrorCode } from '@poietic-tech/issues-schema';

/**
 * Documented exit codes (part of the CLI contract; see docs/cli.md).
 * API error codes map to these through ERROR_CODES[code].exit.
 */
export const EXIT_CODES = {
  0: 'Success',
  1: 'Internal or unexpected error',
  2: 'Usage or validation error (bad flags, invalid input, invalid relation)',
  3: 'Not found',
  4: 'Conflict (duplicate, version mismatch, idempotency)',
  5: 'Authentication or permission error',
  6: 'Unavailable (server unreachable, database not migrated)',
} as const;

/** An error with a stable code, rendered as problem JSON under --json. */
export class CliError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;
  readonly errors: Array<{ path: string; message: string }> | undefined;
  /** The HTTP status of the server's answer; absent for an error the CLI raised itself. */
  readonly status: number | undefined;
  /** No answer came: the server could not be reached. */
  readonly network: boolean;
  /** The server answered, but not with a problem document: only `status` is its word, not `code`. */
  readonly bare: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    errors?: Array<{ path: string; message: string }>,
    opts: { status?: number; network?: boolean; bare?: boolean } = {},
  ) {
    super(message);
    this.code = code;
    this.exitCode = ERROR_CODES[code].exit;
    this.errors = errors;
    this.status = opts.status;
    this.network = opts.network ?? false;
    this.bare = opts.bare ?? false;
  }
}

const NETWORK_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT'];

/** A failure to reach the server at all (no response), as fetch reports one. */
export function isNetworkError(error: unknown): boolean {
  const e = error as {
    code?: unknown;
    cause?: { code?: unknown };
    message?: unknown;
    name?: unknown;
  };
  if (e === null || typeof e !== 'object') return false;
  if (e.name === 'TypeError' && typeof e.message === 'string' && /fetch failed/i.test(e.message))
    return true;
  const code = e.cause?.code ?? e.code;
  return typeof code === 'string' && NETWORK_CODES.includes(code);
}

export function usage(message: string): CliError {
  return new CliError('VALIDATION_FAILED', message);
}

/** Normalizes anything thrown during a command into a CliError. */
export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof ApiError)
    return new CliError(error.code, error.message, error.problem.errors, {
      status: error.status,
      bare: !error.isProblem,
    });
  const e = error as { code?: string; cause?: { code?: string }; message?: string; name?: string };
  if (typeof e?.code === 'string' && Object.hasOwn(ERROR_CODES, e.code))
    return new CliError(e.code as ErrorCode, e.message ?? String(error));
  if (isNetworkError(error)) {
    const netCode = e.cause?.code ?? e.code;
    return new CliError(
      'UNAVAILABLE',
      `Cannot reach the server (${netCode ?? 'network error'})`,
      undefined,
      { network: true },
    );
  }
  return new CliError('INTERNAL', e?.message ?? String(error));
}
