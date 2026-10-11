import {
  type Database,
  type Dialect,
  fromJson,
  type Kysely,
  likeContains,
  type RawBuilder,
  sql,
} from '@poietic-tech/issues-db';
import {
  type FieldRegistry,
  formatIssueKey,
  type Issue,
  type IssueFilter,
  isIdOf,
  normalizeFilter,
  type Page,
  SORT_SENTINELS,
  SORTABLE_FIELDS,
  type SortSpec,
} from '@poietic-tech/issues-schema';
import { readableProjectIds, unrestricted, whereReadable, writableProjectIds } from './access.ts';
import type { ServiceContext } from './context.ts';
import { DomainError, validationError } from './errors.ts';
import { getIssueRow, parseRepoRef } from './refs.ts';
import {
  customFieldSql,
  loadCustomFieldValues,
  projectFieldRegistry,
} from './custom-field-query.ts';
import { list, scalarCondition, setCondition } from './sql-conditions.ts';
import { toUserOwner } from './mappers.ts';

type Exec = Kysely<Database>;
type Bool = RawBuilder<boolean>;

// ---------------------------------------------------------------------------
// Snapshot loading
// ---------------------------------------------------------------------------

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Loads full issue snapshots (the `Issue` resource) for the given ids, preserving input order.
 * Missing ids are skipped.
 */
export async function loadIssues(db: Exec, ids: string[]): Promise<Issue[]> {
  if (ids.length === 0) return [];
  const byId = new Map<string, Issue>();
  for (const part of chunk(ids, 500)) {
    const rows = await db
      .selectFrom('issues as i')
      .innerJoin('projects as p', 'p.id', 'i.project_id')
      .innerJoin('statuses as s', 's.id', 'i.status_id')
      .innerJoin('users as c', 'c.id', 'i.creator_id')
      .leftJoin('users as co', 'co.id', 'c.owner_id')
      .leftJoin('users as a', 'a.id', 'i.assignee_id')
      .leftJoin('users as ao', 'ao.id', 'a.owner_id')
      .leftJoin('issues as pi', 'pi.id', 'i.parent_id')
      .leftJoin('projects as pp', 'pp.id', 'pi.project_id')
      .leftJoin('project_repos as rp', 'rp.id', 'i.repo_id')
      .selectAll('i')
      .select([
        'p.key as project_key',
        's.name as status_name',
        's.category as status_category',
        's.color as status_color',
        'c.handle as c_handle',
        'c.name as c_name',
        'c.kind as c_kind',
        'c.avatar_url as c_avatar',
        'c.owner_id as c_owner_id',
        'co.handle as c_owner_handle',
        'a.handle as a_handle',
        'a.name as a_name',
        'a.kind as a_kind',
        'a.avatar_url as a_avatar',
        'a.owner_id as a_owner_id',
        'ao.handle as a_owner_handle',
        'pi.number as parent_number',
        'pi.title as parent_title',
        'pp.key as parent_project_key',
        'rp.owner as repo_owner',
        'rp.name as repo_name',
      ])
      .select((eb) => [
        eb
          .selectFrom('comments as cm')
          .select(eb.fn.countAll<number>().as('n'))
          .whereRef('cm.issue_id', '=', 'i.id')
          .where('cm.deleted_at', 'is', null)
          .as('comment_count'),
        eb
          .selectFrom('issues as ch')
          .select(eb.fn.countAll<number>().as('n'))
          .whereRef('ch.parent_id', '=', 'i.id')
          .where('ch.deleted_at', 'is', null)
          .as('child_count'),
      ])
      .where('i.id', 'in', part)
      .execute();

    const labelRows = await db
      .selectFrom('issue_labels as il')
      .innerJoin('labels as l', 'l.id', 'il.label_id')
      .select(['il.issue_id', 'l.id', 'l.name', 'l.color'])
      .where('il.issue_id', 'in', part)
      .orderBy('l.name')
      .execute();
    const customValues = await loadCustomFieldValues(db, part);

    for (const r of rows) {
      const labels = labelRows
        .filter((l) => l.issue_id === r.id)
        .map((l) => ({ id: l.id, name: l.name, color: l.color }));
      byId.set(r.id, {
        id: r.id,
        key: formatIssueKey(r.project_key, r.number),
        number: r.number,
        projectId: r.project_id,
        title: r.title,
        description: r.description,
        statusId: r.status_id,
        status: {
          id: r.status_id,
          name: r.status_name,
          category: r.status_category,
          color: r.status_color,
        },
        priority: r.priority,
        assigneeId: r.assignee_id,
        assignee:
          r.assignee_id && r.a_handle
            ? {
                id: r.assignee_id,
                handle: r.a_handle,
                name: r.a_name!,
                kind: r.a_kind!,
                avatarUrl: r.a_avatar,
                owner: toUserOwner(r.a_owner_id, r.a_owner_handle),
              }
            : null,
        creatorId: r.creator_id,
        creator: {
          id: r.creator_id,
          handle: r.c_handle,
          name: r.c_name,
          kind: r.c_kind,
          avatarUrl: r.c_avatar,
          owner: toUserOwner(r.c_owner_id, r.c_owner_handle),
        },
        parentId: r.parent_id,
        parent:
          r.parent_id && r.parent_project_key
            ? {
                id: r.parent_id,
                key: formatIssueKey(r.parent_project_key, r.parent_number!),
                title: r.parent_title!,
              }
            : null,
        repo: r.repo_owner ? `${r.repo_owner}/${r.repo_name}` : null,
        labelIds: labels.map((l) => l.id),
        labels,
        estimate: r.estimate,
        dueDate: r.due_date,
        rank: r.rank,
        customFields: customValues.get(r.id) ?? {},
        metadata: fromJson<Record<string, unknown>>(r.metadata, {}),
        commentCount: Number(r.comment_count ?? 0),
        childCount: Number(r.child_count ?? 0),
        version: r.version,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        canceledAt: r.canceled_at,
        deletedAt: r.deleted_at,
      });
    }
  }
  return ids.map((id) => byId.get(id)).filter((i): i is Issue => i !== undefined);
}

/**
 * Cuts a trashed parent (key and title) out of issues shown to an actor below `write` on their project: the
 * parent itself is NOT_FOUND to them. Writers keep it, since they can open and restore it. A parent is always in
 * its child's project, so the child's project decides. Pass `writable` to reuse a `writableProjectIds` result.
 */
export async function hideTrashedParents(
  ctx: ServiceContext,
  db: Exec,
  issues: Issue[],
  writable?: 'all' | string[],
): Promise<Issue[]> {
  if (writable === 'all' || unrestricted(ctx)) return issues;
  const parentIds = [...new Set(issues.flatMap((i) => (i.parentId ? [i.parentId] : [])))];
  if (!parentIds.length) return issues;
  const trashed = new Set(
    (
      await db
        .selectFrom('issues')
        .select('id')
        .where('id', 'in', parentIds)
        .where('deleted_at', 'is not', null)
        .execute()
    ).map((r) => r.id),
  );
  if (!trashed.size) return issues;
  const canWrite = writable ?? (await writableProjectIds(ctx, db));
  if (canWrite === 'all') return issues;
  return issues.map((i) =>
    i.parentId && trashed.has(i.parentId) && !canWrite.includes(i.projectId)
      ? { ...i, parentId: null, parent: null }
      : i,
  );
}

export async function loadIssue(db: Exec, id: string): Promise<Issue> {
  const [issue] = await loadIssues(db, [id]);
  if (!issue) throw new Error(`Issue ${id} vanished`);
  return issue;
}

// ---------------------------------------------------------------------------
// Filter compilation (must mirror `evaluateCondition` in @poietic-tech/issues-schema exactly)
// ---------------------------------------------------------------------------

const ISSUE_KEY_SQL = sql`(p.key || '-' || i.number)`;

const SCALAR_COLUMNS: Record<string, RawBuilder<unknown>> = {
  key: ISSUE_KEY_SQL,
  title: sql.ref('i.title'),
  status: sql.ref('i.status_id'),
  statusCategory: sql.ref('s.category'),
  priority: sql.ref('i.priority'),
  assignee: sql.ref('i.assignee_id'),
  creator: sql.ref('i.creator_id'),
  parent: sql.ref('i.parent_id'),
  repo: sql.ref('i.repo_id'),
  estimate: sql.ref('i.estimate'),
  dueDate: sql.ref('i.due_date'),
  createdAt: sql.ref('i.created_at'),
  updatedAt: sql.ref('i.updated_at'),
  completedAt: sql.ref('i.completed_at'),
};

/**
 * Compiles a normalized, ref-resolved filter into a SQL predicate over `issues as i`
 * joined with `projects as p` and `statuses as s`.
 */
export function compileFilter(filter: IssueFilter, registry: FieldRegistry): Bool {
  const parts = filter.conditions.map((c): Bool => {
    if (c.field === 'text') {
      const pattern = likeContains(String(c.value));
      return sql<boolean>`(lower(${ISSUE_KEY_SQL}) like lower(${pattern}) escape '\\' or lower(i.title) like lower(${pattern}) escape '\\' or lower(i.description) like lower(${pattern}) escape '\\')`;
    }
    if (c.field === 'labels') {
      return setCondition(
        (vals) =>
          vals === null
            ? sql<boolean>`exists (select 1 from issue_labels il where il.issue_id = i.id)`
            : vals.length === 0
              ? sql<boolean>`1 = 0`
              : sql<boolean>`exists (select 1 from issue_labels il where il.issue_id = i.id and il.label_id in (${list(vals)}))`,
        c.op,
        c.value,
      );
    }
    const custom = customFieldSql(c, registry);
    if (custom) return custom;
    const col = SCALAR_COLUMNS[c.field];
    if (!col) throw validationError(`Field "${c.field}" cannot be filtered`);
    return scalarCondition(col, c.op, c.value);
  });
  return parts.length ? sql<boolean>`(${sql.join(parts, sql` and `)})` : sql<boolean>`1 = 1`;
}

// ---------------------------------------------------------------------------
// Sorting & keyset pagination
// ---------------------------------------------------------------------------

/** SQL sort expression per field; must match `sortKey` in @poietic-tech/issues-schema. */
export function sortExpression(field: string, dialect: Dialect): RawBuilder<unknown> {
  switch (field) {
    case 'priority':
      return sql`(case when i.priority = 0 then ${sql.lit(SORT_SENTINELS.priorityNone)} else i.priority end)`;
    case 'dueDate':
      return sql`coalesce(i.due_date, ${sql.lit(SORT_SENTINELS.dateMax)})`;
    case 'estimate':
      return sql`coalesce(i.estimate, ${sql.lit(SORT_SENTINELS.numberMax)})`;
    case 'title':
      return dialect === 'postgres' ? sql`(lower(i.title) collate "C")` : sql`lower(i.title)`;
    case 'key':
      return sql`i.number`;
    case 'createdAt':
      return sql`i.created_at`;
    case 'updatedAt':
      return sql`i.updated_at`;
    case 'rank':
      return sql`i.rank`;
    default:
      throw validationError(`Cannot sort by "${field}" (sortable: ${SORTABLE_FIELDS.join(', ')})`);
  }
}

interface Cursor {
  v: unknown[];
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCursor(value: string, expectedLength: number): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString()) as Cursor;
    if (
      !Array.isArray(parsed.v) ||
      parsed.v.length !== expectedLength ||
      typeof parsed.id !== 'string'
    )
      throw new Error('shape');
    return parsed;
  } catch {
    throw validationError('Invalid cursor (it may belong to a different sort order)');
  }
}

function keysetCondition(exprs: RawBuilder<unknown>[], sorts: SortSpec[], cursor: Cursor): Bool {
  const branches: Bool[] = [];
  for (let k = 0; k <= exprs.length; k++) {
    const eqs = exprs.slice(0, k).map((e, j) => sql<boolean>`${e} = ${cursor.v[j]}`);
    const last =
      k < exprs.length
        ? sorts[k]!.dir === 'desc'
          ? sql<boolean>`${exprs[k]} < ${cursor.v[k]}`
          : sql<boolean>`${exprs[k]} > ${cursor.v[k]}`
        : sql<boolean>`i.id > ${cursor.id}`;
    branches.push(sql<boolean>`(${sql.join([...eqs, last], sql` and `)})`);
  }
  return sql<boolean>`(${sql.join(branches, sql` or `)})`;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface ListIssuesParams {
  /** Restrict to one project (id or key). */
  projectId?: string | undefined;
  filter?: IssueFilter | undefined;
  sort?: SortSpec[] | undefined;
  limit?: number | undefined;
  cursor?: string | null | undefined;
  /** Include trashed issues, in projects where the actor has `write` only. */
  includeDeleted?: boolean | undefined;
}

/**
 * Resolves human-friendly filter values to ids: status names, label names, user handles / `me`,
 * parent issue keys. Throws VALIDATION_FAILED for unknown names so agents get a clear error.
 */
export async function resolveFilterRefs(
  ctx: ServiceContext,
  db: Exec,
  filter: IssueFilter,
  projectId: string | undefined,
  known?: 'all' | string[],
): Promise<IssueFilter> {
  // Without a project, names are looked up across projects: only the ones the actor can read, so an
  // "Unknown ..." error never confirms that a private project has such a status or label. Pass `known` to
  // reuse a `readableProjectIds` result.
  const readable = projectId ? 'all' : (known ?? (await readableProjectIds(ctx, db)));
  const readableOnly = <QB extends { where(expr: Bool): QB }>(q: QB) =>
    whereReadable(ctx, db, q, 'project_id', readable);
  const conditions = [];
  for (const c of filter.conditions) {
    const resolve = async (v: unknown): Promise<unknown[]> => {
      if (v === null || typeof v !== 'string') return [v];
      switch (c.field) {
        case 'status': {
          if (isIdOf('status', v)) return [v];
          let q = db
            .selectFrom('statuses')
            .select('id')
            .where(sql`lower(name)`, '=', v.toLowerCase());
          if (projectId) q = q.where('project_id', '=', projectId);
          q = await readableOnly(q);
          const ids = (await q.execute()).map((r) => r.id);
          if (!ids.length) throw validationError(`Unknown status "${v}"`);
          return ids;
        }
        case 'labels': {
          if (isIdOf('label', v)) return [v];
          let q = db
            .selectFrom('labels')
            .select('id')
            .where(sql`lower(name)`, '=', v.toLowerCase());
          if (projectId) q = q.where('project_id', '=', projectId);
          q = await readableOnly(q);
          const ids = (await q.execute()).map((r) => r.id);
          if (!ids.length) throw validationError(`Unknown label "${v}"`);
          return ids;
        }
        case 'assignee':
        case 'creator': {
          if (v === 'me' || v === '@me') return [ctx.actor.id];
          if (v === 'none') return [null];
          if (isIdOf('user', v)) return [v];
          const row = await db
            .selectFrom('users')
            .select('id')
            .where('handle', '=', v.replace(/^@/, '').toLowerCase())
            .executeTakeFirst();
          if (!row) throw validationError(`Unknown user "${v}"`);
          return [row.id];
        }
        case 'parent': {
          try {
            return [(await getIssueRow(ctx, db, v, 'read')).id];
          } catch (error) {
            if (error instanceof DomainError && error.code === 'NOT_FOUND')
              throw validationError(`Unknown issue "${v}"`);
            throw error;
          }
        }
        case 'repo': {
          if (isIdOf('projectRepo', v)) return [v];
          const { owner, name } = parseRepoRef(v);
          let q = db
            .selectFrom('project_repos')
            .select('id')
            .where(sql`lower(owner)`, '=', owner.toLowerCase())
            .where(sql`lower(name)`, '=', name.toLowerCase());
          if (projectId) q = q.where('project_id', '=', projectId);
          else q = await readableOnly(q);
          const ids = (await q.execute()).map((r) => r.id);
          if (!ids.length) throw validationError(`Unknown repository "${v}"`);
          return ids;
        }
        default:
          return [v];
      }
    };
    if (Array.isArray(c.value)) {
      const values = (await Promise.all(c.value.map(resolve))).flat() as (string | number | null)[];
      conditions.push({ ...c, value: values });
    } else if (c.op === 'isNull' || c.value === undefined) {
      conditions.push(c);
    } else {
      const values = (await resolve(c.value)) as (string | number | null)[];
      if (values.length === 1) conditions.push({ ...c, value: values[0]! });
      else
        conditions.push({
          ...c,
          op: c.op === 'neq' ? ('nin' as const) : ('in' as const),
          value: values,
        });
    }
  }
  return { conditions };
}

/** Lists issues with filtering, sorting and keyset pagination. */
export async function queryIssues(
  ctx: ServiceContext,
  params: ListIssuesParams,
): Promise<Page<Issue>> {
  const db = ctx.db.kysely;
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const sorts: SortSpec[] = params.sort?.length
    ? params.sort
    : [{ field: 'updatedAt', dir: 'desc' }];
  const registry = await projectFieldRegistry(db, params.projectId);

  const normalized = normalizeFilter(params.filter ?? { conditions: [] }, registry);
  if (normalized.errors.length)
    throw validationError(
      normalized.errors.join('; '),
      normalized.errors.map((m) => ({ path: `filter.${m.split(':')[0]}`, message: m })),
    );
  // Unscoped listings check readability twice (filter names and rows): read the readable set once.
  const readable = params.projectId ? 'all' : await readableProjectIds(ctx, db);
  const filter = await resolveFilterRefs(ctx, db, normalized.filter, params.projectId, readable);

  const exprs = sorts.map((s) => sortExpression(s.field, ctx.db.dialect));
  let q = db
    .selectFrom('issues as i')
    .innerJoin('projects as p', 'p.id', 'i.project_id')
    .innerJoin('statuses as s', 's.id', 'i.status_id')
    .select('i.id')
    .where(compileFilter(filter, registry));
  exprs.forEach((e, k) => {
    q = q.select(e.as(`s${k}`)).orderBy(e, sorts[k]!.dir);
  });
  q = q.orderBy('i.id', 'asc');
  if (params.projectId) q = q.where('i.project_id', '=', params.projectId);
  else q = await whereReadable(ctx, db, q, 'i.project_id', readable);
  let writable: 'all' | string[] | undefined;
  if (params.includeDeleted) {
    // Trashed issues are shown only in projects the actor can write in (deleted content needs write).
    const canWrite = await writableProjectIds(ctx, db);
    writable = canWrite;
    if (canWrite !== 'all')
      q = q.where((eb) =>
        canWrite.length
          ? eb.or([eb('i.deleted_at', 'is', null), eb('i.project_id', 'in', canWrite)])
          : eb('i.deleted_at', 'is', null),
      );
  } else q = q.where('i.deleted_at', 'is', null);
  if (params.cursor)
    q = q.where(keysetCondition(exprs, sorts, decodeCursor(params.cursor, sorts.length)));

  const rows = (await q.limit(limit + 1).execute()) as Array<
    Record<string, unknown> & { id: string }
  >;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > limit && last
      ? encodeCursor({ v: sorts.map((_, k) => last[`s${k}`]), id: last.id })
      : null;
  const issues = await loadIssues(
    db,
    page.map((r) => r.id),
  );
  return { data: await hideTrashedParents(ctx, db, issues, writable), nextCursor };
}
