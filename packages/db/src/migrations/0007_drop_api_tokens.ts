import type { Kysely } from 'kysely';
import type { Dialect } from '../dialect.ts';
import { columnTypes, createTable } from './helpers.ts';

/**
 * Drops `api_tokens`: `trk_` API tokens are retired, and the only remote credential is an SSO identity token. Existing
 * tokens stop working when this runs. Dropping the table drops its index in both dialects. The way down recreates the
 * table as 0001 made it, empty: the tokens themselves are gone.
 */
export function migration0007(dialect: Dialect) {
  const t = columnTypes(dialect);
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('api_tokens').execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await createTable(db, dialect, 'api_tokens')
        .addColumn('id', t.id, (c) => c.primaryKey())
        .addColumn('user_id', t.id, (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('name', t.text, (c) => c.notNull())
        .addColumn('token_hash', t.text, (c) => c.notNull().unique())
        .addColumn('prefix', t.text, (c) => c.notNull())
        .addColumn('scopes', t.json, (c) => c.notNull())
        .addColumn('created_at', t.ts, (c) => c.notNull())
        .addColumn('last_used_at', t.ts)
        .addColumn('expires_at', t.ts)
        .addColumn('revoked_at', t.ts)
        .execute();
      await db.schema
        .createIndex('api_tokens_user_idx')
        .on('api_tokens')
        .column('user_id')
        .execute();
    },
  };
}
