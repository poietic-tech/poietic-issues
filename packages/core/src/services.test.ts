import { createTestDb, testDialect } from '@poietic-tech/issues-db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bulkUpdateIssues,
  createComment,
  createIssue,
  createLabel,
  createLink,
  createProject,
  createStatus,
  bootstrapAdmin,
  deleteComment,
  deleteIssue,
  deleteLink,
  deleteStatus,
  getIssue,
  getProject,
  listComments,
  listEvents,
  listIssueActivity,
  listIssueLinks,
  listIssues,
  listStatuses,
  listViews,
  moveIssue,
  restoreIssue,
  updateComment,
  updateIssue,
  updateLabel,
  updateView,
} from './index.ts';
import { createTestContext, grant, type TestContext } from './testing.ts';

let t: TestContext;

beforeAll(async () => {
  t = await createTestContext();
  await createProject(t.ctx, { key: 'eng', name: 'Engineering' });
  await grant(t, 'ENG', t.member, 'editor');
  await grant(t, 'ENG', t.agent, 'editor');
  await createLabel(t.ctx, 'ENG', { name: 'bug', color: '#ff0000' });
  await createLabel(t.ctx, 'ENG', { name: 'feature' });
});
afterAll(() => t.destroy());

describe(`projects (${testDialect()})`, () => {
  it('creates default statuses and shared views', async () => {
    const statuses = await listStatuses(t.ctx, 'ENG');
    expect(statuses.map((s) => s.name)).toEqual([
      'Backlog',
      'Todo',
      'In Progress',
      'In Review',
      'Done',
      'Canceled',
    ]);
    const views = await listViews(t.member, 'ENG');
    expect(views.map((v) => [v.name, v.layout, v.ownerId])).toEqual([
      ['All issues', 'list', null],
      ['Board', 'board', null],
    ]);
    expect(views[1]!.config.board.cardFields).toEqual(['key', 'priority', 'assignee', 'labels']);
  });

  it('rejects duplicate keys and non-admin creators', async () => {
    await expect(createProject(t.ctx, { key: 'ENG', name: 'Again' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(createProject(t.member, { key: 'OPS', name: 'Ops' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(createProject(t.ctx, { key: '1X', name: 'Bad' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('persists the visibility it is created with, and defaults to private', async () => {
    const stored = async (key: string) =>
      (
        await t.db.kysely
          .selectFrom('projects')
          .select('visibility')
          .where('key', '=', key)
          .executeTakeFirstOrThrow()
      ).visibility;
    const open = await createProject(t.ctx, { key: 'VPUB', name: 'Open', visibility: 'public' });
    const closed = await createProject(t.ctx, {
      key: 'VPRV',
      name: 'Closed',
      visibility: 'private',
    });
    const unspecified = await createProject(t.ctx, { key: 'VDEF', name: 'Default' });
    expect([open, closed, unspecified].map((p) => p.visibility)).toEqual([
      'public',
      'private',
      'private',
    ]);
    expect([await stored('VPUB'), await stored('VPRV'), await stored('VDEF')]).toEqual([
      'public',
      'private',
      'private',
    ]);
    expect((await getProject(t.ctx, 'VPUB')).visibility).toBe('public');
    const created = (await listEvents(t.ctx, { types: ['project.created'], limit: 1000 })).data;
    const payload = created.find((e) => e.projectId === open.id)!.data as {
      project: { visibility: string };
    };
    expect(payload.project.visibility).toBe('public');
  });
});

describe(`issues (${testDialect()})`, () => {
  it('creates issues with sequential keys, defaults and resolved refs', async () => {
    const a = await createIssue(t.member, 'ENG', { title: 'First' });
    const b = await createIssue(t.agent, 'eng', {
      title: 'Second',
      status: 'in progress',
      assignee: '@member',
      labels: ['BUG', 'feature'],
      priority: 1,
      estimate: 2,
      dueDate: '2026-12-01',
      metadata: { 'agent.session': 'abc' },
    });
    expect(a.key).toBe('ENG-1');
    expect(a.status.name).toBe('Todo');
    expect(a.creator.handle).toBe('member');
    expect(a.version).toBe(1);
    expect(b.key).toBe('ENG-2');
    expect(b.status.category).toBe('started');
    expect(b.startedAt).not.toBeNull();
    expect(b.assignee?.handle).toBe('member');
    expect(b.labels.map((l) => l.name)).toEqual(['bug', 'feature']);
    expect(b.metadata).toEqual({ 'agent.session': 'abc' });
    expect(b.creator.kind).toBe('agent');
    expect((await getIssue(t.ctx, 'eng-2')).id).toBe(b.id);
    expect((await getIssue(t.ctx, b.id)).key).toBe('ENG-2');
  });

  it('gives helpful validation errors', async () => {
    await expect(createIssue(t.ctx, 'ENG', { title: '' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(createIssue(t.ctx, 'ENG', { title: 'x', labels: ['nope'] })).rejects.toThrow(
      /Unknown label/,
    );
    await expect(createIssue(t.ctx, 'ENG', { title: 'x', status: 'Nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(createIssue(t.ctx, 'NOPE', { title: 'x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(getIssue(t.ctx, 'ENG-999')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('updates with a diff, bumps version, and records the change', async () => {
    const issue = await createIssue(t.ctx, 'ENG', { title: 'Update me', priority: 3 });
    const updated = await updateIssue(t.agent, issue.key, {
      title: 'Updated',
      priority: 1,
      assignee: 'me',
      addLabels: ['bug'],
      status: 'Done',
      expectedVersion: 1,
    });
    expect(updated.version).toBe(2);
    expect(updated.assignee?.handle).toBe('bot');
    expect(updated.completedAt).not.toBeNull();
    const events = await listIssueActivity(t.ctx, issue.key);
    const last = events.data.at(-1)!;
    expect(last.type).toBe('issue.updated');
    expect(last.actor?.handle).toBe('bot');
    const changes = last.data.changes as Record<string, { from: unknown; to: unknown }>;
    expect(Object.keys(changes).sort()).toEqual([
      'assignee',
      'labels',
      'priority',
      'status',
      'title',
    ]);
    expect(changes.priority).toEqual({ from: 3, to: 1 });

    // No-op update: no version bump, no event.
    const same = await updateIssue(t.ctx, issue.key, { title: 'Updated', labels: ['bug'] });
    expect(same.version).toBe(2);
    expect((await listIssueActivity(t.ctx, issue.key)).data).toHaveLength(events.data.length);

    // Reopening clears completedAt.
    expect((await updateIssue(t.ctx, issue.key, { status: 'Todo' })).completedAt).toBeNull();

    await expect(
      updateIssue(t.ctx, issue.key, { title: 'x', expectedVersion: 1 }),
    ).rejects.toMatchObject({
      code: 'VERSION_MISMATCH',
    });
  });

  it('validates parents: same project, no self, no cycles', async () => {
    const parent = await createIssue(t.ctx, 'ENG', { title: 'Parent' });
    const child = await createIssue(t.ctx, 'ENG', { title: 'Child', parent: parent.key });
    const grandchild = await createIssue(t.ctx, 'ENG', { title: 'Grandchild', parent: child.id });
    expect(child.parent).toEqual({ id: parent.id, key: parent.key, title: 'Parent' });
    expect((await getIssue(t.ctx, parent.key)).childCount).toBe(1);
    await expect(updateIssue(t.ctx, parent.key, { parent: grandchild.key })).rejects.toMatchObject({
      code: 'INVALID_RELATION',
    });
    await expect(updateIssue(t.ctx, parent.key, { parent: parent.key })).rejects.toMatchObject({
      code: 'INVALID_RELATION',
    });
    await createProject(t.ctx, { key: 'OPS', name: 'Ops' });
    const other = await createIssue(t.ctx, 'OPS', { title: 'Elsewhere' });
    await expect(updateIssue(t.ctx, other.key, { parent: parent.key })).rejects.toMatchObject({
      code: 'INVALID_RELATION',
    });
  });

  it('soft deletes and restores; permanent delete is admin-only', async () => {
    const issue = await createIssue(t.member, 'ENG', { title: 'Trash me' });
    const deleted = await deleteIssue(t.member, issue.key);
    expect(deleted.deletedAt).not.toBeNull();
    const visible = await listIssues(t.ctx, { project: 'ENG', limit: 200 });
    expect(visible.data.map((i) => i.id)).not.toContain(issue.id);
    await expect(updateIssue(t.ctx, issue.key, { title: 'x' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect((await restoreIssue(t.member, issue.key)).deletedAt).toBeNull();
    await expect(deleteIssue(t.member, issue.key, { permanent: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await deleteIssue(t.ctx, issue.key, { permanent: true });
    await expect(getIssue(t.ctx, issue.key)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('orders the board with server-computed ranks', async () => {
    await createProject(t.ctx, { key: 'BRD', name: 'Board' });
    const column = async () =>
      (
        await listIssues(t.ctx, {
          project: 'BRD',
          filter: { conditions: [{ field: 'status', op: 'eq', value: 'Todo' }] },
          sort: [{ field: 'rank', dir: 'asc' }],
        })
      ).data.map((i) => i.title);
    const a = await createIssue(t.ctx, 'BRD', { title: 'A' });
    const b = await createIssue(t.ctx, 'BRD', { title: 'B' });
    const c = await createIssue(t.ctx, 'BRD', { title: 'C' });
    expect(await column()).toEqual(['C', 'B', 'A']); // new issues go on top
    await moveIssue(t.ctx, c.key, { afterId: a.key });
    expect(await column()).toEqual(['B', 'A', 'C']);
    await moveIssue(t.ctx, a.key, { beforeId: b.id });
    expect(await column()).toEqual(['A', 'B', 'C']);
    await moveIssue(t.ctx, b.key, { position: 'bottom' });
    expect(await column()).toEqual(['A', 'C', 'B']);
    const moved = await moveIssue(t.ctx, c.key, { status: 'Done' });
    expect(moved.status.name).toBe('Done');
    expect(moved.completedAt).not.toBeNull();
    expect(await column()).toEqual(['A', 'B']);
    await expect(moveIssue(t.ctx, a.key, { afterId: c.key })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('bulk updates atomically', async () => {
    const x = await createIssue(t.ctx, 'ENG', { title: 'Bulk X' });
    const y = await createIssue(t.ctx, 'ENG', { title: 'Bulk Y' });
    const updated = await bulkUpdateIssues(t.ctx, [x.key, y.key], {
      priority: 2,
      addLabels: ['feature'],
    });
    expect(updated.map((i) => [i.priority, i.labels.map((l) => l.name)])).toEqual([
      [2, ['feature']],
      [2, ['feature']],
    ]);
    await expect(
      bulkUpdateIssues(t.ctx, [x.key, 'ENG-9999'], { priority: 4 }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await getIssue(t.ctx, x.key)).priority).toBe(2); // rolled back
  });
});

describe(`listing, filtering, pagination (${testDialect()})`, () => {
  it('filters with human-friendly refs', async () => {
    await createProject(t.ctx, { key: 'FLT', name: 'Filters' });
    await grant(t, 'FLT', t.member, 'editor');
    await createLabel(t.ctx, 'FLT', { name: 'bug' });
    await createIssue(t.ctx, 'FLT', {
      title: 'Crash on 100% load',
      labels: ['bug'],
      priority: 1,
      assignee: 'member',
    });
    await createIssue(t.ctx, 'FLT', {
      title: 'Slow page',
      priority: 3,
      status: 'Backlog',
      dueDate: '2026-05-01',
    });
    await createIssue(t.ctx, 'FLT', { title: 'Nice to have', priority: 0, assignee: 'admin' });
    const titles = async (
      conditions: Parameters<typeof listIssues>[1] extends infer P
        ? P extends { filter?: infer F }
          ? F extends { conditions: infer C }
            ? C
            : never
          : never
        : never,
      ctx = t.ctx,
    ) =>
      (
        await listIssues(ctx, {
          project: 'FLT',
          filter: { conditions },
          sort: [{ field: 'title', dir: 'asc' }],
        })
      ).data.map((i) => i.title);
    expect(await titles([{ field: 'labels', op: 'eq', value: 'bug' }])).toEqual([
      'Crash on 100% load',
    ]);
    expect(await titles([{ field: 'assignee', op: 'eq', value: 'me' }], t.member)).toEqual([
      'Crash on 100% load',
    ]);
    expect(await titles([{ field: 'assignee', op: 'in', value: ['@admin', null] }])).toEqual([
      'Nice to have',
      'Slow page',
    ]);
    expect(await titles([{ field: 'priority', op: 'in', value: ['1', '3'] }])).toEqual([
      'Crash on 100% load',
      'Slow page',
    ]);
    expect(await titles([{ field: 'status', op: 'neq', value: 'backlog' }])).toEqual([
      'Crash on 100% load',
      'Nice to have',
    ]);
    expect(await titles([{ field: 'statusCategory', op: 'eq', value: 'backlog' }])).toEqual([
      'Slow page',
    ]);
    expect(await titles([{ field: 'text', op: 'contains', value: '100%' }])).toEqual([
      'Crash on 100% load',
    ]);
    expect(await titles([{ field: 'text', op: 'contains', value: 'flt-2' }])).toEqual([
      'Slow page',
    ]);
    expect(await titles([{ field: 'dueDate', op: 'isNull', value: false }])).toEqual(['Slow page']);
    await expect(titles([{ field: 'status', op: 'eq', value: 'Nope' }])).rejects.toThrow(
      /Unknown status/,
    );
    await expect(titles([{ field: 'bogus', op: 'eq', value: 1 }])).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(titles([{ field: 'priority', op: 'contains', value: 1 }])).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('paginates with stable keyset cursors for every sort', async () => {
    await createProject(t.ctx, { key: 'PAG', name: 'Paging' });
    for (let n = 0; n < 23; n++) {
      await createIssue(t.ctx, 'PAG', {
        title: `Item ${String.fromCharCode(97 + (n % 5))}${n}`,
        priority: n % 5,
        estimate: n % 3 === 0 ? null : n,
        dueDate: n % 4 === 0 ? null : `2026-0${1 + (n % 9)}-1${n % 10}`,
      });
    }
    const sorts = [
      [{ field: 'updatedAt', dir: 'desc' as const }],
      [{ field: 'priority', dir: 'asc' as const }],
      [
        { field: 'estimate', dir: 'desc' as const },
        { field: 'title', dir: 'asc' as const },
      ],
      [{ field: 'dueDate', dir: 'asc' as const }],
      [{ field: 'rank', dir: 'asc' as const }],
    ];
    for (const sort of sorts) {
      const all = (await listIssues(t.ctx, { project: 'PAG', sort, limit: 200 })).data.map(
        (i) => i.id,
      );
      const paged: string[] = [];
      let cursor: string | null = null;
      do {
        const page: Awaited<ReturnType<typeof listIssues>> = await listIssues(t.ctx, {
          project: 'PAG',
          sort,
          limit: 4,
          cursor,
        });
        paged.push(...page.data.map((i) => i.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(paged).toEqual(all);
      expect(all).toHaveLength(23);
    }
    await expect(listIssues(t.ctx, { project: 'PAG', cursor: 'garbage' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe(`comments, links, events (${testDialect()})`, () => {
  it('manages comments with author permissions', async () => {
    const issue = await createIssue(t.ctx, 'ENG', { title: 'Discuss' });
    const c = await createComment(t.member, issue.key, { body: 'First!' });
    expect(c.author.handle).toBe('member');
    await expect(updateComment(t.agent, c.id, { body: 'hijack' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const edited = await updateComment(t.member, c.id, { body: 'Edited' });
    expect(edited.editedAt).not.toBeNull();
    expect((await getIssue(t.ctx, issue.key)).commentCount).toBe(1);
    await deleteComment(t.ctx, c.id); // admin may delete anyone's
    expect(await listComments(t.ctx, issue.key)).toHaveLength(0);
    expect((await getIssue(t.ctx, issue.key)).commentCount).toBe(0);
  });

  it('links issues and shows each side its own perspective', async () => {
    const a = await createIssue(t.ctx, 'ENG', { title: 'Blocker' });
    const b = await createIssue(t.ctx, 'ENG', { title: 'Blocked' });
    const link = await createLink(t.ctx, a.key, { type: 'blocks', target: b.key });
    expect(link).toMatchObject({
      type: 'blocks',
      direction: 'outward',
      label: 'blocks',
      issue: { key: b.key },
    });
    const [fromB] = await listIssueLinks(t.ctx, b.key);
    expect(fromB).toMatchObject({
      direction: 'inward',
      label: 'is blocked by',
      issue: { key: a.key },
    });

    await expect(createLink(t.ctx, a.key, { type: 'blocks', target: b.key })).rejects.toMatchObject(
      { code: 'CONFLICT' },
    );
    await expect(createLink(t.ctx, a.key, { type: 'blocks', target: a.key })).rejects.toMatchObject(
      {
        code: 'INVALID_RELATION',
      },
    );
    await expect(createLink(t.ctx, a.key, { type: 'nope', target: b.key })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    // Symmetric links are stored once whichever side creates them.
    await createLink(t.ctx, b.key, { type: 'relates', target: a.key });
    await expect(
      createLink(t.ctx, a.key, { type: 'relates', target: b.key }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    // "inward" reverses the relation.
    const c = await createIssue(t.ctx, 'ENG', { title: 'Dup' });
    const dup = await createLink(t.ctx, c.key, {
      type: 'duplicates',
      target: a.key,
      direction: 'inward',
    });
    expect(dup).toMatchObject({ direction: 'inward', label: 'is duplicated by' });

    // Link events show up in the target's activity too.
    const activity = await listIssueActivity(t.ctx, b.key);
    expect(activity.data.map((e) => e.type)).toContain('link.created');
    await deleteLink(t.ctx, link.id);
    expect((await listIssueLinks(t.ctx, b.key)).map((l) => l.type)).toEqual(['relates']);
  });

  it('keeps a commit-ordered, strictly increasing event log', async () => {
    const all = await listEvents(t.ctx, { limit: 1000 });
    const seqs = all.data.map((e) => e.seq);
    // Strictly increasing; Postgres may skip values consumed by rolled-back transactions.
    expect(seqs.every((s, i) => i === 0 || s > seqs[i - 1]!)).toBe(true);
    const tail = await listEvents(t.ctx, { after: seqs.at(-3), limit: 10 });
    expect(tail.data.map((e) => e.seq)).toEqual(seqs.slice(-2));
    expect(tail.nextCursor).toBeNull();
  });
});

describe(`statuses, views, tokens (${testDialect()})`, () => {
  it('deletes a used status only when told where issues go', async () => {
    const extra = await createStatus(t.ctx, 'ENG', {
      name: 'QA',
      category: 'started',
      position: 3,
    });
    expect((await listStatuses(t.ctx, 'ENG')).map((s) => s.name)).toEqual([
      'Backlog',
      'Todo',
      'In Progress',
      'QA',
      'In Review',
      'Done',
      'Canceled',
    ]);
    const issue = await createIssue(t.ctx, 'ENG', { title: 'In QA', status: 'QA' });
    await expect(deleteStatus(t.ctx, extra.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await deleteStatus(t.ctx, extra.id, { moveIssuesTo: 'In Review' });
    expect((await getIssue(t.ctx, issue.key)).status.name).toBe('In Review');
    expect((await listStatuses(t.ctx, 'ENG')).map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('updates only the label fields that are given', async () => {
    const label = await createLabel(t.ctx, 'ENG', {
      name: 'keepme',
      color: '#123456',
      description: 'desc',
    });
    const renamed = await updateLabel(t.ctx, label.id, { name: 'kept' });
    expect(renamed).toMatchObject({ name: 'kept', color: '#123456', description: 'desc' });
  });

  it('stores view config and card fields', async () => {
    const [, board] = await listViews(t.ctx, 'ENG');
    const updated = await updateView(t.ctx, board!.id, {
      config: {
        ...board!.config,
        board: { ...board!.config.board, cardFields: ['key', 'dueDate', 'estimate'] },
      },
    });
    expect(updated.config.board.cardFields).toEqual(['key', 'dueDate', 'estimate']);
  });

  it('bootstraps the first admin without minting a credential, once', async () => {
    const db = await createTestDb();
    try {
      const result = await bootstrapAdmin(db, { handle: 'first', name: 'First' });
      expect(Object.keys(result)).toEqual(['user']);
      expect(result.user).toMatchObject({ handle: 'first', role: 'admin', kind: 'human' });
      await expect(bootstrapAdmin(db, { handle: 'second', name: 'Second' })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
    } finally {
      await db.destroy();
    }
  });
});
