import { type Tx, withWriteTx } from '@poietic-tech/issues-db';
import { type Attachment, formatIssueKey, isIdOf } from '@poietic-tech/issues-schema';
import { nowIso, type ServiceContext } from '../context.ts';
import { conflict, DomainError, forbidden, notFound } from '../errors.ts';
import { recordEvent } from '../events.ts';
import { toUserOwner, toUserSummary } from '../mappers.ts';
import { atLeast, requireLevel } from '../access.ts';
import { getIssueAccess, getIssueRow, requireProjectAccess } from '../refs.ts';
import { type BlobStore, newBlobKey, sha256Hex } from '../storage/blob-store.ts';
import { sanitizeFilename, sniffContentType } from '../storage/content-type.ts';

export const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

async function loadAttachment(
  db: Tx,
  id: string,
): Promise<(Attachment & { storageKey: string }) | undefined> {
  if (!isIdOf('attachment', id)) return undefined;
  const r = await db
    .selectFrom('attachments as a')
    .innerJoin('users as u', 'u.id', 'a.uploader_id')
    .leftJoin('users as o', 'o.id', 'u.owner_id')
    .selectAll('a')
    .select([
      'u.handle',
      'u.name',
      'u.kind',
      'u.avatar_url',
      'u.owner_id',
      'o.handle as owner_handle',
    ])
    .where('a.id', '=', id)
    .executeTakeFirst();
  return r ? toAttachment(r) : undefined;
}

function toAttachment(r: {
  id: string;
  issue_id: string;
  comment_id: string | null;
  uploader_id: string;
  filename: string;
  content_type: string;
  size: number;
  sha256: string;
  storage_key: string;
  created_at: string;
  deleted_at: string | null;
  handle: string;
  name: string;
  kind: 'human' | 'agent' | 'system';
  avatar_url: string | null;
  owner_id: string | null;
  owner_handle: string | null;
}): Attachment & { storageKey: string } {
  return {
    id: r.id,
    issueId: r.issue_id,
    commentId: r.comment_id,
    uploader: toUserSummary(
      {
        id: r.uploader_id,
        handle: r.handle,
        name: r.name,
        kind: r.kind,
        avatarUrl: r.avatar_url,
      },
      toUserOwner(r.owner_id, r.owner_handle),
    ),
    filename: r.filename,
    contentType: r.content_type,
    size: r.size,
    sha256: r.sha256,
    url: `/api/v1/attachments/${r.id}/content`,
    createdAt: r.created_at,
    deletedAt: r.deleted_at,
    storageKey: r.storage_key,
  };
}

function publicView({ storageKey: _key, ...a }: Attachment & { storageKey: string }): Attachment {
  return a;
}

async function issueRef(db: Tx, issueId: string) {
  const r = await db
    .selectFrom('issues as i')
    .innerJoin('projects as p', 'p.id', 'i.project_id')
    .select(['i.id', 'i.number', 'i.title', 'i.project_id', 'i.deleted_at', 'p.key'])
    .where('i.id', '=', issueId)
    .executeTakeFirstOrThrow();
  return {
    ref: { id: r.id, key: formatIssueKey(r.key, r.number), title: r.title },
    projectId: r.project_id,
    issueDeleted: r.deleted_at !== null,
  };
}

export interface UploadInput {
  filename: string;
  data: Uint8Array;
  commentId?: string | undefined;
}

/**
 * Stores a file and attaches it to an issue (optionally to one of its comments). The bytes are written to the
 * blob store *before* the (short) write transaction, and removed again if the transaction fails.
 * The content type is detected from the bytes, never taken from the client.
 */
export async function uploadAttachment(
  ctx: ServiceContext,
  blobs: BlobStore,
  issueRefOrId: string,
  input: UploadInput,
  opts: { maxBytes?: number } = {},
): Promise<Attachment> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  if (input.data.byteLength === 0) throw new DomainError('VALIDATION_FAILED', 'The file is empty');
  if (input.data.byteLength > maxBytes)
    throw new DomainError(
      'PAYLOAD_TOO_LARGE',
      `Files are limited to ${Math.round(maxBytes / 1024 / 1024)} MB`,
    );
  const issue = await getIssueRow(ctx, ctx.db.kysely, issueRefOrId, 'write');
  if (issue.deleted_at) throw conflict('Cannot attach files to a deleted issue');
  const filename = sanitizeFilename(input.filename);
  const contentType = sniffContentType(input.data, filename);
  const key = newBlobKey();
  await blobs.put(key, input.data, contentType);
  try {
    return await withWriteTx(ctx.db, async (tx) => {
      if (input.commentId) {
        const comment = await tx
          .selectFrom('comments')
          .select(['id', 'issue_id'])
          .where('id', '=', input.commentId)
          .executeTakeFirst();
        if (!comment || comment.issue_id !== issue.id) throw notFound('Comment', input.commentId);
      }
      const id = ctx.ids('attachment');
      await tx
        .insertInto('attachments')
        .values({
          id,
          issue_id: issue.id,
          comment_id: input.commentId ?? null,
          uploader_id: ctx.actor.id,
          filename,
          content_type: contentType,
          size: input.data.byteLength,
          sha256: sha256Hex(input.data),
          storage_key: key,
          created_at: nowIso(ctx),
          deleted_at: null,
        })
        .execute();
      const attachment = publicView((await loadAttachment(tx, id))!);
      const { ref, projectId } = await issueRef(tx, issue.id);
      await recordEvent(tx, ctx, 'attachment.created', {
        projectId,
        issueId: issue.id,
        data: { attachment, issue: ref },
      });
      return attachment;
    });
  } catch (error) {
    await blobs.delete(key).catch(() => {});
    throw error;
  }
}

/**
 * Attachments of an issue, oldest first. Attachments of a deleted comment (like those of a trashed issue) are
 * deleted content: only actors with `write` on the project see them.
 */
export async function listAttachments(
  ctx: ServiceContext,
  issueRefOrId: string,
): Promise<Attachment[]> {
  const { row: issue, level } = await getIssueAccess(ctx, ctx.db.kysely, issueRefOrId, 'read');
  let q = ctx.db.kysely
    .selectFrom('attachments as a')
    .innerJoin('users as u', 'u.id', 'a.uploader_id')
    .leftJoin('users as o', 'o.id', 'u.owner_id')
    .leftJoin('comments as c', 'c.id', 'a.comment_id')
    .selectAll('a')
    .select([
      'u.handle',
      'u.name',
      'u.kind',
      'u.avatar_url',
      'u.owner_id',
      'o.handle as owner_handle',
    ])
    .where('a.issue_id', '=', issue.id)
    .where('a.deleted_at', 'is', null)
    .orderBy('a.created_at');
  // No comment, or a comment that isn't deleted (the left join yields null for both).
  if (!atLeast(level, 'write')) q = q.where('c.deleted_at', 'is', null);
  return (await q.execute()).map((r) => publicView(toAttachment(r)));
}

export async function getAttachment(
  ctx: ServiceContext,
  id: string,
): Promise<Attachment & { storageKey: string }> {
  const db = ctx.db.kysely;
  const attachment = await loadAttachment(db, id);
  if (!attachment || attachment.deletedAt) throw notFound('Attachment', id);
  const { projectId, issueDeleted } = await issueRef(db, attachment.issueId);
  const { level } = await requireProjectAccess(ctx, db, projectId, 'read', 'Attachment', id);
  if (
    !atLeast(level, 'write') &&
    (issueDeleted || (await commentDeleted(db, attachment.commentId)))
  )
    throw notFound('Attachment', id);
  return attachment;
}

async function commentDeleted(db: Tx, commentId: string | null): Promise<boolean> {
  if (!commentId) return false;
  const row = await db
    .selectFrom('comments')
    .select('deleted_at')
    .where('id', '=', commentId)
    .executeTakeFirst();
  return row?.deleted_at != null;
}

/** Deletes an attachment (uploader or admin). The row is kept for history; the bytes are removed. */
export async function deleteAttachment(
  ctx: ServiceContext,
  blobs: BlobStore,
  id: string,
): Promise<Attachment> {
  const deleted = await withWriteTx(ctx.db, async (tx) => {
    const attachment = await loadAttachment(tx, id);
    if (!attachment || attachment.deletedAt) throw notFound('Attachment', id);
    const { ref, projectId, issueDeleted } = await issueRef(tx, attachment.issueId);
    const { level } = await requireProjectAccess(ctx, tx, projectId, 'read', 'Attachment', id);
    // Below write, an attachment of a trashed issue or a deleted comment does not exist (as in getAttachment),
    // so trying to delete it is NOT_FOUND rather than FORBIDDEN or UNAUTHENTICATED.
    if (
      !atLeast(level, 'write') &&
      (issueDeleted || (await commentDeleted(tx, attachment.commentId)))
    )
      throw notFound('Attachment', id);
    requireLevel(ctx, level, 'write', 'Attachment', id);
    if (attachment.uploader.id !== ctx.actor.id && !atLeast(level, 'manage'))
      throw forbidden('You can only delete your own attachments');
    const now = nowIso(ctx);
    await tx.updateTable('attachments').set({ deleted_at: now }).where('id', '=', id).execute();
    const view = { ...publicView(attachment), deletedAt: now };
    await recordEvent(tx, ctx, 'attachment.deleted', {
      projectId,
      issueId: attachment.issueId,
      data: { attachment: view, issue: ref },
    });
    return { view, key: attachment.storageKey };
  });
  await blobs.delete(deleted.key).catch(() => {}); // best effort; orphaned bytes are harmless
  return deleted.view;
}
