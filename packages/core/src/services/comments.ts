import { type Tx, withWriteTx } from '@poietic-tech/issues-db';
import {
  type Comment,
  type CreateCommentInput,
  CreateCommentInputSchema,
  formatIssueKey,
  isIdOf,
  type UpdateCommentInput,
  UpdateCommentInputSchema,
} from '@poietic-tech/issues-schema';
import { nowIso, type ServiceContext } from '../context.ts';
import { conflict, forbidden, notFound, parseInput } from '../errors.ts';
import { recordEvent } from '../events.ts';
import { toComment, toUserOwner, toUserSummary } from '../mappers.ts';
import { atLeast, requireLevel } from '../access.ts';
import { getIssueAccess, getIssueRow, requireProjectAccess } from '../refs.ts';

async function loadComment(db: Tx, id: string): Promise<Comment | undefined> {
  const row = await db
    .selectFrom('comments as c')
    .innerJoin('users as u', 'u.id', 'c.author_id')
    .leftJoin('users as o', 'o.id', 'u.owner_id')
    .selectAll('c')
    .select([
      'u.handle',
      'u.name',
      'u.kind',
      'u.avatar_url',
      'u.owner_id',
      'o.handle as owner_handle',
    ])
    .where('c.id', '=', id)
    .executeTakeFirst();
  return row
    ? toComment(
        row,
        toUserSummary(
          {
            id: row.author_id,
            handle: row.handle,
            name: row.name,
            kind: row.kind,
            avatarUrl: row.avatar_url,
          },
          toUserOwner(row.owner_id, row.owner_handle),
        ),
      )
    : undefined;
}

async function issueRefFor(db: Tx, issueId: string) {
  const row = await db
    .selectFrom('issues as i')
    .innerJoin('projects as p', 'p.id', 'i.project_id')
    .select(['i.id', 'i.number', 'i.title', 'i.project_id', 'i.deleted_at', 'p.key'])
    .where('i.id', '=', issueId)
    .executeTakeFirstOrThrow();
  return {
    ref: { id: row.id, key: formatIssueKey(row.key, row.number), title: row.title },
    projectId: row.project_id,
    issueDeleted: row.deleted_at !== null,
  };
}

/**
 * Comments on an issue, oldest first. Deleted comments are excluded unless requested, and only actors with
 * `write` on the project get them: for anyone else `includeDeleted` is ignored.
 */
export async function listComments(
  ctx: ServiceContext,
  issueRef: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<Comment[]> {
  const { row: issue, level } = await getIssueAccess(ctx, ctx.db.kysely, issueRef, 'read');
  let q = ctx.db.kysely
    .selectFrom('comments as c')
    .innerJoin('users as u', 'u.id', 'c.author_id')
    .leftJoin('users as o', 'o.id', 'u.owner_id')
    .selectAll('c')
    .select([
      'u.handle',
      'u.name',
      'u.kind',
      'u.avatar_url',
      'u.owner_id',
      'o.handle as owner_handle',
    ])
    .where('c.issue_id', '=', issue.id)
    .orderBy('c.created_at')
    .orderBy('c.id');
  if (!(opts.includeDeleted && atLeast(level, 'write'))) q = q.where('c.deleted_at', 'is', null);
  const rows = await q.execute();
  return rows.map((row) =>
    toComment(
      row,
      toUserSummary(
        {
          id: row.author_id,
          handle: row.handle,
          name: row.name,
          kind: row.kind,
          avatarUrl: row.avatar_url,
        },
        toUserOwner(row.owner_id, row.owner_handle),
      ),
    ),
  );
}

export async function createComment(
  ctx: ServiceContext,
  issueRef: string,
  input: CreateCommentInput,
): Promise<Comment> {
  const data = parseInput(CreateCommentInputSchema, input);
  return withWriteTx(ctx.db, async (tx) => {
    const issue = await getIssueRow(ctx, tx, issueRef, 'write');
    if (issue.deleted_at) throw conflict('Cannot comment on a deleted issue');
    const now = nowIso(ctx);
    const id = ctx.ids('comment');
    await tx
      .insertInto('comments')
      .values({
        id,
        issue_id: issue.id,
        author_id: ctx.actor.id,
        parent_comment_id: null,
        body: data.body,
        created_at: now,
        updated_at: now,
        edited_at: null,
        deleted_at: null,
      })
      .execute();
    const comment = (await loadComment(tx, id))!;
    const { ref } = await issueRefFor(tx, issue.id);
    await recordEvent(tx, ctx, 'comment.created', {
      projectId: issue.project_id,
      issueId: issue.id,
      data: { comment, issue: ref },
    });
    return comment;
  });
}

async function editableComment(tx: Tx, ctx: ServiceContext, id: string) {
  const comment = isIdOf('comment', id) ? await loadComment(tx, id) : undefined;
  if (!comment || comment.deletedAt) throw notFound('Comment', id);
  const { projectId, issueDeleted } = await issueRefFor(tx, comment.issueId);
  const { level } = await requireProjectAccess(ctx, tx, projectId, 'read', 'Comment', id);
  // Below write, a trashed issue's comments do not exist (ADR 0021), so a viewer or anonymous caller trying to
  // change one gets NOT_FOUND rather than FORBIDDEN or UNAUTHENTICATED.
  if (issueDeleted && !atLeast(level, 'write')) throw notFound('Comment', id);
  requireLevel(ctx, level, 'write', 'Comment', id);
  if (comment.authorId !== ctx.actor.id && !atLeast(level, 'manage'))
    throw forbidden('You can only change your own comments');
  return comment;
}

export async function updateComment(
  ctx: ServiceContext,
  id: string,
  input: UpdateCommentInput,
): Promise<Comment> {
  const data = parseInput(UpdateCommentInputSchema, input);
  return withWriteTx(ctx.db, async (tx) => {
    const existing = await editableComment(tx, ctx, id);
    if (existing.body === data.body) return existing;
    const now = nowIso(ctx);
    await tx
      .updateTable('comments')
      .set({ body: data.body, updated_at: now, edited_at: now })
      .where('id', '=', id)
      .execute();
    const comment = (await loadComment(tx, id))!;
    const { ref, projectId } = await issueRefFor(tx, comment.issueId);
    await recordEvent(tx, ctx, 'comment.updated', {
      projectId,
      issueId: comment.issueId,
      data: { comment, issue: ref },
    });
    return comment;
  });
}

export async function deleteComment(ctx: ServiceContext, id: string): Promise<Comment> {
  return withWriteTx(ctx.db, async (tx) => {
    await editableComment(tx, ctx, id);
    const now = nowIso(ctx);
    await tx
      .updateTable('comments')
      .set({ deleted_at: now, updated_at: now })
      .where('id', '=', id)
      .execute();
    const comment = (await loadComment(tx, id))!;
    const { ref, projectId } = await issueRefFor(tx, comment.issueId);
    await recordEvent(tx, ctx, 'comment.deleted', {
      projectId,
      issueId: comment.issueId,
      data: { comment, issue: ref },
    });
    return comment;
  });
}
