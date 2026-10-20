import type { ApiClient } from '@poietic-tech/issues-client';
import type { OutputFormat } from '../config.ts';
import type { CliIO } from '../io.ts';
import type { Kind, Row } from '../output.ts';

/** Where a command's results go. `raw` and `rawBytes` print the same bytes whatever the format. */
export interface Sink {
  readonly format: OutputFormat;
  item(kind: Kind, value: unknown, human?: (row: Row) => string): void;
  list(kind: Kind, value: unknown[] | { data: unknown[]; nextCursor?: string | null }): void;
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
  readonly io: Pick<CliIO, 'env' | 'cwd' | 'readStdin' | 'stderr'>;
}

/** The host a command tree is registered for: how actions get a runtime, and what the binary is called. */
export interface Tree {
  act(
    handler: (rt: CommandRuntime, args: unknown[], opts: Record<string, unknown>) => Promise<void>,
  ): (...all: unknown[]) => Promise<void>;
  /** Names the tree uses in messages, e.g. "poietic-tech issues" or "poietic-issues-admin". */
  readonly commandName: string;
}

export type Handler = Parameters<Tree['act']>[0];
