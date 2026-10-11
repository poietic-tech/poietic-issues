import { fromJson, sql, type Tx } from '@poietic-tech/issues-db';
import type { EventType, Page, TrackerEvent } from '@poietic-tech/issues-schema';
import { readableProjectIds, writableProjectIds } from '../access.ts';
import { isAnonymous, type ServiceContext } from '../context.ts';
import { validationError } from '../errors.ts';
import { isAdmin } from '../permissions.ts';
import { toUserOwner } from '../mappers.ts';

export interface ListEventsInput {
  /** Only events with `seq` greater than this (exclusive cursor). */
  after?: number | undefined;
  limit?: number | undefined;
  project?: string | undefined;
  issue?: string | undefined;
  types?: EventType[] | undefined;
  /** With `issue`: also include link events where the issue is the target. */
  includeLinksTo?: boolean | undefined;
}

function eventQuery(db: Tx) {
  return db
    .selectFrom('events as e')
    .leftJoin('users as u', 'u.id', 'e.actor_id')
    .leftJoin('users as o', 'o.id', 'u.owner_id')
    .selectAll('e')
    .select([
      'u.handle as u_handle',
      'u.name as u_name',
      'u.kind as u_kind',
      'u.avatar_url as u_avatar',
      'u.owner_id as u_owner_id',
      'o.handle as u_owner_handle',
    ]);
}

type EventRow = Awaited<ReturnType<ReturnType<typeof eventQuery>['execute']>>[number];

function toTrackerEvent(r: EventRow): TrackerEvent {
  return {
    seq: Number(r.seq),
    id: r.id,
    type: r.type as EventType,
    actorId: r.actor_id,
    actor:
      r.actor_id && r.u_handle
        ? {
            id: r.actor_id,
            handle: r.u_handle,
            name: r.u_name!,
            kind: r.u_kind!,
            avatarUrl: r.u_avatar,
            owner: toUserOwner(r.u_owner_id, r.u_owner_handle),
          }
        : null,
    projectId: r.project_id,
    issueId: r.issue_id,
    data: fromJson<Record<string, unknown>>(r.data, {}),
    createdAt: r.created_at,
  };
}

/**
 * Hides other users' emails in `user.*` events from non-admins, matching `listUsers`. Events are shared by
 * everyone who can see them, so the log must not reveal what the user list withholds.
 */
export function redactEventForViewer(
  ctx: Pick<ServiceContext, 'actor'>,
  event: TrackerEvent,
): TrackerEvent {
  if (!event.type.startsWith('user.') || isAdmin(ctx)) return event;
  const user = event.data.user as { id?: string } | undefined;
  if (!user || user.id === ctx.actor.id) return event;
  const { email: _hidden, ...changes } = (event.data.changes ?? {}) as Record<string, unknown>;
  return {
    ...event,
    data: {
      ...event.data,
      user: { ...user, email: null },
      ...(event.data.changes !== undefined && { changes }),
    },
  };
}

/**
 * Redacts events for the viewer (`redactEventForViewer`) and drops a `user.updated` whose only change was the
 * email they cannot see: it would reach them as `changes: {}`.
 */
function forViewer(ctx: Pick<ServiceContext, 'actor'>, events: TrackerEvent[]): TrackerEvent[] {
  return events.flatMap((e) => {
    const r = redactEventForViewer(ctx, e);
    const emptied =
      r.type === 'user.updated' &&
      Object.keys((r.data.changes ?? {}) as object).length === 0 &&
      Object.keys((e.data.changes ?? {}) as object).length > 0;
    return emptied ? [] : [r];
  });
}

/** Ids of the two issues a `link.*` event connects. */
function linkEnds(event: TrackerEvent): string[] {
  const link = event.data.link as
    { source?: { id?: string }; target?: { id?: string } } | undefined;
  return [link?.source?.id, link?.target?.id].filter((id): id is string => typeof id === 'string');
}

/** Project ids from `readableProjectIds` / `writableProjectIds`: `'all'` or a list. */
export type ProjectIdSet = 'all' | string[];
type Access = ProjectIdSet;
type IssueRef = { id?: string } | null | undefined;

/** Ids an event's content depends on, looked up in one batch per table by `applyContentRules`. */
function contentRefs(e: TrackerEvent, restricted: boolean) {
  const issues: string[] = [];
  const comments: string[] = [];
  const attachments: string[] = [];
  if (e.type.startsWith('link.')) issues.push(...linkEnds(e));
  if (restricted) {
    if (e.issueId) issues.push(e.issueId);
    if (e.type.startsWith('issue.')) {
      const parent = (e.data.issue as { parentId?: string | null } | undefined)?.parentId;
      if (parent) issues.push(parent);
      const change = (e.data.changes as { parent?: { from: IssueRef; to: IssueRef } } | undefined)
        ?.parent;
      for (const ref of [change?.from, change?.to]) if (ref?.id) issues.push(ref.id);
    }
    const comment = (e.data.comment as IssueRef)?.id;
    if (e.type.startsWith('comment.') && comment) comments.push(comment);
    const attachment = (e.data.attachment as IssueRef)?.id;
    if (e.type.startsWith('attachment.') && attachment) attachments.push(attachment);
  }
  return { issues, comments, attachments };
}

function withoutKey<T extends Record<string, unknown>>(record: T, key: string): T {
  const { [key]: _dropped, ...rest } = record;
  return rest as T;
}

/**
 * A content-free `issue.deleted` or `attachment.deleted`: the issue's id and key, and the attachment's id, which is
 * all a client needs to drop the row from an open view. Dropped when the ids are missing.
 */
function tombstone(e: TrackerEvent): TrackerEvent[] {
  const issue = e.data.issue as { id?: string; key?: string } | undefined;
  const attachment = (e.data.attachment as IssueRef)?.id;
  if (!issue?.id || !issue.key || (e.type === 'attachment.deleted' && !attachment)) return [];
  return [
    {
      ...e,
      data: {
        issue: { id: issue.id, key: issue.key },
        ...(e.type === 'attachment.deleted' && { attachment: { id: attachment } }),
      },
    },
  ];
}

/**
 * The per-viewer rules that depend on the current state of issues, comments and attachments, applied to a batch
 * of already project-filtered events with one lookup per table (shared by `listEvents` and the live stream, so
 * replay and live agree):
 *
 * - Link events name both issues, so they need both ends readable; a link event whose two ends cannot both be
 *   resolved is hidden (fails closed on malformed data or permanently deleted ends).
 * - Deleted content needs `write` on its project (ADR 0021 follow-up). Below that: events of a trashed (or
 *   permanently deleted) issue are dropped, and so are link events with a trashed end; comment events of a
 *   deleted comment keep their place in the activity but lose the body; attachment events of a deleted attachment,
 *   or of one on a deleted comment, are dropped (their filename, size and hash identify the file, and there is
 *   nothing left to show); a trashed parent is cut from issue snapshots, and a `changes.parent` that names a
 *   trashed issue is left out of `changes` (one from a trashed parent to a live one becomes `{ from: null, to }`).
 * - With `tombstones` (the live stream), the dropped `issue.deleted` and `attachment.deleted` events arrive instead
 *   as tombstones that carry only ids and the issue key, so readers' open views can drop the row. An
 *   `attachment.deleted` of a trashed issue is still dropped: that issue's own tombstone covers it.
 */
async function applyContentRules(
  db: Tx,
  events: TrackerEvent[],
  readable: Access,
  writable: Access,
  tombstones = false,
): Promise<TrackerEvent[]> {
  if (readable === 'all' && writable === 'all') return events;
  const canRead = (projectId: string) => readable === 'all' || readable.includes(projectId);
  const canWrite = (projectId: string | null) =>
    writable === 'all' || (projectId !== null && writable.includes(projectId));
  const refs = events.map((e) => contentRefs(e, !canWrite(e.projectId)));
  const unique = (pick: (r: (typeof refs)[number]) => string[]) => [...new Set(refs.flatMap(pick))];
  const issueIds = unique((r) => r.issues);
  const commentIds = unique((r) => r.comments);
  const attachmentIds = unique((r) => r.attachments);
  const issues = new Map(
    (issueIds.length
      ? await db
          .selectFrom('issues')
          .select(['id', 'project_id', 'deleted_at'])
          .where('id', 'in', issueIds)
          .execute()
      : []
    ).map((r) => [r.id, r]),
  );
  const comments = new Map(
    (commentIds.length
      ? await db
          .selectFrom('comments')
          .select(['id', 'deleted_at'])
          .where('id', 'in', commentIds)
          .execute()
      : []
    ).map((r) => [r.id, r.deleted_at]),
  );
  const liveAttachments = new Set(
    (attachmentIds.length
      ? await db
          .selectFrom('attachments as a')
          .leftJoin('comments as c', 'c.id', 'a.comment_id')
          .select('a.id')
          .where('a.id', 'in', attachmentIds)
          .where('a.deleted_at', 'is', null)
          .where('c.deleted_at', 'is', null)
          .execute()
      : []
    ).map((r) => r.id),
  );
  /** A live issue, or a trashed one the viewer can write in. Missing (permanently deleted) is never visible. */
  const visibleIssue = (id: string) => {
    const row = issues.get(id);
    return row !== undefined && (row.deleted_at === null || canWrite(row.project_id));
  };
  const hiddenParent = (ref: IssueRef) => (ref?.id && !visibleIssue(ref.id) ? null : ref);

  return events.flatMap((e): TrackerEvent[] => {
    if (e.type.startsWith('link.')) {
      const ends = linkEnds(e);
      const ok = (id: string) => {
        const row = issues.get(id);
        return row !== undefined && canRead(row.project_id) && visibleIssue(id);
      };
      if (ends.length !== 2 || !ends.every(ok)) return [];
    }
    if (canWrite(e.projectId)) return [e];
    if (e.issueId && !visibleIssue(e.issueId))
      return tombstones && e.type === 'issue.deleted' ? tombstone(e) : [];
    if (e.type.startsWith('attachment.')) {
      const id = (e.data.attachment as IssueRef)?.id;
      if (id && liveAttachments.has(id)) return [e];
      return tombstones && e.type === 'attachment.deleted' ? tombstone(e) : [];
    }
    if (e.type.startsWith('comment.')) {
      const comment = e.data.comment as { id?: string; deletedAt?: string | null } | undefined;
      if (!comment?.id) return [e];
      const deletedAt = comments.get(comment.id);
      if (deletedAt === null) return [e]; // the comment is live
      return [
        {
          ...e,
          data: {
            ...e.data,
            comment: { ...comment, body: '', deletedAt: deletedAt ?? comment.deletedAt ?? null },
          },
        },
      ];
    }
    if (e.type.startsWith('issue.')) {
      const issue = e.data.issue as { parentId?: string | null; parent?: IssueRef } | undefined;
      const changes = e.data.changes as Record<string, { from: unknown; to: unknown }> | undefined;
      const cutParent = !!issue?.parentId && !visibleIssue(issue.parentId);
      const change = changes?.parent as { from: IssueRef; to: IssueRef } | undefined;
      const cutFrom = !!change && hiddenParent(change.from) !== change.from;
      const cutTo = !!change && hiddenParent(change.to) !== change.to;
      if (!cutParent && !cutFrom && !cutTo) return [e];
      // A parent change whose new parent is trashed is left out: with that end cut it would read as a change
      // that never happened (e.g. "removed the parent"), and so is one from a trashed parent to none. A move from
      // a trashed parent to a live one keeps the live end as `{ from: null, to }`. The other changes stay.
      const parentChange =
        cutTo || (cutFrom && !change!.to)
          ? withoutKey(changes!, 'parent')
          : cutFrom
            ? { ...changes!, parent: { from: null, to: change!.to } }
            : changes;
      return [
        {
          ...e,
          data: {
            ...e.data,
            ...(cutParent && { issue: { ...issue, parentId: null, parent: null } }),
            ...((cutFrom || cutTo) && { changes: parentChange }),
          },
        },
      ];
    }
    return [e];
  });
}

/**
 * Shares `applyContentRules` between viewers with the same readable and writable projects. The live stream hands
 * every event to every connection, so many viewers with the same access (anonymous visitors of a public project,
 * say) filter the same run of events at the same moment; with a memo they share one set of lookups instead of each
 * running their own.
 *
 * Only lookups still in flight are shared: an entry is dropped as soon as it settles, so a viewer who gets to a
 * run later reads the current state again, exactly as it would without the memo.
 */
export class ContentRulesMemo {
  readonly #inFlight = new Map<string, Promise<TrackerEvent[]>>();

  /** `applyContentRules` for project events (they do not depend on the viewer beyond their access). */
  apply(
    db: Tx,
    events: TrackerEvent[],
    readable: Access,
    writable: Access,
    tombstones: boolean,
  ): Promise<TrackerEvent[]> {
    const ids = (access: Access) => (access === 'all' ? 'all' : [...access].sort().join(','));
    const key = [tombstones, ids(readable), ids(writable), events.map((e) => e.seq).join(',')].join(
      '|',
    );
    const shared = this.#inFlight.get(key);
    if (shared) return shared;
    const run = applyContentRules(db, events, readable, writable, tombstones);
    this.#inFlight.set(key, run);
    const settle = () => this.#inFlight.delete(key);
    run.then(settle, settle);
    return run;
  }

  /** Lookups in flight (for tests). */
  get size(): number {
    return this.#inFlight.size;
  }
}

export interface EventFilterOptions {
  /** `readableProjectIds` of the viewer, to reuse a result already read; read here when left out. */
  readable?: ProjectIdSet | undefined;
  /** `writableProjectIds` of the viewer, likewise. */
  writable?: ProjectIdSet | undefined;
  /**
   * Readers below write receive `issue.deleted` and `attachment.deleted` as tombstones (see `applyContentRules`)
   * instead of not at all. The live stream sets this; `GET /events` and issue activity do not.
   */
  tombstones?: boolean | undefined;
  /** Shares the content lookups with other viewers of the same access (`ContentRulesMemo`). */
  memo?: ContentRulesMemo | undefined;
}

/**
 * Applies `listEvents`' per-viewer rules to events read some other way (the live stream reads every event as
 * the system actor and fans it out): only readable projects, project-less (`user.*`) events only for signed-in
 * viewers, link events only when both issues are readable, user events redacted, and deleted content only for
 * writers (`applyContentRules`).
 */
export async function filterEventsForViewer(
  ctx: ServiceContext,
  events: TrackerEvent[],
  options: EventFilterOptions = {},
): Promise<TrackerEvent[]> {
  const access = options.readable ?? (await readableProjectIds(ctx, ctx.db.kysely));
  const redacted = forViewer(ctx, events);
  if (access === 'all') return redacted;
  const signedIn = !isAnonymous(ctx);
  const visible = redacted.filter((e) =>
    e.projectId === null ? signedIn : access.includes(e.projectId),
  );
  const canWrite = options.writable ?? (await writableProjectIds(ctx, ctx.db.kysely));
  const tombstones = options.tombstones ?? false;
  if (!options.memo) return applyContentRules(ctx.db.kysely, visible, access, canWrite, tombstones);
  // The content rules pass project-less (`user.*`) events through, and those are the only ones redacted per viewer,
  // so the project events alone go through the shared memo and the viewer's own `user.*` events are merged back.
  const ruled = await options.memo.apply(
    ctx.db.kysely,
    visible.filter((e) => e.projectId !== null),
    access,
    canWrite,
    tombstones,
  );
  const bySeq = new Map(ruled.map((e) => [e.seq, e]));
  return visible.flatMap((e) => {
    if (e.projectId === null) return [e];
    const kept = bySeq.get(e.seq);
    return kept ? [kept] : [];
  });
}

/** Loads events by seq (in seq order); missing seqs are skipped. */
export async function getEventsBySeq(db: Tx, seqs: number[]): Promise<TrackerEvent[]> {
  if (seqs.length === 0) return [];
  const rows = await eventQuery(db).where('e.seq', 'in', seqs).orderBy('e.seq').execute();
  return rows.map(toTrackerEvent);
}

/**
 * Reads the event log in commit order. `seq` increases in commit order (ADR 0003), so polling
 * `after=<last seq seen>` never misses an event. `nextCursor` is the last seq as a string. The live stream's
 * replay passes `tombstones`, so it matches what the stream delivers live.
 */
export async function listEvents(
  ctx: ServiceContext,
  input: ListEventsInput = {},
  options: Pick<EventFilterOptions, 'tombstones'> = {},
): Promise<Page<TrackerEvent>> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
  if (input.after !== undefined && (!Number.isInteger(input.after) || input.after < 0))
    throw validationError('after must be a non-negative integer');
  let q = eventQuery(ctx.db.kysely)
    .orderBy('e.seq')
    .limit(limit + 1);
  if (input.after !== undefined) q = q.where('e.seq', '>', input.after);
  const readable = await readableProjectIds(ctx, ctx.db.kysely);
  if (readable !== 'all') {
    const signedIn = !isAnonymous(ctx);
    q = q.where((eb) => {
      const visible = [];
      if (readable.length) visible.push(eb('e.project_id', 'in', readable));
      if (signedIn) visible.push(eb('e.project_id', 'is', null)); // user.* events
      return visible.length ? eb.or(visible) : sql<boolean>`1 = 0`;
    });
  }
  if (input.project) q = q.where('e.project_id', '=', input.project);
  if (input.types?.length) q = q.where('e.type', 'in', input.types);
  if (input.issue) {
    const issueId = input.issue;
    q = input.includeLinksTo
      ? q.where((eb) =>
          eb.or([
            eb('e.issue_id', '=', issueId),
            eb.and([
              eb('e.type', 'in', ['link.created', 'link.deleted']),
              eb(sql`cast(e.data as text)`, 'like', `%"${issueId}"%`),
            ]),
          ]),
        )
      : q.where('e.issue_id', '=', issueId);
  }
  const rows = await q.execute();
  const page = rows.slice(0, limit);
  const events = forViewer(ctx, page.map(toTrackerEvent));
  return {
    data:
      readable === 'all'
        ? events
        : await applyContentRules(
            ctx.db.kysely,
            events,
            readable,
            await writableProjectIds(ctx, ctx.db.kysely),
            options.tombstones ?? false,
          ),
    nextCursor: rows.length > limit ? String(page.at(-1)!.seq) : null,
  };
}

/** Highest committed event seq (0 when the log is empty). */
export async function latestEventSeq(ctx: Pick<ServiceContext, 'db'>): Promise<number> {
  const row = await ctx.db.kysely
    .selectFrom('events')
    .select((eb) => eb.fn.max('seq').as('seq'))
    .executeTakeFirst();
  return Number(row?.seq ?? 0);
}
