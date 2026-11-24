import { type Kysely, sql } from 'kysely';
import { typeid } from 'typeid-js';
import type { Dialect } from '../dialect.ts';
import { columnTypes, createTable } from './helpers.ts';

/** The types every existing project gets. New projects get the same list from the projects service. */
const SEEDED_TYPES = [
  { name: 'Feature', color: '#5e6ad2' },
  { name: 'Bug', color: '#eb5757' },
  { name: 'Task', color: '#95a2b3' },
] as const;

/**
 * Per-project issue types (ADR 0035). An issue's type is optional: `issues.type_id` is null for "no type", and
 * deleting a type clears it on its issues. Every existing project is seeded with Feature, Bug and Task.
 */
export function migration0011(dialect: Dialect) {
  const t = columnTypes(dialect);
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await createTable(db, dialect, 'issue_types')
        .addColumn('id', t.id, (c) => c.primaryKey())
        .addColumn('project_id', t.id, (c) =>
          c.notNull().references('projects.id').onDelete('cascade'),
        )
        .addColumn('name', t.text, (c) => c.notNull())
        .addColumn('color', t.text, (c) => c.notNull())
        .addColumn('position', t.int, (c) => c.notNull())
        .addColumn('created_at', t.ts, (c) => c.notNull())
        .addColumn('updated_at', t.ts, (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('issue_types_project_name_uq')
        .on('issue_types')
        .columns(['project_id', sql`lower(name)` as never])
        .unique()
        .execute();

      await db.schema
        .alterTable('issues')
        .addColumn('type_id', t.id, (c) => c.references('issue_types.id').onDelete('set null'))
        .execute();
      await db.schema.createIndex('issues_type_idx').on('issues').column('type_id').execute();

      // Migrations have no injected clock; one timestamp for every seeded row.
      const now = new Date().toISOString();
      const projects = await sql<{ id: string }>`select id from projects order by id`.execute(db);
      for (const { id: projectId } of projects.rows)
        for (const [position, type] of SEEDED_TYPES.entries())
          await sql`
            insert into issue_types (id, project_id, name, color, position, created_at, updated_at)
            values (${typeid('typ').toString()}, ${projectId}, ${type.name}, ${type.color},
                    ${position}, ${now}, ${now})`.execute(db);
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropIndex('issues_type_idx').execute();
      await db.schema.alterTable('issues').dropColumn('type_id').execute();
      await db.schema.dropTable('issue_types').execute();
    },
  };
}
