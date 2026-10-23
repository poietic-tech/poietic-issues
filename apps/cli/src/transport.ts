import { mkdirSync } from 'node:fs';
import { type ApiClient, createClient } from '@poietic-tech/issues-client';
import { blobStoreFromEnv, ensureBuiltins } from '@poietic-tech/issues-core';
import { dirname, join } from 'node:path';
import { createDb, type Db, migrationStatus, parseDatabaseUrl } from '@poietic-tech/issues-db';
import { createApp } from '@poietic-tech/issues-server';
import type { ResolvedConfig } from './config.ts';
import { CliError } from './errors.ts';
import type { CliIO } from './io.ts';

export interface Transport {
  client: ApiClient;
  close(): Promise<void>;
}

export { retryingFetch } from './fetch.ts';

/** Builds the API client: the in-process app on the local database in trusted mode, or a test override. */
export async function openTransport(config: ResolvedConfig, io: CliIO): Promise<Transport> {
  if (io.fetch) {
    return {
      client: createClient({ baseUrl: 'http://tracker.local', fetch: io.fetch }),
      close: async () => {},
    };
  }
  const db = await openLocalDatabase(config.database, true);
  const actor = config.sources.actor ? config.actor : await defaultLocalActor(db);
  // Attachments land next to a SQLite file (…/data/blobs, the dev server's default) unless configured.
  const file = /^sqlite:(\/.+)$/.exec(config.database)?.[1];
  const blobStore = blobStoreFromEnv(
    io.env,
    file ? join(dirname(file), 'blobs') : join(io.cwd, 'data', 'blobs'),
  );
  const app = createApp({
    db,
    auth: { mode: 'trusted', actor },
    blobStore,
    webhooks: {
      allowPrivate: ['1', 'true'].includes(io.env.POIETIC_ISSUES_WEBHOOK_ALLOW_PRIVATE ?? ''),
    },
  });
  return {
    client: createClient({
      baseUrl: 'http://tracker.local',
      fetch: (r) => Promise.resolve(app.fetch(r)),
    }),
    close: () => db.destroy(),
  };
}

/** Opens a local database, refusing to run against an unmigrated schema (exit 6). */
export async function openLocalDatabase(url: string, requireMigrated: boolean): Promise<Db> {
  let db: Db;
  try {
    const config = parseDatabaseUrl(url);
    if (config.dialect === 'sqlite' && config.filename !== ':memory:')
      mkdirSync(dirname(config.filename), { recursive: true });
    db = createDb(config);
  } catch (error) {
    throw new CliError('UNAVAILABLE', `Cannot open database ${url}: ${(error as Error).message}`);
  }
  if (requireMigrated) {
    const status = await migrationStatus(db).catch(() => ({ upToDate: false, pending: ['?'] }));
    if (!status.upToDate) {
      await db.destroy();
      throw new CliError(
        'UNAVAILABLE',
        `Database ${url} is not migrated (pending: ${status.pending.join(', ')}). Run \`poietic-issues-admin db migrate\`.`,
      );
    }
    await ensureBuiltins(db);
  }
  return db;
}

/** Local mode acts as POIETIC_ISSUES_ACTOR, or else the first admin human. */
async function defaultLocalActor(db: Db): Promise<string> {
  const row = await db.kysely
    .selectFrom('users')
    .select('handle')
    .where('role', '=', 'admin')
    .where('kind', '=', 'human')
    .where('deactivated_at', 'is', null)
    .orderBy('created_at')
    .executeTakeFirst();
  if (!row)
    throw new CliError(
      'UNAUTHENTICATED',
      'No admin user in the local database. Run `poietic-issues-admin db bootstrap --handle <handle> --name <name>` (or `db seed` for demo data).',
    );
  return row.handle;
}
