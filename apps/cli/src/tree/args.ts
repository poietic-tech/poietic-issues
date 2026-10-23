import type { Command } from 'commander';
import { CliError, usage } from '../errors.ts';
import type { CliIO } from '../io.ts';
import type { CommandRuntime, Tree } from './runtime.ts';

/**
 * Like {@link Tree.act}, also handing the handler the options inherited from parent commands (the global
 * `--project`, `--server`, ...). Commander passes the command itself as the last action argument.
 */
export function actWithGlobals(
  tree: Tree,
  handler: (
    rt: CommandRuntime,
    args: unknown[],
    opts: Record<string, unknown>,
    globals: Record<string, unknown>,
  ) => Promise<void>,
): (...all: unknown[]) => Promise<void> {
  return (...all) => {
    const globals = (all.at(-1) as Command).optsWithGlobals() as Record<string, unknown>;
    return tree.act((rt, args, opts) => handler(rt, args, opts, globals))(...all);
  };
}

// ---- argument helpers ----

export const collect = (value: string, previous: string[] = []) => [
  ...previous,
  ...value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean),
];

export const collectRaw = (value: string, previous: string[] = []) => [...previous, value];

export function parseIntStrict(name: string) {
  return (value: string) => {
    const n = Number(value);
    if (!Number.isInteger(n)) throw usage(`${name} must be an integer`);
    return n;
  };
}

const PRIORITY_NAMES: Record<string, number> = { none: 0, urgent: 1, high: 2, medium: 3, low: 4 };

export function parsePriority(value: string): number {
  const n = PRIORITY_NAMES[value.toLowerCase()] ?? Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 4)
    throw usage('--priority must be 0-4 or none|urgent|high|medium|low');
  return n;
}

/** `none`/`null` → null (clear the field), otherwise the value. */
export function nullable(value: string): string | null {
  return value === 'none' || value === 'null' ? null : value;
}

/** Parses `value` as JSON when possible (numbers, booleans, arrays, null), else as a plain string. */
export function looseValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** `key=value` pairs (repeatable) → object; values parsed with {@link looseValue}. */
export function keyValues(
  pairs: string[] | undefined,
  stripPrefix?: string,
): Record<string, unknown> | undefined {
  if (!pairs?.length) return undefined;
  const out: Record<string, unknown> = {};
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx <= 0) throw usage(`Expected key=value, got "${pair}"`);
    let key = pair.slice(0, idx).trim();
    if (stripPrefix && key.startsWith(stripPrefix)) key = key.slice(stripPrefix.length);
    out[key] = looseValue(pair.slice(idx + 1));
  }
  return out;
}

/** Reads text from `-` (stdin) or a file path. */
export async function readTextArg(
  io: Pick<CliIO, 'cwd' | 'readStdin'>,
  value: string,
): Promise<string> {
  if (value === '-') return io.readStdin();
  const { readFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  try {
    return await readFile(resolve(io.cwd, value), 'utf8');
  } catch (error) {
    throw usage(`Cannot read ${value}: ${(error as Error).message}`);
  }
}

/** Reads a JSON object from `-`, `@file` / a file path, or an inline JSON string. */
export async function readJsonArg(
  io: Pick<CliIO, 'cwd' | 'readStdin'>,
  value: string,
  what: string,
): Promise<Record<string, unknown>> {
  const text =
    value === '-' || value.startsWith('@') || !value.trim().startsWith('{')
      ? await readTextArg(io, value.replace(/^@/, ''))
      : value;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('expected a JSON object');
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw usage(`${what} is not valid JSON: ${(error as Error).message}`);
  }
}

export function assertNever(message: string): never {
  throw new CliError('INTERNAL', message);
}
