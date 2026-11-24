import { type Tx, toJson, withWriteTx } from '@poietic-tech/issues-db';
import {
  type CreateIssueInput,
  CreateIssueInputSchema,
  type Issue,
  type IssueFilter,
  type MoveIssueInput,
  MoveIssueInputSchema,
  type Page,
  type SortSpec,
  type StatusCategory,
  type TrackerEvent,
  type UpdateIssueInput,
  UpdateIssueInputSchema,
} from '@poietic-tech/issues-schema';
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { nowIso, type ServiceContext } from '../context.ts';
import {
  customValueChanged,
  resolveCustomFieldValues,
  writeCustomFieldValues,
} from '../custom-field-values.ts';
import { conflict, DomainError, invalidRelation, parseInput, validationError } from '../errors.ts';
import { diff, recordEvent } from '../events.ts';
import { hideTrashedParents, loadIssue, queryIssues } from '../issue-query.ts';
import { atLeast } from '../access.ts';
import { requireAdmin } from '../permissions.ts';
import {
  getIssueAccess,
  getIssueRow,
  getIssueTypeRow,
  getProjectRow,
  getStatusRow,
  getUserRow,
} from '../refs.ts';
import { listEvents } from './events.ts';
import { findRepo } from './repos.ts';

/** Fields compared to build `changes` in `issue.updated` events. */
const TRACKED_FIELDS = [
  'title',
  'description',
  'status',
  'type',
  'priority',
  'assignee',
  'parent',
  'repo',
  'labels',
  'estimate',
  'dueDate',
  'customFields',
  'metadata',
  'rank',
] as const;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Gets an issue by key (`ENG-42`) or id. Issues in the trash are found only by actors with `write`. */
export async function getIssue(ctx: ServiceContext, ref: string): Promise<Issue> {
  const { row, level } = await getIssueAccess(ctx, ctx.db.kysely, ref, 'read');
  const issue = await loadIssue(ctx.db.kysely, row.id);
  if (atLeast(level, 'write')) return issue;
  const [shown] = await hideTrashedParents(ctx, ctx.db.kysely, [issue], []);
  return shown!;
}

export interface ListIssuesInput {
  project?: string | undefined;
  filter?: IssueFilter | undefined;
  sort?: SortSpec[] | undefined;
  limit?: number | undefined;
  cursor?: string | null | undefined;
  /** Include trashed issues, in projects where the actor has `write` only. */
  includeDeleted?: boolean | undefined;
}

/** Lists issues (optionally in one project) with filtering, sorting and cursor pagination. */
export async function listIssues(
  ctx: ServiceContext,
  input: ListIssuesInput = {},
): Promise<Page<Issue>> {
  const project = input.project
    ? await getProjectRow(ctx, ctx.db.kysely, input.project, 'read')
    : undefined;
  return queryIssues(ctx, { ...input, projectId: project?.id });
}

/** Direct children (sub-issues) of an issue, in manual order. */
export async function listChildren(ctx: ServiceContext, ref: string): Promise<Issue[]> {
  const row = await getIssueRow(ctx, ctx.db.kysely, ref, 'read');
  const page = await queryIssues(ctx, {
    projectId: row.project_id,
    filter: { conditions: [{ field: 'parent', op: 'eq', value: row.id }] },
    sort: [{ field: 'rank', dir: 'asc' }],
    limit: 200,
  });
  return page.data;
}

/** Activity (event history) of an issue, oldest first. Includes comment and link events. */
export async function listIssueActivity(
  ctx: ServiceContext,
  ref: string,
  opts: { after?: number; limit?: number } = {},
): Promise<Page<TrackerEvent>> {
  const row = await getIssueRow(ctx, ctx.db.kysely, ref, 'read');
  return listEvents(ctx, {
    issue: row.id,
    after: opts.after,
    limit: opts.limit,
    includeLinksTo: true,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Timestamps implied by moving into a status category. */
function categoryTimestamps(
  current: { started_at: string | null; completed_at: string | null; canceled_at: string | null },
  category: StatusCategory,
  now: string,
) {
  return {
    started_at:
      category === 'started' || category === 'completed'
        ? (current.started_at ?? now)
        : current.started_at,
    completed_at: category === 'completed' ? (current.completed_at ?? now) : null,
    canceled_at: category === 'canceled' ? (current.canceled_at ?? now) : null,
  };
}

async function defaultStatus(tx: Tx, projectId: string) {
  const statuses = await tx
    .selectFrom('statuses')
    .selectAll()
    .where('project_id', '=', projectId)
    .orderBy('position')
    .orderBy('id')
    .execute();
  const pick =
    statuses.find((s) => s.category === 'unstarted') ??
    statuses.find((s) => s.category === 'backlog') ??
    statuses[0];
  if (!pick) throw conflict('Project has no statuses');
  return pick;
}

async function columnItems(tx: Tx, projectId: string, statusId: string, excludeId?: string) {
  let q = tx
    .selectFrom('issues')
    .select(['id', 'rank'])
    .where('project_id', '=', projectId)
    .where('status_id', '=', statusId)
    .where('deleted_at', 'is', null)
    .orderBy('rank')
    .orderBy('id');
  if (excludeId) q = q.where('id', '!=', excludeId);
  return q.execute();
}

/** Reassigns evenly spaced ranks to a column (only needed if two neighbours share a rank). */
async function rebalanceColumn(tx: Tx, items: Array<{ id: string; rank: string }>) {
  const keys = generateNKeysBetween(null, null, items.length);
  for (const [i, item] of items.entries()) {
    item.rank = keys[i]!;
    await tx.updateTable('issues').set({ rank: item.rank }).where('id', '=', item.id).execute();
  }
}

/**
 * Computes the rank for placing an issue in a column: after `afterId`, before `beforeId`,
 * or at the top/bottom. Ids refer to issues already in the column.
 */
async function rankForPlacement(
  ctx: ServiceContext,
  tx: Tx,
  projectId: string,
  statusId: string,
  movingId: string | undefined,
  placement: { afterId?: string | null; beforeId?: string | null; position?: 'top' | 'bottom' },
): Promise<string> {
  const items = await columnItems(tx, projectId, statusId, movingId);
  const indexOf = async (ref: string) => {
    const row = await getIssueRow(ctx, tx, ref, 'write');
    const idx = items.findIndex((i) => i.id === row.id);
    if (idx < 0) throw validationError(`Issue "${ref}" is not in the target column`);
    return idx;
  };
  let prevIdx: number;
  if (placement.afterId) prevIdx = await indexOf(placement.afterId);
  else if (placement.beforeId) prevIdx = (await indexOf(placement.beforeId)) - 1;
  else prevIdx = placement.position === 'bottom' ? items.length - 1 : -1;

  let prev = items[prevIdx];
  let next = items[prevIdx + 1];
  if (prev && next && prev.rank >= next.rank) {
    await rebalanceColumn(tx, items);
    prev = items[prevIdx];
    next = items[prevIdx + 1];
  }
  return generateKeyBetween(prev?.rank ?? null, next?.rank ?? null);
}

async function resolveLabelIds(tx: Tx, projectId: string, refs: string[]): Promise<string[]> {
  if (refs.length === 0) return [];
  const labels = await tx
    .selectFrom('labels')
    .select(['id', 'name'])
    .where('project_id', '=', projectId)
    .execute();
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const ref of refs) {
    const label = labels.find(
      (l) => l.id === ref || l.name.toLowerCase() === ref.trim().toLowerCase(),
    );
    if (!label) unknown.push(ref);
    else if (!ids.includes(label.id)) ids.push(label.id);
  }
  if (unknown.length)
    throw validationError(
      `Unknown label(s): ${unknown.join(', ')} (create them first; existing: ${labels.map((l) => l.name).join(', ') || 'none'})`,
    );
  return ids;
}

async function resolveAssignee(
  ctx: ServiceContext,
  tx: Tx,
  ref: string | null,
): Promise<string | null> {
  if (ref === null) return null;
  const user = await getUserRow(ctx, tx, ref);
  if (user.deactivated_at) throw validationError(`User "${ref}" is deactivated`);
  if (user.kind === 'system') throw validationError('Issues cannot be assigned to the system user');
  return user.id;
}

async function resolveParent(
  ctx: ServiceContext,
  tx: Tx,
  issue: { id?: string; projectId: string },
  ref: string | null,
) {
  if (ref === null) return null;
  const parent = await getIssueRow(ctx, tx, ref, 'write');
  if (parent.project_id !== issue.projectId)
    throw invalidRelation('A parent must be in the same project');
  if (parent.deleted_at) throw invalidRelation('The parent issue is deleted');
  if (issue.id) {
    // Walk up from the new parent; reaching the issue itself means a cycle.
    let cursor: string | null = parent.id;
    for (let depth = 0; cursor; depth++) {
      if (cursor === issue.id) throw invalidRelation('That parent would create a cycle');
      if (depth > 50) throw invalidRelation('Parent chain is too deep');
      const up: { parent_id: string | null } | undefined = await tx
        .selectFrom('issues')
        .select('parent_id')
        .where('id', '=', cursor)
        .executeTakeFirst();
      cursor = up?.parent_id ?? null;
    }
  }
  return parent.id;
}

/** Resolves a repo ref (`rpo_` id, `owner/name` or URL) to one of the project's linked repos. */
async function resolveRepoId(
  tx: Tx,
  projectId: string,
  ref: string | null,
): Promise<string | null> {
  if (ref === null) return null;
  const repo = await findRepo(tx, projectId, ref);
  if (repo) return repo.id;
  // Only the error needs the project's key.
  const { key } = await tx
    .selectFrom('projects')
    .select('key')
    .where('id', '=', projectId)
    .executeTakeFirstOrThrow();
  throw invalidRelation(`"${ref}" is not linked to project ${key}`);
}

/**
 * Clears an issue's repo (used when its repo is unlinked), recording `issue.updated`. Trashed issues
 * can't go through a normal update, so they are cleared directly with the same event.
 */
export async function clearIssueRepo(ctx: ServiceContext, tx: Tx, issueId: string): Promise<void> {
  const row = await getIssueRow(ctx, tx, issueId, 'write');
  if (!row.deleted_at) {
    await updateIssueInTx(tx, ctx, issueId, { repo: null });
    return;
  }
  const before = await loadIssue(tx, row.id);
  await tx
    .updateTable('issues')
    .set({ repo_id: null, version: row.version + 1, updated_at: nowIso(ctx) })
    .where('id', '=', row.id)
    .execute();
  const issue = await loadIssue(tx, row.id);
  await recordEvent(tx, ctx, 'issue.updated', {
    projectId: row.project_id,
    issueId: row.id,
    data: { issue, changes: diff(before, issue, TRACKED_FIELDS) },
  });
}

async function setLabels(tx: Tx, ctx: ServiceContext, issueId: string, labelIds: string[]) {
  await tx.deleteFrom('issue_labels').where('issue_id', '=', issueId).execute();
  if (labelIds.length)
    await tx
      .insertInto('issue_labels')
      .values(
        labelIds.map((label_id) => ({ issue_id: issueId, label_id, created_at: nowIso(ctx) })),
      )
      .execute();
}

function checkVersion(actual: number, expected: number | undefined) {
  if (expected !== undefined && expected !== actual)
    throw new DomainError(
      'VERSION_MISMATCH',
      `Issue is at version ${actual}, not ${expected}; refetch and retry`,
    );
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Creates an issue in a project. New issues go to the top of their status column. */
export async function createIssue(
  ctx: ServiceContext,
  projectRef: string,
  input: CreateIssueInput,
): Promise<Issue> {
  const data = parseInput(CreateIssueInputSchema, input);
  return withWriteTx(ctx.db, async (tx) => {
    const project = await getProjectRow(ctx, tx, projectRef, 'write');
    if (project.archived_at) throw conflict(`Project ${project.key} is archived`);
    const status = data.status
      ? await getStatusRow(tx, project.id, data.status)
      : await defaultStatus(tx, project.id);
    const typeId = data.type ? (await getIssueTypeRow(tx, project.id, data.type)).id : null;
    const assigneeId = await resolveAssignee(ctx, tx, data.assignee ?? null);
    const parentId = await resolveParent(ctx, tx, { projectId: project.id }, data.parent ?? null);
    const repoId = await resolveRepoId(tx, project.id, data.repo ?? null);
    const labelIds = await resolveLabelIds(tx, project.id, data.labels);
    const customValues = await resolveCustomFieldValues(tx, ctx, project.id, data.customFields);
    const { next_issue_number } = await tx
      .updateTable('projects')
      .set((eb) => ({ next_issue_number: eb('next_issue_number', '+', 1) }))
      .where('id', '=', project.id)
      .returning('next_issue_number')
      .executeTakeFirstOrThrow();
    const now = nowIso(ctx);
    const id = ctx.ids('issue');
    const rank = await rankForPlacement(ctx, tx, project.id, status.id, undefined, {
      position: 'top',
    });
    await tx
      .insertInto('issues')
      .values({
        id,
        project_id: project.id,
        number: next_issue_number - 1,
        title: data.title,
        description: data.description,
        status_id: status.id,
        type_id: typeId,
        priority: data.priority,
        assignee_id: assigneeId,
        creator_id: ctx.actor.id,
        parent_id: parentId,
        repo_id: repoId,
        estimate: data.estimate ?? null,
        due_date: data.dueDate ?? null,
        rank,
        metadata: toJson(data.metadata),
        version: 1,
        created_at: now,
        updated_at: now,
        ...categoryTimestamps(
          { started_at: null, completed_at: null, canceled_at: null },
          status.category,
          now,
        ),
        deleted_at: null,
      })
      .execute();
    await setLabels(tx, ctx, id, labelIds);
    await writeCustomFieldValues(tx, ctx, id, customValues);
    const issue = await loadIssue(tx, id);
    await recordEvent(tx, ctx, 'issue.created', {
      projectId: project.id,
      issueId: id,
      data: { issue },
    });
    return issue;
  });
}

/**
 * Applies a partial update inside an existing write transaction. Returns the updated issue, or the
 * unchanged issue (no version bump, no event) when the patch changes nothing.
 */
export async function updateIssueInTx(
  tx: Tx,
  ctx: ServiceContext,
  ref: string,
  input: UpdateIssueInput,
): Promise<Issue> {
  const patch = parseInput(UpdateIssueInputSchema, input);
  const row = await getIssueRow(ctx, tx, ref, 'write');
  if (row.deleted_at) throw conflict(`Issue ${ref} is deleted; restore it first`);
  checkVersion(row.version, patch.expectedVersion);
  const before = await loadIssue(tx, row.id);
  const now = nowIso(ctx);
  const set: Record<string, unknown> = {};

  if (patch.title !== undefined && patch.title !== row.title) set.title = patch.title;
  if (patch.description !== undefined && patch.description !== row.description)
    set.description = patch.description;
  if (patch.priority !== undefined && patch.priority !== row.priority)
    set.priority = patch.priority;
  if (patch.estimate !== undefined && patch.estimate !== row.estimate)
    set.estimate = patch.estimate;
  if (patch.dueDate !== undefined && patch.dueDate !== row.due_date) set.due_date = patch.dueDate;
  if (
    patch.metadata !== undefined &&
    JSON.stringify(patch.metadata) !== JSON.stringify(before.metadata)
  )
    set.metadata = toJson(patch.metadata);
  if (patch.status !== undefined) {
    const status = await getStatusRow(tx, row.project_id, patch.status);
    if (status.id !== row.status_id) {
      set.status_id = status.id;
      Object.assign(set, categoryTimestamps(row, status.category, now));
    }
  }
  if (patch.assignee !== undefined) {
    const assigneeId = await resolveAssignee(ctx, tx, patch.assignee);
    if (assigneeId !== row.assignee_id) set.assignee_id = assigneeId;
  }
  if (patch.parent !== undefined) {
    const parentId = await resolveParent(
      ctx,
      tx,
      { id: row.id, projectId: row.project_id },
      patch.parent,
    );
    if (parentId !== row.parent_id) set.parent_id = parentId;
  }
  if (patch.repo !== undefined) {
    const repoId = await resolveRepoId(tx, row.project_id, patch.repo);
    if (repoId !== row.repo_id) set.repo_id = repoId;
  }
  if (patch.type !== undefined) {
    const typeId = patch.type ? (await getIssueTypeRow(tx, row.project_id, patch.type)).id : null;
    if (typeId !== row.type_id) set.type_id = typeId;
  }

  let labelIds: string[] | undefined;
  if (
    patch.labels !== undefined ||
    patch.addLabels !== undefined ||
    patch.removeLabels !== undefined
  ) {
    let next =
      patch.labels !== undefined
        ? await resolveLabelIds(tx, row.project_id, patch.labels)
        : [...before.labelIds];
    const add = await resolveLabelIds(tx, row.project_id, patch.addLabels ?? []);
    const remove = await resolveLabelIds(tx, row.project_id, patch.removeLabels ?? []);
    next = [...next, ...add.filter((id) => !next.includes(id))].filter(
      (id) => !remove.includes(id),
    );
    const same =
      next.length === before.labelIds.length && next.every((id) => before.labelIds.includes(id));
    if (!same) labelIds = next;
  }

  const customValues = patch.customFields
    ? (await resolveCustomFieldValues(tx, ctx, row.project_id, patch.customFields)).filter((v) =>
        customValueChanged(before.customFields[v.key], v.value),
      )
    : [];

  if (Object.keys(set).length === 0 && labelIds === undefined && customValues.length === 0)
    return before;

  await tx
    .updateTable('issues')
    .set({ ...set, version: row.version + 1, updated_at: now })
    .where('id', '=', row.id)
    .execute();
  if (labelIds !== undefined) await setLabels(tx, ctx, row.id, labelIds);
  await writeCustomFieldValues(tx, ctx, row.id, customValues);

  const issue = await loadIssue(tx, row.id);
  const changes = diff(before, issue, TRACKED_FIELDS);
  await recordEvent(tx, ctx, 'issue.updated', {
    projectId: row.project_id,
    issueId: row.id,
    data: { issue, changes },
  });
  return issue;
}

/** Updates an issue. Pass `expectedVersion` for optimistic concurrency. */
export async function updateIssue(
  ctx: ServiceContext,
  ref: string,
  input: UpdateIssueInput,
): Promise<Issue> {
  return withWriteTx(ctx.db, (tx) => updateIssueInTx(tx, ctx, ref, input));
}

/**
 * Applies the same patch to up to 100 issues atomically: either every issue updates or none does
 * (the first failure aborts the batch and is rethrown).
 */
export async function bulkUpdateIssues(
  ctx: ServiceContext,
  refs: string[],
  input: Omit<UpdateIssueInput, 'expectedVersion'>,
): Promise<Issue[]> {
  if (refs.length === 0) return [];
  if (refs.length > 100) throw validationError('At most 100 issues per bulk update');
  return withWriteTx(ctx.db, async (tx) => {
    const out: Issue[] = [];
    for (const ref of refs) out.push(await updateIssueInTx(tx, ctx, ref, input));
    return out;
  });
}

/** Moves an issue on the board: optionally to another status, placed relative to neighbours. */
export async function moveIssue(
  ctx: ServiceContext,
  ref: string,
  input: MoveIssueInput,
): Promise<Issue> {
  const data = parseInput(MoveIssueInputSchema, input);
  return withWriteTx(ctx.db, async (tx) => {
    const row = await getIssueRow(ctx, tx, ref, 'write');
    if (row.deleted_at) throw conflict(`Issue ${ref} is deleted; restore it first`);
    checkVersion(row.version, data.expectedVersion);
    const before = await loadIssue(tx, row.id);
    const status = data.status ? await getStatusRow(tx, row.project_id, data.status) : undefined;
    const statusId = status?.id ?? row.status_id;
    const rank = await rankForPlacement(ctx, tx, row.project_id, statusId, row.id, data);
    const now = nowIso(ctx);
    await tx
      .updateTable('issues')
      .set({
        rank,
        status_id: statusId,
        ...(status && status.id !== row.status_id
          ? categoryTimestamps(row, status.category, now)
          : {}),
        version: row.version + 1,
        updated_at: now,
      })
      .where('id', '=', row.id)
      .execute();
    const issue = await loadIssue(tx, row.id);
    const changes = diff(before, issue, TRACKED_FIELDS);
    await recordEvent(tx, ctx, 'issue.updated', {
      projectId: row.project_id,
      issueId: row.id,
      data: { issue, changes },
    });
    return issue;
  });
}

/**
 * Moves an issue to the trash (restorable). With `permanent`, deletes it and its comments, links and
 * attachments for good — admin only.
 */
export async function deleteIssue(
  ctx: ServiceContext,
  ref: string,
  opts: { permanent?: boolean; expectedVersion?: number } = {},
): Promise<Issue> {
  if (opts.permanent) requireAdmin(ctx, 'permanently delete issues');
  return withWriteTx(ctx.db, async (tx) => {
    const row = await getIssueRow(ctx, tx, ref, 'write');
    checkVersion(row.version, opts.expectedVersion);
    if (opts.permanent) {
      const issue = await loadIssue(tx, row.id);
      await tx.deleteFrom('issues').where('id', '=', row.id).execute();
      await recordEvent(tx, ctx, 'issue.deleted', {
        projectId: row.project_id,
        issueId: row.id,
        data: { issue, permanent: true },
      });
      return issue;
    }
    if (row.deleted_at) return loadIssue(tx, row.id);
    const now = nowIso(ctx);
    await tx
      .updateTable('issues')
      .set({ deleted_at: now, version: row.version + 1, updated_at: now })
      .where('id', '=', row.id)
      .execute();
    const issue = await loadIssue(tx, row.id);
    await recordEvent(tx, ctx, 'issue.deleted', {
      projectId: row.project_id,
      issueId: row.id,
      data: { issue },
    });
    return issue;
  });
}

/** Restores an issue from the trash. */
export async function restoreIssue(ctx: ServiceContext, ref: string): Promise<Issue> {
  return withWriteTx(ctx.db, async (tx) => {
    const row = await getIssueRow(ctx, tx, ref, 'write');
    if (!row.deleted_at) return loadIssue(tx, row.id);
    const now = nowIso(ctx);
    await tx
      .updateTable('issues')
      .set({ deleted_at: null, version: row.version + 1, updated_at: now })
      .where('id', '=', row.id)
      .execute();
    const issue = await loadIssue(tx, row.id);
    await recordEvent(tx, ctx, 'issue.restored', {
      projectId: row.project_id,
      issueId: row.id,
      data: { issue },
    });
    return issue;
  });
}
