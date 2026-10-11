import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { usage } from './errors.ts';
import type { CliIO } from './io.ts';

export const PROJECT_CONFIG_FILE = '.poietic-issues.json';
/** Pre-rename file name, still read for one release (ADR 0020). */
const LEGACY_PROJECT_CONFIG_FILE = '.tracker.json';

/** Per-directory config (commit it): which server/database and default project. Never holds tokens. */
const ProjectConfigSchema = z.object({
  server: z.string().optional(),
  database: z.string().optional(),
  project: z.string().optional(),
  actor: z.string().optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/** Per-user config (`$XDG_CONFIG_HOME/poietic-issues/config.json`, mode 0600): tokens per server. */
const UserConfigSchema = z.object({
  tokens: z.record(z.string(), z.string()).default({}),
  defaultServer: z.string().optional(),
});
export type UserConfig = z.infer<typeof UserConfigSchema>;

export interface GlobalFlags {
  server?: string;
  token?: string;
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
  mode: 'remote' | 'local';
  server?: string;
  token?: string;
  database?: string;
  actor: string;
  project?: string;
  format: OutputFormat;
  fields?: string[];
  /** Where values came from, for `poietic-issues auth status`. */
  sources: Record<string, string>;
  projectConfigPath?: string;
}

function configBase(env: CliIO['env']): string {
  return env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
}

export function userConfigPath(env: CliIO['env']): string {
  return join(configBase(env), 'poietic-issues', 'config.json');
}

export function readUserConfig(env: CliIO['env']): UserConfig {
  let path = userConfigPath(env);
  if (!existsSync(path)) {
    // Pre-rename location, read until the next write moves it (ADR 0020).
    path = join(configBase(env), 'tracker', 'config.json');
    if (!existsSync(path)) return { tokens: {} };
  }
  try {
    return UserConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    throw usage(`Cannot read ${path}: ${(error as Error).message}`);
  }
}

export function writeUserConfig(env: CliIO['env'], config: UserConfig): string {
  const path = userConfigPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
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
          throw usage(
            `${candidate} must not contain tokens; use \`poietic-issues auth login\` or POIETIC_ISSUES_TOKEN`,
          );
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
 * Resolves configuration. Precedence: flags > environment (`POIETIC_ISSUES_*`) > `.poietic-issues.json` > user config.
 * A server URL selects remote mode; otherwise a database URL selects local (in-process) mode.
 */
export function resolveConfig(flags: GlobalFlags, io: CliIO): ResolvedConfig {
  const env = io.env;
  const found = findProjectConfig(io.cwd);
  const project = found?.config ?? {};
  const user = readUserConfig(env);
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

  const server = pick(
    'server',
    [flags.server, 'flag'],
    [env.POIETIC_ISSUES_SERVER, 'env'],
    [project.server, PROJECT_CONFIG_FILE],
  );
  let database = pick(
    'database',
    [flags.database, 'flag'],
    [env.POIETIC_ISSUES_DATABASE_URL, 'env'],
    [project.database, PROJECT_CONFIG_FILE],
  );
  const finalServer =
    server ?? (database ? undefined : pick('server', [user.defaultServer, 'user config']));
  if (!finalServer && !database) {
    database = 'sqlite:./data/dev.db';
    sources.database = 'default';
  }
  const token = finalServer
    ? pick(
        'token',
        [flags.token, 'flag'],
        [env.POIETIC_ISSUES_TOKEN, 'env'],
        [user.tokens[normalizeServer(finalServer)], 'user config'],
      )
    : undefined;
  // POIETIC_AGENT_TOKEN, when set, replaces the token in remote mode (openTransport).
  if (finalServer && env.POIETIC_AGENT_TOKEN) sources.agent = 'env';

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
    mode: finalServer ? 'remote' : 'local',
    ...(finalServer && { server: finalServer }),
    ...(token && { token }),
    ...(database &&
      !finalServer && {
        database: resolveSqlitePath(
          database,
          sources.database === PROJECT_CONFIG_FILE && found ? dirname(found.path) : io.cwd,
        ),
      }),
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

export function normalizeServer(server: string): string {
  return server.replace(/\/+$/, '');
}

/** Makes relative SQLite paths absolute (relative to `.poietic-issues.json` when they come from it). */
function resolveSqlitePath(url: string, base: string): string {
  const match = /^sqlite:(?!\/\/|:memory:)(.+)$/.exec(url);
  if (!match || match[1]!.startsWith('/')) return url;
  return `sqlite:${resolve(base, match[1]!)}`;
}
