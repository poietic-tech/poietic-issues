import type { Kysely } from 'kysely';
import type { Dialect } from '../dialect.ts';
import { columnTypes } from './helpers.ts';

/** An agent user's owner: the human it acts for (ADR 0023). Null for humans and for agents created by hand. */
export function migration0005(dialect: Dialect) {
  const t = columnTypes(dialect);
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('users')
        .addColumn('owner_id', t.id, (c) => c.references('users.id').onDelete('set null'))
        .execute();
      await db.schema.createIndex('users_owner_idx').on('users').column('owner_id').execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropIndex('users_owner_idx').execute();
      await db.schema.alterTable('users').dropColumn('owner_id').execute();
    },
  };
}
