import type { Kysely, Database, Selectable } from '@poietic-tech/issues-db';
import { isIdOf, parseIssueKey } from '@poietic-tech/issues-schema';
import { type AccessLevel, atLeast, projectLevel, requireLevel } from './access.ts';
import type { ServiceContext } from './context.ts';
import { notFound, validationError } from './errors.ts';

type Exec = Kysely<Database>;
type Need = Exclude<AccessLevel, 'none'>;

/** Resolves a project by id (`prj_…`) or key (`ENG`, case-insensitive). */
export async function findProject(
  db: Exec,
  ref: string,
): Promise<Selectable<Database['projects']> | undefined> {
  const q = db.selectFrom('projects').selectAll();
  return isIdOf('project', ref)
    ? q.where('id', '=', ref).executeTakeFirst()
    : q.where('key', '=', ref.trim().toUpperCase()).executeTakeFirst();
}

/** Resolves a project the actor may access at `level`; unreadable projects are NOT_FOUND (ADR 0021). */
export async function getProjectRow(ctx: ServiceContext, db: Exec, ref: string, level: Need) {
  const row = await findProject(db, ref);
  if (!row) throw notFound('Project', ref);
  requireLevel(ctx, await projectLevel(ctx, db, row), level, 'Project', ref);
  return row;
}

/**
 * Access check for a row found by its own id (a label, a comment, …) that belongs to `projectId`.
 * Failures are reported about the row (`what` and `ref`, e.g. `'Label'`, `lbl_…`), never the project, so an
 * unreadable row is indistinguishable from one that doesn't exist.
 */
export async function requireProjectId(
  ctx: ServiceContext,
  db: Exec,
  projectId: string,
  level: Need,
  what: string,
  ref: string,
) {
  return (await requireProjectAccess(ctx, db, projectId, level, what, ref)).project;
}

/** `requireProjectId` that also returns the actor's level, for callers that check more than `need`. */
export async function requireProjectAccess(
  ctx: ServiceContext,
  db: Exec,
  projectId: string,
  need: Need,
  what: string,
  ref: string,
) {
  const project = await findProject(db, projectId);
  if (!project) throw notFound(what, ref);
  const level = await projectLevel(ctx, db, project);
  requireLevel(ctx, level, need, what, ref);
  return { project, level };
}

/** Resolves an issue by id (`iss_…`) or key (`ENG-42`). Includes soft-deleted issues. */
export async function findIssue(
  db: Exec,
  ref: string,
): Promise<Selectable<Database['issues']> | undefined> {
  if (isIdOf('issue', ref))
    return db.selectFrom('issues').selectAll().where('id', '=', ref).executeTakeFirst();
  const key = parseIssueKey(ref);
  if (!key) return undefined;
  return db
    .selectFrom('issues')
    .innerJoin('projects', 'projects.id', 'issues.project_id')
    .selectAll('issues')
    .where('projects.key', '=', key.projectKey)
    .where('issues.number', '=', key.number)
    .executeTakeFirst();
}

/**
 * Resolves an issue whose project the actor may access at `level`. Soft-deleted issues are included for actors
 * with `write` on the project (restore, delete); below that a trashed issue is NOT_FOUND, whatever `level` asks.
 */
export async function getIssueRow(ctx: ServiceContext, db: Exec, ref: string, level: Need) {
  return (await getIssueAccess(ctx, db, ref, level)).row;
}

/** `getIssueRow` that also returns the actor's level on the issue's project. */
export async function getIssueAccess(ctx: ServiceContext, db: Exec, ref: string, need: Need) {
  const row = await findIssue(db, ref);
  if (!row) throw notFound('Issue', ref);
  const project = await findProject(db, row.project_id);
  const level = await projectLevel(ctx, db, project!);
  if (row.deleted_at && !atLeast(level, 'write')) throw notFound('Issue', ref);
  requireLevel(ctx, level, need, 'Issue', ref);
  return { row, level };
}

/**
 * Resolves a user by id (`usr_…`), handle (`ada` or `@ada`, case-insensitive) or `me`.
 */
export async function findUser(
  ctx: Pick<ServiceContext, 'actor'>,
  db: Exec,
  ref: string,
): Promise<Selectable<Database['users']> | undefined> {
  const trimmed = ref.trim();
  const q = db.selectFrom('users').selectAll();
  if (trimmed === 'me' || trimmed === '@me')
    return q.where('id', '=', ctx.actor.id).executeTakeFirst();
  if (isIdOf('user', trimmed) || trimmed === 'usr_system')
    return q.where('id', '=', trimmed).executeTakeFirst();
  return q.where('handle', '=', trimmed.replace(/^@/, '').toLowerCase()).executeTakeFirst();
}

export async function getUserRow(ctx: Pick<ServiceContext, 'actor'>, db: Exec, ref: string) {
  const row = await findUser(ctx, db, ref);
  if (!row) throw notFound('User', ref);
  return row;
}

/** Resolves a status of a project by id or name (case-insensitive). */
export async function findStatus(db: Exec, projectId: string, ref: string) {
  const q = db.selectFrom('statuses').selectAll().where('project_id', '=', projectId);
  if (isIdOf('status', ref)) return q.where('id', '=', ref).executeTakeFirst();
  const rows = await q.execute();
  const needle = ref.trim().toLowerCase();
  return rows.find((s) => s.name.toLowerCase() === needle);
}

export async function getStatusRow(db: Exec, projectId: string, ref: string) {
  const row = await findStatus(db, projectId, ref);
  if (!row) throw notFound('Status', ref);
  return row;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

/**
 * `owner/name`, or any github.com URL under the repository, reduced to owner and name. The scheme and host
 * match in any case (`HTTPS://GitHub.com/…`); owner and name keep the case they were given.
 */
export function parseRepoRef(input: string): { owner: string; name: string } {
  const trimmed = input
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '');
  const urlForm = trimmed.toLowerCase().startsWith('github.com/');
  // A host-like first segment (a dot with something on both sides, then a slash) that is not github.com.
  // String operations, not /^[^/]+\.[^/]+\//, which backtracks quadratically on long runs of dots.
  const slash = trimmed.indexOf('/');
  if (slash > 0 && trimmed.slice(1, slash - 1).includes('.') && !urlForm)
    throw validationError(`Not a GitHub repository: "${input}"`);
  const path = urlForm ? trimmed.slice('github.com/'.length).split(/[?#]/)[0]! : trimmed;
  const [owner, rawName, ...rest] = path.split('/');
  const name = rawName?.replace(/\.git$/, '');
  if (!owner || !name || !OWNER.test(owner) || !NAME.test(name) || (!urlForm && rest.length))
    throw validationError(
      `Not a GitHub repository: "${input}" (expected owner/name or a github.com URL)`,
    );
  return { owner, name };
}
