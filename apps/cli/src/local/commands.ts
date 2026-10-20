import { existsSync } from 'node:fs';
import { createClient, unwrap } from '@poietic-tech/issues-client';
import {
  bootstrapAdmin,
  createContext,
  ensureBuiltins,
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
import { Command } from 'commander';
import { normalizeServer, readUserConfig, resolveConfig, writeUserConfig } from '../config.ts';
import { CliError, usage } from '../errors.ts';
import type { CliIO } from '../io.ts';
import { makeAction, type Runtime } from '../runtime.ts';
import { openLocalDatabase } from '../transport.ts';
import { signedIn } from '../commands/system.ts';

// Commands of the local operator binary only: they reach the user config, the database or the in-process
// server, so they live outside the command tree that a poietic-tech host loads.

type Opts = Record<string, unknown>;

export function authCommand(io: CliIO): Command {
  const act = (fn: (rt: Runtime, args: unknown[], o: Opts) => Promise<void>) => makeAction(io, fn);
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
        const me = signedIn(unwrap(await client.GET('/me')), 'poietic-issues');
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
        const me = signedIn(await rt.call(api.GET('/me')), 'poietic-issues');
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
