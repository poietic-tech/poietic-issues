import type { ApiClient } from '@poietic-tech/issues-client';
import type { CliIO } from '../io.ts';
import type { Kind, Row } from '../output.ts';

/**
 * Where a command's results go. The host owns the output format, so commands never branch on it: `human`
 * renderers are a hint a host may use for its table format. `raw` and `rawBytes` print the same bytes whatever
 * the format.
 */
export interface Sink {
  item(kind: Kind, value: unknown, human?: (row: Row) => string): void;
  list(
    kind: Kind,
    value: unknown[] | { data: unknown[]; nextCursor?: string | null },
    human?: (rows: Row[]) => string,
  ): void;
  /** A resource carrying a secret that is shown only now (a webhook's signing secret). */
  secret(
    kind: Kind,
    value: unknown,
    secret: { value: string; warning: string; human: (row: Row) => string },
  ): void;
  note(text: string): void;
  raw(text: string): void;
  rawBytes(bytes: Uint8Array): void;
}

/** What a command handler may use: the API, the project resolver, the output sink and a little IO. */
export interface CommandRuntime {
  api(): Promise<ApiClient>;
  call<T>(request: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T>;
  project(explicit?: string): string;
  readonly out: Sink;
  readonly io: Pick<CliIO, 'env' | 'cwd' | 'readStdin'>;
}

/** The parts of the `commands` reference that depend on the host: how failures exit, and its environment. */
export interface Reference {
  exitCodes: Record<string, string>;
  errorCodes: Record<string, { status: number; code?: string; exit: number }>;
  environment: Record<string, string>;
}

/** The host a command tree is registered for: how actions get a runtime, and what the binary is called. */
export interface Tree {
  act(
    handler: (rt: CommandRuntime, args: unknown[], opts: Record<string, unknown>) => Promise<void>,
  ): (...all: unknown[]) => Promise<void>;
  /** Names the tree uses in messages, e.g. "poietic-tech issues" or "poietic-issues-admin". */
  readonly commandName: string;
  /** What `init` writes to `.poietic-issues.json`: a description, and the entries from the parsed options. */
  readonly init: {
    describe: string;
    entries(globals: Record<string, unknown>, env: CliIO['env']): Record<string, unknown>;
  };
  /** Needed only by a host that registers `commands`. */
  readonly reference?: Reference;
}
