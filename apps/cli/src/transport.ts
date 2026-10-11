import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { agentFromEnv, PoieticAuthError, type PoieticAgent } from '@poietic-tech/auth';
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
  /** Human description, e.g. "http://… (token)" or "local sqlite:… as @ada". */
  describe: string;
  close(): Promise<void>;
}

const RETRY_DELAYS_MS = [250, 1000];
const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Remote fetch with agent-safe retries: every POST carries an Idempotency-Key, and requests that fail at the
 * network level (no response) are retried up to twice with the same key — so a retried create never
 * duplicates. HTTP error responses are never retried.
 */
export function retryingFetch(inner: (r: Request) => Promise<Response> = (r) => fetch(r)) {
  return async (request: Request): Promise<Response> => {
    if (request.method === 'POST' && !request.headers.has('idempotency-key'))
      request.headers.set('idempotency-key', randomUUID());
    const body = MUTATING.has(request.method) ? await request.clone().arrayBuffer() : undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        const init: RequestInit = { method: request.method, headers: request.headers };
        if (body) init.body = body;
        return await inner(new Request(request.url, init));
      } catch (error) {
        // A CliError is a decision (e.g. a refused agent token), not a network failure.
        if (error instanceof CliError || attempt >= RETRY_DELAYS_MS.length) throw error;
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
  };
}

/**
 * Remote fetch as the agent named by POIETIC_AGENT_TOKEN (ADR 0023), or null when it is unset. Each request carries
 * the identity token the agent token is exchanged for at auth.poietic.tech; the agent token itself goes nowhere else
 * and is never printed.
 */
export function agentFetch(
  env: CliIO['env'],
  opts: { fetchImpl?: typeof fetch } = {},
): ((request: Request) => Promise<Response>) | null {
  let agent: PoieticAgent | null;
  try {
    agent = agentFromEnv(env, opts);
  } catch {
    throw new CliError(
      'VALIDATION_FAILED',
      'POIETIC_AGENT_TOKEN is malformed: it must be the whole token, with no spaces',
    );
  }
  if (!agent) return null;
  return async (request) => {
    try {
      return await agent.fetch(request);
    } catch (error) {
      if (!(error instanceof PoieticAuthError)) throw error;
      throw error.status === 401
        ? new CliError(
            'UNAUTHENTICATED',
            'auth.poietic.tech refused POIETIC_AGENT_TOKEN: it is revoked or expired, or its owner may no longer own agents',
          )
        : new CliError('UNAVAILABLE', `Could not exchange POIETIC_AGENT_TOKEN (${error.message})`);
    }
  };
}

/** Builds the API client for the resolved mode: remote HTTP, in-process local database, or a test override. */
export async function openTransport(config: ResolvedConfig, io: CliIO): Promise<Transport> {
  if (io.fetch) {
    return {
      client: createClient({ baseUrl: 'http://tracker.local', fetch: io.fetch }),
      describe: 'injected transport',
      close: async () => {},
    };
  }
  if (config.mode === 'remote') {
    const asAgent = agentFetch(io.env);
    if (asAgent)
      return {
        client: createClient({ baseUrl: config.server!, fetch: retryingFetch(asAgent) }),
        describe: `${config.server} (agent)`,
        close: async () => {},
      };
    return {
      client: createClient({
        baseUrl: config.server!,
        token: config.token,
        fetch: retryingFetch(),
      }),
      describe: `${config.server} (${config.token ? 'token' : 'no token'})`,
      close: async () => {},
    };
  }
  const db = await openLocalDatabase(config.database!, true);
  const actor = config.sources.actor ? config.actor : await defaultLocalActor(db);
  // Attachments land next to a SQLite file (…/data/blobs, the dev server's default) unless configured.
  const file = /^sqlite:(\/.+)$/.exec(config.database!)?.[1];
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
    describe: `local ${config.database} as @${actor}`,
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
        `Database ${url} is not migrated (pending: ${status.pending.join(', ')}). Run \`poietic-issues db migrate\`.`,
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
      'No admin user in the local database. Run `poietic-issues db seed`, or `poietic-issues user create` with POIETIC_ISSUES_ACTOR set.',
    );
  return row.handle;
}
