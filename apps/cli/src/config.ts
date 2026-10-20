import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { usage } from './errors.ts';
import type { CliIO } from './io.ts';

export const PROJECT_CONFIG_FILE = '.poietic-issues.json';
/** Pre-rename file name, still read for one release (ADR 0020). */
const LEGACY_PROJECT_CONFIG_FILE = '.tracker.json';

/**
 * Per-directory config (commit it): the default project, the issues server (the module) or the database and
 * actor (the operator tool). Never holds tokens. Each host ignores the keys it has no use for.
 */
const ProjectConfigSchema = z.object({
  server: z.string().optional(),
  database: z.string().optional(),
  project: z.string().optional(),
  actor: z.string().optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export interface GlobalFlags {
  database?: string;
  actor?: string;
  project?: string;
  format?: string;
  json?: boolean;
  quiet?: boolean;
  fields?: string;
}

export type OutputFormat = 'table' | 'json' | 'ndjson' | 'ids';

export interface ResolvedConfig {
  database: string;
  actor: string;
  project?: string;
  format: OutputFormat;
  fields?: string[];
  /** Where values came from (an `actor` entry means one was given rather than defaulted). */
  sources: Record<string, string>;
  projectConfigPath?: string;
}

/** Finds `.poietic-issues.json` (or the pre-rename `.tracker.json`) walking up from `cwd`. */
export function findProjectConfig(
  cwd: string,
): { path: string; config: ProjectConfig } | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = [PROJECT_CONFIG_FILE, LEGACY_PROJECT_CONFIG_FILE]
      .map((name) => join(dir, name))
      .find((path) => existsSync(path));
    if (candidate) {
      try {
        const raw = JSON.parse(readFileSync(candidate, 'utf8'));
        if (raw && typeof raw === 'object' && 'token' in raw)
          throw usage(`${candidate} must not contain tokens; remove the "token" key`);
        return { path: candidate, config: ProjectConfigSchema.parse(raw) };
      } catch (error) {
        if ((error as { exitCode?: number }).exitCode) throw error;
        throw usage(`Invalid ${candidate}: ${(error as Error).message}`);
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const FORMATS: readonly OutputFormat[] = ['table', 'json', 'ndjson', 'ids'];

/**
 * Resolves configuration. Precedence: flags > environment (`POIETIC_ISSUES_*`) > `.poietic-issues.json` > defaults.
 * The database defaults to `sqlite:./data/dev.db`.
 */
export function resolveConfig(flags: GlobalFlags, io: CliIO): ResolvedConfig {
  const env = io.env;
  const found = findProjectConfig(io.cwd);
  const project = found?.config ?? {};
  const sources: Record<string, string> = {};
  const pick = <T>(name: string, ...candidates: Array<[T | undefined, string]>): T | undefined => {
    for (const [value, source] of candidates) {
      if (value !== undefined && value !== '') {
        sources[name] = source;
        return value;
      }
    }
    return undefined;
  };

  let database = pick(
    'database',
    [flags.database, 'flag'],
    [env.POIETIC_ISSUES_DATABASE_URL, 'env'],
    [project.database, PROJECT_CONFIG_FILE],
  );
  if (!database) {
    database = 'sqlite:./data/dev.db';
    sources.database = 'default';
  }

  const formatRaw = flags.json
    ? 'json'
    : flags.quiet
      ? 'ids'
      : (flags.format ?? env.POIETIC_ISSUES_FORMAT ?? 'table');
  if (!FORMATS.includes(formatRaw as OutputFormat))
    throw usage(`Unknown format "${formatRaw}" (use ${FORMATS.join(', ')})`);

  const fieldsRaw = flags.fields ?? env.POIETIC_ISSUES_FIELDS;
  const projectRef = pick<string>(
    'project',
    [flags.project, 'flag'],
    [env.POIETIC_ISSUES_PROJECT, 'env'],
    [project.project, PROJECT_CONFIG_FILE],
  );
  return {
    database: resolveSqlitePath(
      database,
      sources.database === PROJECT_CONFIG_FILE && found ? dirname(found.path) : io.cwd,
    ),
    actor:
      pick(
        'actor',
        [flags.actor, 'flag'],
        [env.POIETIC_ISSUES_ACTOR, 'env'],
        [project.actor, PROJECT_CONFIG_FILE],
      ) ?? 'admin',
    ...(projectRef !== undefined && { project: projectRef }),
    format: formatRaw as OutputFormat,
    ...(fieldsRaw && {
      fields: fieldsRaw
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean),
    }),
    sources,
    ...(found && { projectConfigPath: found.path }),
  };
}

/** Makes relative SQLite paths absolute (relative to `.poietic-issues.json` when they come from it). */
function resolveSqlitePath(url: string, base: string): string {
  const match = /^sqlite:(?!\/\/|:memory:)(.+)$/.exec(url);
  if (!match || match[1]!.startsWith('/')) return url;
  return `sqlite:${resolve(base, match[1]!)}`;
}
