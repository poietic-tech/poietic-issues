import { type Tx, withWriteTx } from '@poietic-tech/issues-db';
import {
  type CreateIssueTypeInput,
  CreateIssueTypeInputSchema,
  type IssueType,
  type UpdateIssueTypeInput,
  UpdateIssueTypeInputSchema,
} from '@poietic-tech/issues-schema';
import { nowIso, type ServiceContext } from '../context.ts';
import { conflict, isUniqueViolation, notFound, parseInput, validationError } from '../errors.ts';
import { diff, recordEvent } from '../events.ts';
import { toIssueType } from '../mappers.ts';
import { getIssueTypeRow, getProjectRow, requireProjectId } from '../refs.ts';

/** The types every new project starts with (ADR 0035). They are fully editable afterwards. */
export const DEFAULT_ISSUE_TYPES: ReadonlyArray<{ name: string; color: string }> = [
  { name: 'Feature', color: '#5e6ad2' },
  { name: 'Bug', color: '#eb5757' },
  { name: 'Task', color: '#95a2b3' },
];

/** A project's issue types, in their display order. */
export async function listIssueTypes(
  ctx: ServiceContext,
  projectRef: string,
): Promise<IssueType[]> {
  const project = await getProjectRow(ctx, ctx.db.kysely, projectRef, 'read');
  const rows = await ctx.db.kysely
    .selectFrom('issue_types')
    .selectAll()
    .where('project_id', '=', project.id)
    .orderBy('position')
    .orderBy('id')
    .execute();
  return rows.map(toIssueType);
}

async function typeRowById(db: Tx, id: string) {
  const row = await db
    .selectFrom('issue_types')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw notFound('IssueType', id);
  return row;
}

/** Inserts the default types into a new project, recording `issue_type.created` for each. */
export async function createDefaultIssueTypes(
  tx: Tx,
  ctx: ServiceContext,
  projectId: string,
): Promise<void> {
  const now = nowIso(ctx);
  for (const [position, t] of DEFAULT_ISSUE_TYPES.entries()) {
    const row = await tx
      .insertInto('issue_types')
      .values({
        id: ctx.ids('issueType'),
        project_id: projectId,
        name: t.name,
        color: t.color,
        position,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordEvent(tx, ctx, 'issue_type.created', {
      projectId,
      data: { issueType: toIssueType(row) },
    });
  }
}

export async function createIssueType(
  ctx: ServiceContext,
  projectRef: string,
  input: CreateIssueTypeInput,
): Promise<IssueType> {
  const data = parseInput(CreateIssueTypeInputSchema, input);
  try {
    return await withWriteTx(ctx.db, async (tx) => {
      const project = await getProjectRow(ctx, tx, projectRef, 'write');
      const existing = await tx
        .selectFrom('issue_types')
        .select('id')
        .where('project_id', '=', project.id)
        .execute();
      const position = Math.min(data.position ?? existing.length, existing.length);
      const now = nowIso(ctx);
      // Shift later types down to make room.
      await tx
        .updateTable('issue_types')
        .set((eb) => ({ position: eb('position', '+', 1) }))
        .where('project_id', '=', project.id)
        .where('position', '>=', position)
        .execute();
      const row = await tx
        .insertInto('issue_types')
        .values({
          id: ctx.ids('issueType'),
          project_id: project.id,
          name: data.name,
          color: data.color,
          position,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const issueType = toIssueType(row);
      await recordEvent(tx, ctx, 'issue_type.created', {
        projectId: project.id,
        data: { issueType },
      });
      return issueType;
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw conflict(`An issue type named "${data.name}" already exists in this project`);
    throw error;
  }
}

export async function updateIssueType(
  ctx: ServiceContext,
  typeId: string,
  input: UpdateIssueTypeInput,
): Promise<IssueType> {
  const patch = parseInput(UpdateIssueTypeInputSchema, input);
  try {
    return await withWriteTx(ctx.db, async (tx) => {
      const row = await typeRowById(tx, typeId);
      await requireProjectId(ctx, tx, row.project_id, 'write', 'IssueType', typeId);
      const before = toIssueType(row);
      const updated = await tx
        .updateTable('issue_types')
        .set({ ...patch, updated_at: nowIso(ctx) })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const issueType = toIssueType(updated);
      const changes = diff(before, issueType, ['name', 'color']);
      if (Object.keys(changes).length > 0)
        await recordEvent(tx, ctx, 'issue_type.updated', {
          projectId: issueType.projectId,
          data: { issueType, changes },
        });
      return issueType;
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw conflict(`An issue type named "${patch.name}" already exists in this project`);
    throw error;
  }
}

/**
 * Deletes an issue type. Its issues (trashed ones included) are left with no type, or move to `moveIssuesTo`
 * (another type's id or name in the same project) when it is given.
 */
export async function deleteIssueType(
  ctx: ServiceContext,
  typeId: string,
  opts: { moveIssuesTo?: string } = {},
): Promise<IssueType> {
  return withWriteTx(ctx.db, async (tx) => {
    const row = await typeRowById(tx, typeId);
    await requireProjectId(ctx, tx, row.project_id, 'write', 'IssueType', typeId);
    let targetId: string | null = null;
    if (opts.moveIssuesTo) {
      const target = await getIssueTypeRow(tx, row.project_id, opts.moveIssuesTo);
      if (target.id === row.id) throw validationError('moveIssuesTo must be a different type');
      targetId = target.id;
    }
    await tx
      .updateTable('issues')
      .set((eb) => ({
        type_id: targetId,
        version: eb('version', '+', 1),
        updated_at: nowIso(ctx),
      }))
      .where('type_id', '=', row.id)
      .execute();
    await tx.deleteFrom('issue_types').where('id', '=', row.id).execute();
    await compactPositions(tx, row.project_id);
    const issueType = toIssueType(row);
    await recordEvent(tx, ctx, 'issue_type.deleted', {
      projectId: row.project_id,
      data: { issueType },
    });
    return issueType;
  });
}

async function compactPositions(tx: Tx, projectId: string) {
  const rows = await tx
    .selectFrom('issue_types')
    .select('id')
    .where('project_id', '=', projectId)
    .orderBy('position')
    .orderBy('id')
    .execute();
  for (const [position, r] of rows.entries())
    await tx.updateTable('issue_types').set({ position }).where('id', '=', r.id).execute();
}

/** Sets the order of a project's issue types. `ids` must list every type exactly once. */
export async function reorderIssueTypes(
  ctx: ServiceContext,
  projectRef: string,
  ids: string[],
): Promise<IssueType[]> {
  return withWriteTx(ctx.db, async (tx) => {
    const project = await getProjectRow(ctx, tx, projectRef, 'write');
    const rows = await tx
      .selectFrom('issue_types')
      .selectAll()
      .where('project_id', '=', project.id)
      .execute();
    const known = new Set(rows.map((r) => r.id));
    if (
      ids.length !== rows.length ||
      new Set(ids).size !== ids.length ||
      !ids.every((id) => known.has(id))
    )
      throw validationError('ids must list every issue type of the project exactly once');
    const now = nowIso(ctx);
    for (const [position, id] of ids.entries())
      await tx
        .updateTable('issue_types')
        .set({ position, updated_at: now })
        .where('id', '=', id)
        .execute();
    const updated = await tx
      .selectFrom('issue_types')
      .selectAll()
      .where('project_id', '=', project.id)
      .orderBy('position')
      .execute();
    for (const r of updated) {
      const before = rows.find((b) => b.id === r.id)!;
      if (before.position !== r.position)
        await recordEvent(tx, ctx, 'issue_type.updated', {
          projectId: project.id,
          data: {
            issueType: toIssueType(r),
            changes: { position: { from: before.position, to: r.position } },
          },
        });
    }
    return updated.map(toIssueType);
  });
}
