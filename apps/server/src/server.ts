import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serve } from '@hono/node-server';
import {
  blobStoreFromEnv,
  createContext,
  ensureBuiltins,
  EventTailer,
  seedDemoData,
  SYSTEM_ACTOR,
  WebhookRunner,
} from '@poietic-tech/issues-core';
import {
  createDb,
  type Db,
  migrateToLatest,
  migrationStatus,
  parseDatabaseUrl,
} from '@poietic-tech/issues-db';
import { createApp } from './app.ts';
import { ssoOptionsFromConfig, type ServerConfig } from './config.ts';
import type { AppExtension } from './env.ts';
import { createLogger, type Logger } from './logger.ts';

export interface RunningServer {
  url: string;
  db: Db;
  tailer: EventTailer;
  logger: Logger;
  /** Graceful shutdown: stop accepting, end live streams, drain requests, stop workers, close the database. */
  close(): Promise<void>;
}

/** Prepares the database (migrate, builtins, optional demo seed) according to config. */
export async function prepareDatabase(
  db: Db,
  config: Pick<ServerConfig, 'POIETIC_ISSUES_AUTO_MIGRATE' | 'POIETIC_ISSUES_SEED'>,
  logger: Pick<Logger, 'info'> = createLogger({ level: 'silent' }),
) {
  if (config.POIETIC_ISSUES_AUTO_MIGRATE) {
    const applied = await migrateToLatest(db);
    if (applied.length) logger.info({ migrations: applied }, 'applied migrations');
  } else {
    const status = await migrationStatus(db);
    if (!status.upToDate)
      throw new Error(
        `Database is not migrated (pending: ${status.pending.join(', ')}). Run \`poietic-issues-admin db migrate\`.`,
      );
  }
  await ensureBuiltins(db);
  if (config.POIETIC_ISSUES_SEED) {
    const users = await db.kysely
      .selectFrom('users')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('kind', '!=', 'system')
      .executeTakeFirstOrThrow();
    if (Number(users.n) === 0) {
      await seedDemoData(createContext(db, SYSTEM_ACTOR));
      logger.info(
        'seeded demo data (users: ada [admin], grace, margaret, claude [agent]; public ENG with a linked repo, private OPS)',
      );
    }
  }
}

/** Starts the HTTP server. Used by `node apps/server/src/main.ts`, the bundled server and `poietic-issues-admin serve`. */
export async function startServer(
  config: ServerConfig,
  extensions: AppExtension[] = [],
): Promise<RunningServer> {
  const logger = createLogger({
    level: config.POIETIC_ISSUES_LOG_LEVEL,
    format: config.POIETIC_ISSUES_LOG_FORMAT,
  });
  const dbConfig = parseDatabaseUrl(config.POIETIC_ISSUES_DATABASE_URL);
  if (dbConfig.dialect === 'sqlite' && dbConfig.filename !== ':memory:')
    mkdirSync(dirname(dbConfig.filename), { recursive: true });
  const db = createDb(dbConfig);
  await prepareDatabase(db, config, logger);
  const tailer = new EventTailer(db);
  await tailer.start();

  const webhooks = { allowPrivate: config.POIETIC_ISSUES_WEBHOOK_ALLOW_PRIVATE };
  const runner = config.POIETIC_ISSUES_WEBHOOKS
    ? new WebhookRunner(db, {
        policy: webhooks,
        onError: (error) => logger.error({ err: error }, 'webhook runner failed'),
      })
    : undefined;
  runner?.start(tailer);

  const shutdown = new AbortController();
  const app = createApp({
    db,
    auth: {
      mode: 'standard',
      allowDevLogin: config.POIETIC_ISSUES_AUTH_MODE === 'dev',
      secureCookies: config.POIETIC_ISSUES_SECURE_COOKIES,
      allowedOrigins: config.POIETIC_ISSUES_ALLOWED_ORIGINS,
      sso: ssoOptionsFromConfig(config),
    },
    ...(config.POIETIC_ISSUES_WEB_DIR && { webDir: config.POIETIC_ISSUES_WEB_DIR }),
    tailer,
    webhooks,
    blobStore: blobStoreFromEnv(config as unknown as Record<string, string | undefined>),
    maxUploadBytes: config.POIETIC_ISSUES_MAX_UPLOAD_MB * 1024 * 1024,
    logger,
    shutdownSignal: shutdown.signal,
    extensions,
  });

  return new Promise((resolve) => {
    const server = serve(
      { fetch: app.fetch, hostname: config.POIETIC_ISSUES_HOST, port: config.POIETIC_ISSUES_PORT },
      (info) => {
        const url = `http://${info.address.includes(':') ? `[${info.address}]` : info.address}:${info.port}`;
        logger.info(
          {
            url,
            dialect: db.dialect,
            auth: config.POIETIC_ISSUES_AUTH_MODE,
            webhooks: Boolean(runner),
            web: Boolean(config.POIETIC_ISSUES_WEB_DIR),
          },
          'tracker listening',
        );
        let closing: Promise<void> | undefined;
        const http = server as unknown as {
          close(cb: () => void): void;
          closeIdleConnections?: () => void;
          closeAllConnections?: () => void;
        };
        const close = () =>
          (closing ??= (async () => {
            logger.info('shutting down');
            // End SSE streams (clients reconnect) and stop accepting new connections.
            shutdown.abort();
            const drained = new Promise<void>((done) => http.close(done));
            // Keep-alive connections become idle as their last response (or stream) finishes: close them as
            // they do, so draining ends as soon as the work does.
            const reaper = setInterval(() => http.closeIdleConnections?.(), 50);
            http.closeIdleConnections?.();
            void drained.then(() => clearInterval(reaper));
            const timeout = new Promise<'timeout'>((done) =>
              setTimeout(() => done('timeout'), config.POIETIC_ISSUES_SHUTDOWN_TIMEOUT_MS).unref(),
            );
            if ((await Promise.race([drained, timeout])) === 'timeout') {
              logger.warn('in-flight requests did not finish in time; closing connections');
              http.closeAllConnections?.();
              await drained;
            }
            clearInterval(reaper);
            await runner?.stop();
            await tailer.stop();
            await db.destroy();
            logger.info('stopped');
          })());
        resolve({ url, db, tailer, logger, close });
      },
    );
  });
}
