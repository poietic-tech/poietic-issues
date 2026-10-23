import type { ModuleOutput } from '@poietic-tech/cli/module';
import { COLUMNS, type Column, identifier, type Kind, project, type Row } from '../output.ts';
import type { Sink } from '../tree/runtime.ts';

/** An issue on its own also shows its description, as a text block with its line breaks. */
const ITEM_EXTRA: Partial<Record<Kind, Column[]>> = {
  issue: [['DESCRIPTION', (r) => r.description, { multiline: true }]],
};

/**
 * Command results through the host's `ctx.output`, which owns the format (`--json`, `--format`, `-q`). The module
 * cannot see that format, so it never branches on it: `--fields` both picks the table columns and projects the
 * objects the host prints as JSON. `raw` goes through the host's `output.raw`: the same bytes whatever the format, exact
 * to a pipe, cleaned text (and never binary) to a terminal.
 */
export class ModuleSink implements Sink {
  readonly #output: ModuleOutput;
  readonly #fields: string[] | undefined;

  constructor(output: ModuleOutput, fields: string[] | undefined) {
    this.#output = output;
    this.#fields = fields?.length ? fields : undefined;
  }

  /** Columns over the (projected) rows: one per `--fields` entry, else the kind's own. */
  #columns(kind: Kind, sample: Row | undefined, extra: Column[] = []): Column[] | undefined {
    if (this.#fields) return this.#fields.map((f) => [f.toUpperCase(), (r: Row) => r[f]]);
    if (kind !== 'raw') return [...COLUMNS[kind], ...extra];
    if (!sample) return undefined;
    return Object.keys(sample).map((k) => [k.toUpperCase(), (r: Row) => r[k]]);
  }

  item(kind: Kind, value: unknown): void {
    const original = value as Row;
    const row = project(kind, original, this.#fields);
    // Without --fields, a raw object shows its scalar fields (the host's default).
    const columns =
      kind === 'raw' && !this.#fields ? undefined : this.#columns(kind, row, ITEM_EXTRA[kind]);
    // `-q` prints the resource's own identifier (an issue's key), even when --fields leaves it out.
    this.#output.item(row, columns, { id: () => identifier(kind, original) });
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
      nextCursor: page.nextCursor ?? null,
    });
    // The JSON form carries the cursor; the other formats keep stdout to rows, so the hint is ours to give.
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
    this.#output.raw(text);
  }

  rawBytes(bytes: Uint8Array): void {
    this.#output.raw(bytes);
  }
}
