import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient, type Schemas, unwrap } from '@poietic-tech/issues-client';
import {
  bootstrapAdmin,
  createContext,
  ensureBuiltins,
  inputSchema,
  seedDemoData,
  SYSTEM_ACTOR,
} from '@poietic-tech/issues-core';
import {
  latestMigrationName,
  migrateDown,
  migrateToLatest,
  migrationStatus,
  parseDatabaseUrl,
} from '@poietic-tech/issues-db';
import {
  CommentSchema,
  CreateCommentInputSchema,
  CreateIssueInputSchema,
  CreateLinkInputSchema,
  CreateProjectInputSchema,
  CreateViewInputSchema,
  ERROR_CODES,
  EventSchema,
  IssueFilterSchema,
  IssueLinkSchema,
  IssueSchema,
  MoveIssueInputSchema,
  ProblemSchema,
  ProjectSchema,
  UpdateIssueInputSchema,
  ViewConfigSchema,
} from '@poietic-tech/issues-schema';
import { Command, type Option } from 'commander';
import { z } from 'zod';
import {
  normalizeServer,
  PROJECT_CONFIG_FILE,
  readUserConfig,
  resolveConfig,
  writeUserConfig,
} from '../config.ts';
import { CliError, EXIT_CODES, usage } from '../errors.ts';
import type { CliIO } from '../io.ts';
import { keyValues, makeAction, readJsonArg, type Runtime } from '../runtime.ts';
import { openLocalDatabase } from '../transport.ts';

type Opts = Record<string, unknown>;
const actFor = (io: CliIO) => (fn: (rt: Runtime, args: unknown[], o: Opts) => Promise<void>) =>
  makeAction(io, fn);

/** Schemas exposed by `poietic-issues schema <name>` (JSON Schema, draft 2020-12). */
const SCHEMAS: Record<string, { schema: z.ZodType; io: 'input' | 'output' }> = {
  issue: { schema: IssueSchema, io: 'output' },
  'issue-create': { schema: CreateIssueInputSchema, io: 'input' },
  'issue-update': { schema: UpdateIssueInputSchema, io: 'input' },
  'issue-move': { schema: MoveIssueInputSchema, io: 'input' },
  'issue-filter': { schema: IssueFilterSchema, io: 'input' },
  comment: { schema: CommentSchema, io: 'output' },
  'comment-create': { schema: CreateCommentInputSchema, io: 'input' },
  link: { schema: IssueLinkSchema, io: 'output' },
  'link-create': { schema: CreateLinkInputSchema, io: 'input' },
  project: { schema: ProjectSchema, io: 'output' },
  'project-create': { schema: CreateProjectInputSchema, io: 'input' },
  'view-create': { schema: CreateViewInputSchema, io: 'input' },
  'view-config': { schema: ViewConfigSchema, io: 'input' },
  event: { schema: EventSchema, io: 'output' },
  problem: { schema: ProblemSchema, io: 'output' },
};

function jsonSchema(name: string): Record<string, unknown> {
  const entry = SCHEMAS[name];
  if (!entry)
    throw usage(`Unknown schema "${name}" (available: ${Object.keys(SCHEMAS).join(', ')})`);
  if (entry.io === 'input') return inputSchema(entry.schema);
  return z.toJSONSchema(entry.schema, {
    io: 'output',
    target: 'draft-2020-12',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
}

/** `GET /me` answers `{ anonymous: true }` without credentials; the CLI treats that as not signed in. */
function signedIn(me: Schemas['Me']): Schemas['User'] {
  if ('anonymous' in me)
    throw new CliError(
      'UNAUTHENTICATED',
      'Not signed in: set POIETIC_ISSUES_TOKEN or run `poietic-issues auth login`',
    );
  return me;
}

export function authCommand(io: CliIO): Command {
  const act = actFor(io);
  const cmd = new Command('auth').description(
    'Sign in to a tracker server (stores tokens in your user config)',
  );
  cmd
    .command('login')
    .description(
      'Store an API token for a server (verifies it first): auth login --server <url> --token <t> | --with-token',
    )
    .option('--with-token', 'read the token from stdin')
    .action(
      act(async (rt, _a, o) => {
        if (!rt.config.server) throw usage('Pass --server <url> (the global option)');
        const server = normalizeServer(rt.config.server);
        const token = o.withToken ? (await rt.io.readStdin()).trim() : (rt.config.token ?? '');
        if (!token) throw usage('Provide --token <token> or --with-token (stdin)');
        const client = createClient({
          baseUrl: server,
          token,
          ...(rt.io.fetch && { fetch: rt.io.fetch }),
        });
        const me = signedIn(unwrap(await client.GET('/me')));
        const config = readUserConfig(rt.io.env);
        config.tokens[server] = token;
        config.defaultServer = server;
        const path = writeUserConfig(rt.io.env, config);
        rt.out.item(
          'user',
          me,
          () => `Signed in to ${server} as @${me.handle} (token saved to ${path})\n`,
        );
      }),
    );
  cmd
    .command('logout')
    .description('Forget the stored token for the server (--server or the current default)')
    .action(
      act(async (rt) => {
        if (!rt.config.server) throw usage('Pass --server <url>');
        const server = normalizeServer(rt.config.server);
        const config = readUserConfig(rt.io.env);
        delete config.tokens[server];
        if (config.defaultServer === server) delete config.defaultServer;
        writeUserConfig(rt.io.env, config);
        rt.out.item('raw', { server, loggedOut: true }, () => `Logged out of ${server}\n`);
      }),
    );
  cmd
    .command('status')
    .description('Show how the CLI connects and who it acts as')
    .action(
      act(async (rt) => {
        const api = await rt.api();
        const me = signedIn(await rt.call(api.GET('/me')));
        const status = {
          mode: rt.config.mode,
          transport: await rt.describeTransport(),
          user: { handle: me.handle, kind: me.kind, role: me.role },
          project: rt.config.project ?? null,
          format: rt.config.format,
          sources: rt.config.sources,
          projectConfig: rt.config.projectConfigPath ?? null,
        };
        rt.out.item('raw', status, () =>
          [
            `Mode:      ${status.mode} — ${status.transport}`,
            `Acting as: @${me.handle} (${me.kind}, ${me.role})`,
            `Project:   ${status.project ?? '— (set with --project, POIETIC_ISSUES_PROJECT or poietic-issues init)'}`,
            `Config:    ${status.projectConfig ?? 'no .poietic-issues.json'}`,
            '',
          ].join('\n'),
        );
      }),
    );
  return cmd;
}

export function whoamiCommand(io: CliIO): Command {
  return new Command('whoami').description('Show the user the CLI acts as').action(
    actFor(io)(async (rt) => {
      const api = await rt.api();
      rt.out.item(
        'user',
        signedIn(await rt.call(api.GET('/me'))),
        (u) => `@${String(u.handle)} (${String(u.kind)}, ${String(u.role)})\n`,
      );
    }),
  );
}

export function initCommand(io: CliIO): Command {
  return new Command('init')
    .description(
      `Write ${PROJECT_CONFIG_FILE} here from the global --server/--database, --project and --actor (never tokens)`,
    )
    .option('--force', 'overwrite an existing file')
    .action(async (_o: Opts, command: Command) => {
      const o = command.optsWithGlobals() as Opts;
      const path = join(io.cwd, PROJECT_CONFIG_FILE);
      if (existsSync(path) && !o.force) throw usage(`${path} exists (use --force to overwrite)`);
      const config = Object.fromEntries(
        (['server', 'database', 'project', 'actor'] as const)
          .filter((k) => o[k] !== undefined)
          .map((k) => [k, o[k]]),
      );
      writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
      io.stdout(`Wrote ${path}\n`);
    });
}

/** `db migrate --down` stops above this one: reverting it would drop every table. */
const FIRST_MIGRATION = '0001_init';

export function dbCommand(io: CliIO): Command {
  const cmd = new Command('db').description('Local database administration (local mode only)');
  /** `mustExist`: refuse a SQLite path with no file, instead of creating an empty database (a typo would look like success). */
  const localDb = async (flags: Opts, mustExist = false) => {
    const config = resolveConfig(flags, io);
    if (config.mode !== 'local' || !config.database)
      throw usage(
        'db commands need a local database: set --database or POIETIC_ISSUES_DATABASE_URL (not --server)',
      );
    if (mustExist) {
      const parsed = parseDatabaseUrl(config.database);
      if (
        parsed.dialect === 'sqlite' &&
        parsed.filename !== ':memory:' &&
        !existsSync(parsed.filename)
      )
        throw usage(`No database at ${parsed.filename}`);
    }
    return { config, db: await openLocalDatabase(config.database, false) };
  };
  cmd
    .command('migrate')
    .description('Apply pending migrations')
    .option(
      '--down',
      'revert the newest applied migration instead (one step; drops its tables and columns, so back up first; never reverts the first migration)',
    )
    .action(async (o: Opts, command: Command) => {
      const { config, db } = await localDb(command.optsWithGlobals(), Boolean(o.down));
      try {
        if (o.down) {
          const newest = (await migrationStatus(db)).applied.at(-1);
          if (newest === FIRST_MIGRATION)
            throw usage(
              `Refusing to revert ${FIRST_MIGRATION}: it drops every table. To start over, delete the database instead.`,
            );
          const reverted = await migrateDown(db);
          const result = { database: config.database, reverted, latest: latestMigrationName() };
          if (config.format === 'table')
            io.stdout(
              reverted.length ? `Reverted: ${reverted.join(', ')}\n` : 'No migrations to revert.\n',
            );
          else io.stdout(`${JSON.stringify(result, null, 2)}\n`);
          return;
        }
        const applied = await migrateToLatest(db);
        await ensureBuiltins(db);
        const result = { database: config.database, applied, latest: latestMigrationName() };
        if (config.format === 'table')
          io.stdout(
            applied.length ? `Applied: ${applied.join(', ')}\n` : 'Database is up to date.\n',
          );
        else io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      } finally {
        await db.destroy();
      }
    });
  cmd
    .command('status')
    .description('Show applied and pending migrations')
    .action(async (_o: Opts, command: Command) => {
      const { config, db } = await localDb(command.optsWithGlobals(), true);
      try {
        const status = await migrationStatus(db);
        if (config.format === 'table')
          io.stdout(
            `Applied: ${status.applied.join(', ') || '—'}\nPending: ${status.pending.join(', ') || '—'}\n`,
          );
        else io.stdout(`${JSON.stringify({ database: config.database, ...status }, null, 2)}\n`);
      } finally {
        await db.destroy();
      }
    });
  cmd
    .command('bootstrap')
    .description('Create the first admin of a fresh installation (migrating if needed)')
    .requiredOption('--handle <handle>', 'admin handle, e.g. ada')
    .requiredOption('--name <name>', 'display name')
    .option('--email <email>', 'email address')
    .action(async (o: Opts, command: Command) => {
      const { config, db } = await localDb(command.optsWithGlobals());
      try {
        await migrateToLatest(db);
        await ensureBuiltins(db);
        const { user } = await bootstrapAdmin(db, {
          handle: String(o.handle),
          name: String(o.name),
          email: o.email === undefined ? undefined : String(o.email),
        });
        if (config.format === 'table') io.stdout(`Created admin @${user.handle}.\n`);
        else io.stdout(`${JSON.stringify({ user }, null, 2)}\n`);
      } finally {
        await db.destroy();
      }
    });
  cmd
    .command('seed')
    .description(
      'Create demo users (ada admin, grace, margaret, claude agent), public ENG with a linked repo, private OPS and sample issues',
    )
    .action(async (_o: Opts, command: Command) => {
      const { config, db } = await localDb(command.optsWithGlobals());
      try {
        await migrateToLatest(db);
        await ensureBuiltins(db);
        const users = await db.kysely
          .selectFrom('users')
          .select('id')
          .where('kind', '!=', 'system')
          .execute();
        if (users.length > 0)
          throw new CliError('CONFLICT', 'Database already has users; seed only an empty database');
        const { users: seeded } = await seedDemoData(createContext(db, SYSTEM_ACTOR));
        if (config.format === 'table')
          io.stdout(`Seeded demo data (users: ${seeded.map((h) => `@${h}`).join(', ')}).\n`);
        else io.stdout(`${JSON.stringify({ users: seeded }, null, 2)}\n`);
      } finally {
        await db.destroy();
      }
    });
  return cmd;
}

export function serveCommand(io: CliIO): Command {
  return new Command('serve')
    .description('Run the tracker server (API + web app if built) on the local database')
    .option('--port <port>', 'port', '3000')
    .option('--host <host>', 'host', '127.0.0.1')
    .action(async (o: Opts, command: Command) => {
      const flags = command.optsWithGlobals();
      const config = resolveConfig(flags, io);
      if (config.mode !== 'local')
        throw usage('serve runs against a database: pass --database (not --server)');
      const { loadConfig, startServer } = await import('@poietic-tech/issues-server');
      const server = await startServer(
        loadConfig({
          ...io.env,
          POIETIC_ISSUES_DATABASE_URL: config.database,
          POIETIC_ISSUES_PORT: String(o.port),
          POIETIC_ISSUES_HOST: String(o.host),
        }),
      );
      io.stderr(`Tracker listening on ${server.url} (API docs at /api/docs). Ctrl-C to stop.\n`);
      await new Promise<void>((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
      await server.close();
    });
}

export function schemaCommand(io: CliIO): Command {
  return new Command('schema')
    .description(
      'Print a JSON Schema: resources and inputs (use `project schema` for live per-project enums)',
    )
    .argument('[name]', `one of: ${Object.keys(SCHEMAS).join(', ')}`)
    .action(async (name: string | undefined) => {
      if (!name) {
        io.stdout(`${Object.keys(SCHEMAS).join('\n')}\n`);
        return;
      }
      io.stdout(`${JSON.stringify(jsonSchema(name), null, 2)}\n`);
    });
}

export function apiCommand(io: CliIO): Command {
  return new Command('api')
    .description('Call any API endpoint directly and print the JSON response (like `gh api`)')
    .argument('<method>', 'GET, POST, PATCH, DELETE')
    .argument('<path>', 'path under /api/v1, e.g. /issues/ENG-1')
    .option('--input <json|@file|->', 'request body (JSON)')
    .option(
      '-f, --field <key=value>',
      'body field (repeatable; values parsed as JSON when possible)',
      (v: string, p: string[] = []) => [...p, v],
    )
    .option(
      '--query <key=value>',
      'query parameter (repeatable)',
      (v: string, p: string[] = []) => [...p, v],
    )
    .action(
      actFor(io)(async (rt, [method, path], o) => {
        const api = await rt.api();
        const body = o.input
          ? await readJsonArg(rt.io, String(o.input), '--input')
          : keyValues(o.field as string[] | undefined);
        const query = Object.fromEntries(
          ((o.query as string[] | undefined) ?? []).map((q) => {
            const i = q.indexOf('=');
            if (i <= 0) throw usage(`--query expects key=value, got "${q}"`);
            return [q.slice(0, i), q.slice(i + 1)];
          }),
        );
        const verb = String(method).toUpperCase() as 'GET';
        const cleanPath = `/${String(path)
          .replace(/^\/+/, '')
          .replace(/^api\/v1\//, '')}`;
        const request = (
          api as unknown as Record<
            string,
            (
              p: string,
              init: unknown,
            ) => Promise<{ data?: unknown; error?: unknown; response: Response }>
          >
        )[verb];
        if (!request) throw usage(`Unsupported method ${String(method)}`);
        const result = await request(cleanPath, { params: { query }, ...(body && { body }) });
        const data = unwrap(result);
        rt.io.stdout(`${JSON.stringify(data ?? null, null, 2)}\n`);
      }),
    );
}

interface CommandInfo {
  name: string;
  aliases: string[];
  description: string;
  arguments: Array<{ name: string; required: boolean; variadic: boolean; description: string }>;
  options: Array<{
    flags: string;
    name: string;
    description: string;
    required: boolean;
    takesValue: boolean;
    default?: unknown;
  }>;
}

function describeOption(opt: Option) {
  return {
    flags: opt.flags,
    name: opt.attributeName(),
    description: opt.description,
    required: Boolean(opt.mandatory),
    takesValue: Boolean(opt.required || opt.optional),
    ...(opt.defaultValue !== undefined && { default: opt.defaultValue }),
  };
}

/** Flattened description of every leaf command — the agent's one-call map of the CLI. */
export function describeCommands(program: Command): {
  commands: CommandInfo[];
  globalOptions: ReturnType<typeof describeOption>[];
  exitCodes: typeof EXIT_CODES;
  errorCodes: Record<string, { status: number; exit: number }>;
  environment: Record<string, string>;
} {
  const commands: CommandInfo[] = [];
  const walk = (cmd: Command, prefix: string[]) => {
    for (const sub of cmd.commands) {
      const path = [...prefix, sub.name()];
      if (sub.commands.length) walk(sub, path);
      else
        commands.push({
          name: path.join(' '),
          aliases: sub.aliases(),
          description: sub.description(),
          arguments: sub.registeredArguments.map((a) => ({
            name: a.name(),
            required: a.required,
            variadic: a.variadic,
            description: a.description,
          })),
          options: sub.options.map(describeOption),
        });
    }
  };
  walk(program, []);
  return {
    commands,
    globalOptions: program.options.map(describeOption),
    exitCodes: EXIT_CODES,
    errorCodes: Object.fromEntries(
      Object.entries(ERROR_CODES).map(([k, v]) => [k, { status: v.status, exit: v.exit }]),
    ),
    environment: {
      POIETIC_ISSUES_SERVER: 'Server URL (remote mode)',
      POIETIC_ISSUES_TOKEN: 'API token for the server',
      POIETIC_AGENT_TOKEN:
        'Remote mode: act as this poietic.tech agent (takes precedence over POIETIC_ISSUES_TOKEN)',
      POIETIC_ISSUES_DATABASE_URL: 'Database URL (local mode), e.g. sqlite:./data/dev.db',
      POIETIC_ISSUES_ACTOR: 'Local mode: user handle to act as',
      POIETIC_ISSUES_PROJECT: 'Default project key',
      POIETIC_ISSUES_FORMAT: 'Default output format: table|json|ndjson|ids',
      POIETIC_ISSUES_FIELDS: 'Default --fields projection',
    },
  };
}

export function commandsCommand(io: CliIO, program: () => Command): Command {
  return new Command('commands')
    .description('Describe every command, option, exit code and error code (use --json for agents)')
    .action(async (_o: Opts, command: Command) => {
      const info = describeCommands(program());
      const flags = command.optsWithGlobals();
      if (flags.json || flags.format === 'json' || io.env.POIETIC_ISSUES_FORMAT === 'json') {
        io.stdout(`${JSON.stringify(info, null, 2)}\n`);
        return;
      }
      const width = Math.max(...info.commands.map((c) => c.name.length));
      io.stdout(
        `${info.commands.map((c) => `${c.name.padEnd(width)}  ${c.description}`).join('\n')}\n`,
      );
    });
}
