import type { ModuleOutput } from '@poietic-tech/cli/module';
import { COLUMNS, type Column, identifier, type Kind, project, type Row } from '../output.ts';
import type { Sink } from '../tree/runtime.ts';

/** Writes to stdout: a string, or bytes (an attachment). */
export type Write = (chunk: string | Uint8Array) => void;

/** An issue on its own also shows its description (in one line: the host's table has no text blocks). */
const ITEM_EXTRA: Partial<Record<Kind, Column[]>> = {
  issue: [['DESCRIPTION', (r) => r.description]],
};

/**
 * Command results through the host's `ctx.output`, which owns the format (`--json`, `--format`, `-q`). The module
 * cannot see that format, so it never branches on it: `--fields` both picks the table columns and projects the
 * objects the host prints as JSON. `raw` writes straight to stdout, the same bytes whatever the format.
 */
export class ModuleSink implements Sink {
  readonly #output: ModuleOutput;
  readonly #fields: string[] | undefined;
  readonly #write: Write;

  constructor(output: ModuleOutput, fields: string[] | undefined, write: Write) {
    this.#output = output;
    this.#fields = fields?.length ? fields : undefined;
    this.#write = write;
  }

  /** Columns over the (projected) rows: one per `--fields` entry, else the kind's own. */
  #columns(kind: Kind, sample: Row | undefined, extra: Column[] = []): Column[] | undefined {
    if (this.#fields) return this.#fields.map((f) => [f.toUpperCase(), (r: Row) => r[f]]);
    if (kind !== 'raw') return [...COLUMNS[kind], ...extra];
    if (!sample) return undefined;
    return Object.keys(sample).map((k) => [k.toUpperCase(), (r: Row) => r[k]]);
  }

  item(kind: Kind, value: unknown): void {
    const row = project(kind, value as Row, this.#fields);
    // Without --fields, a raw object shows its scalar fields (the host's default).
    const columns =
      kind === 'raw' && !this.#fields ? undefined : this.#columns(kind, row, ITEM_EXTRA[kind]);
    this.#output.item(row, columns);
  }

  list(kind: Kind, value: unknown[] | { data: unknown[]; nextCursor?: string | null }): void {
    const page = Array.isArray(value) ? { data: value, nextCursor: null } : value;
    const originals = new Map<Row, Row>();
    const rows = (page.data as Row[]).map((r) => {
      const projected = project(kind, r, this.#fields);
      originals.set(projected, r);
      return projected;
    });
    this.#output.list(rows, {
      columns: this.#columns(kind, rows[0]) ?? [],
      id: (r) => identifier(kind, originals.get(r) ?? r),
    });
    if (page.nextCursor)
      this.#output.message(`More results: --cursor ${page.nextCursor}  (or --all)`);
  }

  secret(kind: Kind, value: unknown, secret: { value: string; warning: string }): void {
    const { secret: _omitted, ...rest } = project(kind, value as Row, this.#fields);
    this.#output.secret(secret.value, secret.warning, rest);
  }

  note(text: string): void {
    this.#output.message(text.replace(/\n$/, ''));
  }

  raw(text: string): void {
    this.#write(text);
  }

  rawBytes(bytes: Uint8Array): void {
    this.#write(bytes);
  }
}
