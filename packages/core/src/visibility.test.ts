import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDialect } from '@poietic-tech/issues-db/testing';
import { newId } from '@poietic-tech/issues-schema';
import { ANONYMOUS_ACTOR, type ServiceContext, withActor } from './context.ts';
import { createIssue, getIssue, listIssues, updateIssue } from './services/issues.ts';
import { createProject, getProject } from './services/projects.ts';
import { LocalDiskBlobStore } from './storage/blob-store.ts';
import { createTestContext, grant, type TestContext } from './testing.ts';

describe(`project visibility (${testDialect()})`, () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
    await createProject(t.ctx, { key: 'PUB', name: 'Public', visibility: 'public' });
    await createProject(t.ctx, { key: 'PRV', name: 'Private' });
    await createIssue(t.ctx, 'PUB', { title: 'open' });
    await createIssue(t.ctx, 'PRV', { title: 'secret' });
  });
  afterAll(async () => {
    await t.destroy();
    for (const dir of blobDirs) rmSync(dir, { recursive: true, force: true });
  });

  /** A blob store in a temp directory that `afterAll` removes. */
  const blobDirs: string[] = [];
  function tempBlobStore() {
    const dir = mkdtempSync(join(tmpdir(), 'vis-blobs-'));
    blobDirs.push(dir);
    return new LocalDiskBlobStore(join(dir, 'b'));
  }

  it('hides private projects and their issues as not found', async () => {
    await expect(getProject(t.member, 'PRV')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(getIssue(t.member, 'PRV-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lets anyone read public projects but only editors write', async () => {
    const anon = withActor(t.ctx, ANONYMOUS_ACTOR);
    expect((await getIssue(anon, 'PUB-1')).title).toBe('open');
    await expect(updateIssue(anon, 'PUB-1', { title: 'x' })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(updateIssue(t.member, 'PUB-1', { title: 'x' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await grant(t, 'PUB', t.member, 'editor');
    expect((await updateIssue(t.member, 'PUB-1', { title: 'x' })).title).toBe('x');
  });

  /** Removes any membership so a test starts from "no role" regardless of earlier grants. */
  async function revoke(projectKey: string, who: ServiceContext) {
    const project = await t.db.kysely
      .selectFrom('projects')
      .select('id')
      .where('key', '=', projectKey)
      .executeTakeFirstOrThrow();
    await t.db.kysely
      .deleteFrom('project_members')
      .where('project_id', '=', project.id)
      .where('user_id', '=', who.actor.id)
      .execute();
  }

  it('checks the parent project for lookups by id', async () => {
    const { listLabels, createLabel, updateLabel } = await import('./services/labels.ts');
    const label = await createLabel(t.ctx, 'PRV', { name: 'secret-label' });
    await revoke('PRV', t.member);
    await expect(updateLabel(t.member, label.id, { name: 'x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await grant(t, 'PRV', t.member, 'viewer');
    await expect(updateLabel(t.member, label.id, { name: 'x' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect((await listLabels(t.member, 'PRV')).map((l) => l.name)).toContain('secret-label');
  });

  it('applies the same check to statuses, custom fields and options', async () => {
    const { createCustomField, getCustomField, updateCustomField, addFieldOption } =
      await import('./services/custom-fields.ts');
    const { listStatuses, updateStatus, deleteStatus } = await import('./services/statuses.ts');
    const field = await createCustomField(t.ctx, 'PRV', {
      key: 'kind',
      name: 'Kind',
      type: 'select',
      options: [{ value: 'a' }],
    });
    const [status] = await listStatuses(t.ctx, 'PRV');
    await revoke('PRV', t.member);
    await expect(getCustomField(t.member, field.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(updateStatus(t.member, status!.id, { name: 'z' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(deleteStatus(t.member, status!.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await grant(t, 'PRV', t.member, 'viewer');
    expect((await getCustomField(t.member, field.id)).key).toBe('kind');
    await expect(updateCustomField(t.member, field.id, { name: 'z' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(addFieldOption(t.member, field.id, { value: 'b' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(updateStatus(t.member, status!.id, { name: 'z' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await grant(t, 'PRV', t.member, 'editor');
    expect((await updateCustomField(t.member, field.id, { name: 'Kind 2' })).name).toBe('Kind 2');
    const option = field.options[0]!;
    const { updateFieldOption } = await import('./services/custom-fields.ts');
    expect((await updateFieldOption(t.member, option.id, { label: 'A' })).options[0]!.label).toBe(
      'A',
    );
  });

  it('lets managers moderate comments and delete custom fields', async () => {
    const { createComment, updateComment } = await import('./services/comments.ts');
    const { createCustomField, deleteCustomField } = await import('./services/custom-fields.ts');
    await grant(t, 'PRV', t.agent, 'editor');
    const comment = await createComment(t.agent, 'PRV-1', { body: 'hi' });
    await grant(t, 'PRV', t.member, 'editor');
    await expect(updateComment(t.member, comment.id, { body: 'edited' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const field = await createCustomField(t.member, 'PRV', {
      key: 'tier',
      name: 'Tier',
      type: 'text',
    });
    await expect(deleteCustomField(t.member, field.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await grant(t, 'PRV', t.member, 'manager');
    expect((await updateComment(t.member, comment.id, { body: 'edited' })).body).toBe('edited');
    expect((await deleteCustomField(t.member, field.id)).id).toBe(field.id);
  });

  it('keeps authors in control of their own comments, and hides them without access', async () => {
    const { createComment, updateComment, deleteComment } = await import('./services/comments.ts');
    await grant(t, 'PRV', t.member, 'editor');
    const mine = await createComment(t.member, 'PRV-1', { body: 'mine' });
    expect((await updateComment(t.member, mine.id, { body: 'mine 2' })).body).toBe('mine 2');
    await revoke('PRV', t.member);
    await expect(updateComment(t.member, mine.id, { body: 'x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await grant(t, 'PRV', t.member, 'viewer');
    await expect(deleteComment(t.member, mine.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await grant(t, 'PRV', t.member, 'editor');
    expect((await deleteComment(t.member, mine.id)).id).toBe(mine.id);
  });

  it('rejects writes from viewers', async () => {
    const { createComment } = await import('./services/comments.ts');
    await grant(t, 'PRV', t.member, 'viewer');
    await expect(createComment(t.member, 'PRV-1', { body: 'nope' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('lets managers moderate attachments and checks access on read', async () => {
    const { uploadAttachment, getAttachment, deleteAttachment } =
      await import('./services/attachments.ts');
    const blobs = tempBlobStore();
    await grant(t, 'PRV', t.agent, 'editor');
    const file = await uploadAttachment(t.agent, blobs, 'PRV-1', {
      filename: 'a.txt',
      data: new TextEncoder().encode('hello'),
    });
    await revoke('PRV', t.member);
    await expect(getAttachment(t.member, file.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(deleteAttachment(t.member, blobs, file.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await grant(t, 'PRV', t.member, 'viewer');
    expect((await getAttachment(t.member, file.id)).id).toBe(file.id);
    await grant(t, 'PRV', t.member, 'editor');
    await expect(deleteAttachment(t.member, blobs, file.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await grant(t, 'PRV', t.member, 'manager');
    expect((await deleteAttachment(t.member, blobs, file.id)).id).toBe(file.id);
  });

  it('needs write on one end of a link, and read on both, to delete it', async () => {
    const { createLink, deleteLink } = await import('./services/links.ts');
    const second = await createIssue(t.ctx, 'PUB', { title: 'second' });
    const link = await createLink(t.ctx, 'PUB-1', { type: 'relates', target: second.key });
    await revoke('PUB', t.member);
    await expect(deleteLink(t.member, link.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(deleteLink(withActor(t.ctx, ANONYMOUS_ACTOR), link.id)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await grant(t, 'PUB', t.member, 'editor');
    await deleteLink(t.member, link.id);
  });

  it('lets an editor of either end delete a link, whichever issue it is stored from', async () => {
    const { createLink, deleteLink } = await import('./services/links.ts');
    const storedSource = async (id: string) =>
      (
        await t.db.kysely
          .selectFrom('issue_links as l')
          .innerJoin('issues as i', 'i.id', 'l.source_id')
          .innerJoin('projects as p', 'p.id', 'i.project_id')
          .select('p.key')
          .where('l.id', '=', id)
          .executeTakeFirstOrThrow()
      ).key;
    await revoke('PUB', t.member); // PUB is public: read only
    await grant(t, 'PRV', t.member, 'editor');

    // "PRV-1 is blocked by PUB-1" is stored from PUB-1, a project the editor can only read.
    const inward = await createLink(t.member, 'PRV-1', {
      type: 'blocks',
      target: 'PUB-1',
      direction: 'inward',
    });
    expect(await storedSource(inward.id)).toBe('PUB');
    await deleteLink(t.member, inward.id);

    // Symmetric links are stored in id order, so this one is also stored from PUB-1 (created first).
    const symmetric = await createLink(t.member, 'PRV-1', { type: 'relates', target: 'PUB-1' });
    expect(await storedSource(symmetric.id)).toBe('PUB');
    await deleteLink(t.member, symmetric.id);

    // A viewer of both ends cannot.
    const other = await createLink(t.ctx, 'PRV-1', { type: 'blocks', target: 'PUB-1' });
    await grant(t, 'PRV', t.member, 'viewer');
    await expect(deleteLink(t.member, other.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Write on one end is not enough when the other end is hidden: the link is not visible at all,
    // even when it is stored from the writable end.
    const intoHidden = await createLink(t.ctx, 'PUB-1', { type: 'duplicates', target: 'PRV-1' });
    expect(await storedSource(intoHidden.id)).toBe('PUB');
    await revoke('PRV', t.member);
    await grant(t, 'PUB', t.member, 'editor');
    for (const id of [other.id, intoHidden.id])
      await expect(deleteLink(t.member, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await deleteLink(t.ctx, other.id);
    await deleteLink(t.ctx, intoHidden.id);
  });

  it('keeps shared views for managers and personal views for their owners', async () => {
    const { createView, getView, updateView, deleteView } = await import('./services/views.ts');
    const anon = withActor(t.ctx, ANONYMOUS_ACTOR);
    await grant(t, 'PUB', t.member, 'editor');
    await expect(
      createView(t.member, 'PUB', { name: 'Shared', layout: 'list', shared: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await grant(t, 'PUB', t.member, 'manager');
    const shared = await createView(t.member, 'PUB', {
      name: 'Shared',
      layout: 'list',
      shared: true,
    });
    const spare = await createView(t.member, 'PUB', {
      name: 'Spare',
      layout: 'list',
      shared: true,
    });
    // Anyone who can read the project can read a shared view, but not change it.
    expect((await getView(anon, shared.id)).id).toBe(shared.id);
    await expect(updateView(anon, shared.id, { name: 'x' })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await grant(t, 'PUB', t.member, 'editor');
    await expect(updateView(t.member, shared.id, { name: 'x' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(deleteView(t.member, spare.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await grant(t, 'PUB', t.member, 'manager');
    expect((await updateView(t.member, shared.id, { name: 'Renamed' })).name).toBe('Renamed');
    expect((await deleteView(t.member, spare.id)).id).toBe(spare.id);

    // Personal views belong to the owner, even for managers; readers can make their own.
    await grant(t, 'PUB', t.member, 'viewer');
    const mine = await createView(t.member, 'PUB', { name: 'Mine', layout: 'list' });
    await expect(getView(t.agent, mine.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await updateView(t.member, mine.id, { name: 'Mine 2' })).name).toBe('Mine 2');
    expect((await deleteView(t.member, mine.id)).id).toBe(mine.id);
  });

  it('hides views of unreadable projects and rejects anonymous personal views', async () => {
    const { createView, getView } = await import('./services/views.ts');
    const anon = withActor(t.ctx, ANONYMOUS_ACTOR);
    const hidden = await createView(t.ctx, 'PRV', { name: 'Hidden', layout: 'list', shared: true });
    await revoke('PRV', t.member);
    await expect(getView(t.member, hidden.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(getView(anon, hidden.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(createView(anon, 'PRV', { name: 'x', layout: 'list' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(createView(anon, 'PUB', { name: 'x', layout: 'list' })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('treats a parent filter on an unreadable issue as an unknown issue', async () => {
    await revoke('PRV', t.member);
    await expect(
      listIssues(t.member, {
        project: 'PUB',
        filter: { conditions: [{ field: 'parent', op: 'eq', value: 'PRV-1' }] },
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringContaining('Unknown issue'),
    });
  });

  it('reports an unreadable resource exactly like a missing one, without naming its project', async () => {
    const { createLabel, updateLabel } = await import('./services/labels.ts');
    const { listStatuses, updateStatus } = await import('./services/statuses.ts');
    const { createCustomField, getCustomField, updateFieldOption } =
      await import('./services/custom-fields.ts');
    const { createComment, updateComment } = await import('./services/comments.ts');
    const { createView, getView } = await import('./services/views.ts');
    const { createLink, deleteLink } = await import('./services/links.ts');
    const { uploadAttachment, getAttachment } = await import('./services/attachments.ts');
    const blobs = tempBlobStore();

    const label = await createLabel(t.ctx, 'PRV', { name: 'oracle-label' });
    const [status] = await listStatuses(t.ctx, 'PRV');
    const field = await createCustomField(t.ctx, 'PRV', {
      key: 'oracle',
      name: 'Oracle',
      type: 'select',
      options: [{ value: 'a' }],
    });
    const comment = await createComment(t.ctx, 'PRV-1', { body: 'x' });
    const view = await createView(t.ctx, 'PRV', { name: 'Oracle', layout: 'list', shared: true });
    const other = await createIssue(t.ctx, 'PRV', { title: 'other' });
    const link = await createLink(t.ctx, 'PRV-1', { type: 'relates', target: other.key });
    const file = await uploadAttachment(t.ctx, blobs, 'PRV-1', {
      filename: 'a.txt',
      data: new TextEncoder().encode('hi'),
    });
    await revoke('PRV', t.member);

    const message = async (p: Promise<unknown>) => {
      const error = await p.then(
        () => undefined,
        (e: unknown) => e as { code: string; message: string },
      );
      expect(error?.code).toBe('NOT_FOUND');
      return error!.message;
    };
    const cases: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
      [
        'label',
        () => updateLabel(t.member, label.id, { name: 'x' }),
        () => updateLabel(t.member, newId('label'), { name: 'x' }),
      ],
      [
        'status',
        () => updateStatus(t.member, status!.id, { name: 'x' }),
        () => updateStatus(t.member, newId('status'), { name: 'x' }),
      ],
      [
        'field',
        () => getCustomField(t.member, field.id),
        () => getCustomField(t.member, newId('customField')),
      ],
      [
        'option',
        () => updateFieldOption(t.member, field.options[0]!.id, { label: 'x' }),
        () => updateFieldOption(t.member, newId('customFieldOption'), { label: 'x' }),
      ],
      [
        'comment',
        () => updateComment(t.member, comment.id, { body: 'y' }),
        () => updateComment(t.member, newId('comment'), { body: 'y' }),
      ],
      ['view', () => getView(t.member, view.id), () => getView(t.member, newId('view'))],
      ['link', () => deleteLink(t.member, link.id), () => deleteLink(t.member, newId('issueLink'))],
      [
        'attachment',
        () => getAttachment(t.member, file.id),
        () => getAttachment(t.member, newId('attachment')),
      ],
    ];
    for (const [name, hidden, missing] of cases) {
      const hiddenMessage = await message(hidden());
      const missingMessage = await message(missing());
      expect(hiddenMessage.replace(/"[^"]*"/, '"id"'), name).toBe(
        missingMessage.replace(/"[^"]*"/, '"id"'),
      );
      expect(hiddenMessage, name).not.toMatch(/Project|prj_/);
    }
  });

  it('never returns unreadable projects from cross-project reads', async () => {
    const { listProjects } = await import('./services/projects.ts');
    const { listEvents } = await import('./services/events.ts');
    const anon = withActor(t.ctx, ANONYMOUS_ACTOR);
    expect((await listProjects(anon)).map((p) => p.key)).toEqual(['PUB']);
    await revoke('PRV', t.member);
    expect((await listProjects(t.member)).map((p) => p.key)).toEqual(['PUB']);
    expect((await listProjects(t.ctx)).map((p) => p.key)).toEqual(['PRV', 'PUB']);
    const issues = await listIssues(anon, {});
    expect(issues.data.length).toBeGreaterThan(0);
    expect(issues.data.every((i) => i.key.startsWith('PUB-'))).toBe(true);
    const memberIssues = await listIssues(t.member, {});
    expect(memberIssues.data.every((i) => i.key.startsWith('PUB-'))).toBe(true);
    const events = await listEvents(anon, { limit: 1000 });
    const prv = await t.db.kysely
      .selectFrom('projects')
      .select('id')
      .where('key', '=', 'PRV')
      .executeTakeFirstOrThrow();
    expect(events.data.length).toBeGreaterThan(0);
    expect(events.data.some((e) => e.projectId === prv.id)).toBe(false);
    expect(events.data.some((e) => e.projectId === null)).toBe(false); // user.* events need sign-in
    const signedIn = await listEvents(t.member, { limit: 1000 });
    expect(signedIn.data.some((e) => e.projectId === prv.id)).toBe(false);
    expect(signedIn.data.some((e) => e.projectId === null)).toBe(true);
    await grant(t, 'PRV', t.member, 'viewer');
    expect((await listProjects(t.member)).map((p) => p.key)).toEqual(['PRV', 'PUB']);
    expect(
      (await listEvents(t.member, { limit: 1000 })).data.some((e) => e.projectId === prv.id),
    ).toBe(true);
  });

  it('does not confirm private names through filter errors', async () => {
    const { createLabel } = await import('./services/labels.ts');
    await createLabel(t.ctx, 'PRV', { name: 'only-private' });
    const anon = withActor(t.ctx, ANONYMOUS_ACTOR);
    await expect(
      listIssues(anon, {
        filter: { conditions: [{ field: 'labels', op: 'eq', value: 'only-private' }] },
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'Unknown label "only-private"',
    });
    // Admins see everything, so the same filter is valid for them.
    await expect(
      listIssues(t.ctx, {
        filter: { conditions: [{ field: 'labels', op: 'eq', value: 'only-private' }] },
      }),
    ).resolves.toMatchObject({ data: [] });
  });

  it('does not use an unreadable issue id as a parent filter', async () => {
    const prv = await t.db.kysely
      .selectFrom('issues as i')
      .innerJoin('projects as p', 'p.id', 'i.project_id')
      .select('i.id')
      .where('p.key', '=', 'PRV')
      .where('i.number', '=', 1)
      .executeTakeFirstOrThrow();
    await revoke('PRV', t.member);
    await expect(
      listIssues(t.member, {
        project: 'PUB',
        filter: { conditions: [{ field: 'parent', op: 'eq', value: prv.id }] },
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringContaining('Unknown issue'),
    });
    await grant(t, 'PRV', t.member, 'viewer');
    await expect(
      listIssues(t.member, {
        filter: { conditions: [{ field: 'parent', op: 'eq', value: prv.id }] },
      }),
    ).resolves.toMatchObject({ data: [] });
  });

  it('omits links into unreadable projects', async () => {
    const { createLink, listIssueLinks } = await import('./services/links.ts');
    const link = await createLink(t.ctx, 'PUB-1', { type: 'relates', target: 'PRV-1' });
    expect(link.issue.key).toBe('PRV-1');
    const anon = withActor(t.ctx, ANONYMOUS_ACTOR);
    expect(await listIssueLinks(anon, 'PUB-1')).toEqual([]);
    const { listIssueActivity } = await import('./services/issues.ts');
    const linkEvents = async (who: ServiceContext) =>
      (await listIssueActivity(who, 'PUB-1')).data.filter(
        (e) => e.type.startsWith('link.') && JSON.stringify(e.data).includes('PRV-1'),
      );
    expect(await linkEvents(anon)).toEqual([]);
    expect((await linkEvents(t.ctx)).length).toBeGreaterThanOrEqual(1);
    await revoke('PRV', t.member);
    expect(await linkEvents(t.member)).toEqual([]);
    expect(await listIssueLinks(t.member, 'PUB-1')).toEqual([]);
    expect((await listIssueLinks(t.ctx, 'PUB-1')).length).toBeGreaterThanOrEqual(1);
    await grant(t, 'PRV', t.member, 'viewer');
    expect((await listIssueLinks(t.member, 'PUB-1')).map((l) => l.issue.key)).toContain('PRV-1');
    expect((await linkEvents(t.member)).length).toBeGreaterThanOrEqual(1);
  });

  it('requires sign-in for users and shows emails only to admins and the user', async () => {
    const { listUsers, getUser, createUser, updateUser } = await import('./services/users.ts');
    const { listEvents } = await import('./services/events.ts');
    const anon = withActor(t.ctx, ANONYMOUS_ACTOR);
    await expect(listUsers(anon)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(getUser(anon, 'admin')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await updateUser(t.ctx, 'admin', { email: 'admin@example.com' });
    await updateUser(t.member, 'me', { email: 'member@example.com' });
    const created = await createUser(t.ctx, { handle: 'other', name: 'Other', email: 'o@x.io' });

    const seen = await listUsers(t.member);
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.filter((u) => u.id !== t.member.actor.id).every((u) => u.email === null)).toBe(
      true,
    );
    expect(seen.find((u) => u.id === t.member.actor.id)?.email).toBe('member@example.com');
    expect((await getUser(t.member, 'admin')).email).toBeNull();
    expect((await getUser(t.member, 'me')).email).toBe('member@example.com');
    expect((await getUser(t.ctx, 'other')).email).toBe('o@x.io');
    expect((await listUsers(t.ctx)).find((u) => u.id === created.id)?.email).toBe('o@x.io');

    // The event log must not leak the emails the user list hides.
    const userEvents = (await listEvents(t.member, { limit: 1000 })).data.filter((e) =>
      e.type.startsWith('user.'),
    );
    expect(userEvents.length).toBeGreaterThan(0);
    for (const e of userEvents) {
      const user = e.data.user as { id: string; email: string | null };
      if (user.id === t.member.actor.id) continue;
      expect(user.email, e.type).toBeNull();
      expect(
        (e.data.changes as Record<string, unknown> | undefined)?.email,
        e.type,
      ).toBeUndefined();
    }
    const adminEvents = (await listEvents(t.ctx, { limit: 1000 })).data.filter(
      (e) => e.type === 'user.created' && (e.data.user as { id: string }).id === created.id,
    );
    expect((adminEvents[0]!.data.user as { email: string }).email).toBe('o@x.io');
  });

  it('lists only users who can write in the issue input schema, and none to anonymous readers', async () => {
    const { issueInputJsonSchema } = await import('./services/schema.ts');
    const { addRepo } = await import('./services/repos.ts');
    const { createCustomField } = await import('./services/custom-fields.ts');
    const { createUser } = await import('./services/users.ts');
    await createProject(t.ctx, { key: 'SCH', name: 'Schema', visibility: 'public' });
    await addRepo(t.ctx, 'SCH', { repo: 'acme/app' });
    await createCustomField(t.ctx, 'SCH', { key: 'owner', name: 'Owner', type: 'user' });
    await createUser(t.ctx, { handle: 'outsider', name: 'Outsider' }); // no membership in SCH
    await grant(t, 'SCH', t.agent, 'editor');
    await grant(t, 'SCH', t.member, 'viewer');
    type Prop = { anyOf?: { enum?: unknown[] }[]; examples?: unknown[] };
    type Shape = {
      properties: {
        assignee: Prop;
        repo: Prop;
        customFields: { properties: Record<string, Prop> };
      };
    };
    const schemaFor = async (who: ServiceContext) =>
      (await issueInputJsonSchema(who, 'SCH')) as { create: Shape; update: Shape };
    const assignees = (s: Shape) => s.properties.assignee.anyOf?.find((a) => a.enum)?.enum;

    // A viewer sees who can be assigned (editors, managers and admins) but is not offered `me`.
    const viewer = await schemaFor(t.member);
    expect(assignees(viewer.create)).toEqual(['admin', 'bot']);
    expect(assignees(viewer.update)).toEqual(['admin', 'bot']);
    expect(viewer.create.properties.customFields.properties.owner!.examples).toEqual([
      'admin',
      'bot',
    ]);

    // An editor is offered `me` and appears in the list.
    await grant(t, 'SCH', t.member, 'editor');
    const editor = await schemaFor(t.member);
    expect(assignees(editor.create)).toEqual(['me', 'admin', 'bot', 'member']);
    expect(assignees(editor.update)).toEqual(['me', 'admin', 'bot', 'member']);

    // Anonymous readers get the schema without any user handles.
    const anon = await schemaFor(withActor(t.ctx, ANONYMOUS_ACTOR));
    for (const s of [anon.create, anon.update]) {
      expect(assignees(s)).toBeUndefined();
      expect(s.properties.customFields.properties.owner!.examples).toBeUndefined();
    }
    const text = JSON.stringify(anon);
    for (const handle of ['admin', 'bot', 'member', 'outsider'])
      expect(text).not.toContain(`"${handle}"`);

    // Linked repos are part of the readable project, so everyone gets them as an enum.
    for (const s of [viewer.create, editor.update, anon.create, anon.update])
      expect(s.properties.repo.anyOf).toEqual([{ enum: ['acme/app'] }, { type: 'null' }]);
  });

  it('applies the event log rules to events read elsewhere (the live stream)', async () => {
    const { filterEventsForViewer, listEvents } = await import('./services/events.ts');
    const { SYSTEM_ACTOR } = await import('./context.ts');
    const all = (await listEvents(withActor(t.ctx, SYSTEM_ACTOR), { limit: 1000 })).data;
    const intoPrivate = (e: { type: string; data: unknown }) =>
      e.type === 'link.created' && JSON.stringify(e.data).includes('PRV-1');
    expect(all.some(intoPrivate)).toBe(true);
    expect(all.some((e) => e.type.startsWith('user.'))).toBe(true);
    await revoke('PRV', t.member);
    const anon = withActor(t.ctx, ANONYMOUS_ACTOR);
    for (const who of [anon, t.member, t.ctx]) {
      const expected = (await listEvents(who, { limit: 1000 })).data;
      expect(await filterEventsForViewer(who, all), who.actor.handle).toEqual(expected);
    }
    const forMember = await filterEventsForViewer(t.member, all);
    expect(forMember.some(intoPrivate)).toBe(false);
    expect(forMember.some((e) => e.projectId === null)).toBe(true);
    expect((await filterEventsForViewer(anon, all)).some((e) => e.projectId === null)).toBe(false);
  });

  it('hides link events whose two ends cannot both be resolved', async () => {
    const { filterEventsForViewer, listEvents } = await import('./services/events.ts');
    const { recordEvent } = await import('./events.ts');
    const { withWriteTx } = await import('@poietic-tech/issues-db');
    const pub = await t.db.kysely
      .selectFrom('projects')
      .select('id')
      .where('key', '=', 'PUB')
      .executeTakeFirstOrThrow();
    const issue = await getIssue(t.ctx, 'PUB-1');
    const malformed = [
      { link: { id: 'lnk_malformed_one_end', type: 'relates', source: { id: issue.id } } },
      { link: { id: 'lnk_malformed_no_ends', type: 'relates' } },
      { note: 'no link at all' },
      {
        link: {
          id: 'lnk_malformed_unknown',
          type: 'relates',
          source: { id: issue.id },
          target: { id: newId('issue') },
        },
      },
    ];
    await withWriteTx(t.db, async (tx) => {
      for (const data of malformed)
        await recordEvent(tx, t.ctx, 'link.created', {
          projectId: pub.id,
          issueId: issue.id,
          data,
        });
    });
    const isMalformed = (e: { data: Record<string, unknown> }) =>
      JSON.stringify(e.data).includes('malformed') || e.data.note === 'no link at all';
    const all = (await listEvents(t.ctx, { limit: 1000 })).data;
    expect(all.filter(isMalformed)).toHaveLength(malformed.length); // admins see the raw log
    await grant(t, 'PUB', t.member, 'editor');
    for (const who of [withActor(t.ctx, ANONYMOUS_ACTOR), t.member]) {
      const listed = (await listEvents(who, { limit: 1000 })).data;
      expect(listed.length, who.actor.handle).toBeGreaterThan(0);
      expect(listed.some(isMalformed), who.actor.handle).toBe(false);
      expect((await filterEventsForViewer(who, all)).some(isMalformed), who.actor.handle).toBe(
        false,
      );
    }
  });

  it('forbids viewers to delete labels and statuses, and asks anonymous actors to sign in', async () => {
    const { createLabel, deleteLabel, listLabels } = await import('./services/labels.ts');
    const { listStatuses, deleteStatus } = await import('./services/statuses.ts');
    await createProject(t.ctx, { key: 'DELV', name: 'Delete levels', visibility: 'public' });
    await createProject(t.ctx, { key: 'DELP', name: 'Delete hidden' });
    const label = await createLabel(t.ctx, 'DELV', { name: 'keep-me' });
    const hiddenLabel = await createLabel(t.ctx, 'DELP', { name: 'hidden-me' });
    const statuses = await listStatuses(t.ctx, 'DELV');
    const [status, spare] = statuses;
    const hiddenStatus = (await listStatuses(t.ctx, 'DELP'))[0]!;
    const anon = withActor(t.ctx, ANONYMOUS_ACTOR);
    await grant(t, 'DELV', t.member, 'viewer');
    await revoke('DELP', t.member);

    await expect(deleteLabel(t.member, label.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(deleteStatus(t.member, status!.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(deleteLabel(anon, label.id)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(deleteStatus(anon, status!.id)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    // Without read access the project is not found, as for every other lookup by id.
    for (const who of [t.member, anon]) {
      await expect(deleteLabel(who, hiddenLabel.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(deleteStatus(who, hiddenStatus.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    }
    expect((await listLabels(t.ctx, 'DELV')).map((l) => l.name)).toEqual(['keep-me']);
    expect(await listStatuses(t.ctx, 'DELV')).toHaveLength(statuses.length);

    // Write is enough to delete them.
    await grant(t, 'DELV', t.member, 'editor');
    expect((await deleteLabel(t.member, label.id)).id).toBe(label.id);
    expect((await deleteStatus(t.member, spare!.id)).id).toBe(spare!.id);
  });

  it('lets a manager delete a comment written by someone else, but not an editor', async () => {
    const { createComment, deleteComment, listComments } = await import('./services/comments.ts');
    await createProject(t.ctx, { key: 'MODC', name: 'Moderation' });
    await createIssue(t.ctx, 'MODC', { title: 'discussed' });
    await grant(t, 'MODC', t.agent, 'editor');
    const comment = await createComment(t.agent, 'MODC-1', { body: 'by the agent' });

    await grant(t, 'MODC', t.member, 'editor');
    await expect(deleteComment(t.member, comment.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await grant(t, 'MODC', t.member, 'manager');
    const deleted = await deleteComment(t.member, comment.id);
    expect(deleted).toMatchObject({ id: comment.id, authorId: t.agent.actor.id });
    expect(deleted.deletedAt).not.toBeNull();
    expect(await listComments(t.agent, 'MODC-1')).toEqual([]);
    // Gone for everyone, managers included.
    await expect(deleteComment(t.member, comment.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('keeps personal views to their owner, even from managers', async () => {
    const { createView, getView, listViews, updateView, deleteView } =
      await import('./services/views.ts');
    await createProject(t.ctx, { key: 'PVW', name: 'Personal views', visibility: 'public' });
    await grant(t, 'PVW', t.agent, 'manager');
    await grant(t, 'PVW', t.member, 'manager');
    const mine = await createView(t.agent, 'PVW', { name: 'Agent only', layout: 'list' });

    await expect(getView(t.member, mine.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(updateView(t.member, mine.id, { name: 'taken' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(deleteView(t.member, mine.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await listViews(t.member, 'PVW')).map((v) => v.id)).not.toContain(mine.id);
    // It is untouched, and still the owner's.
    expect((await getView(t.agent, mine.id)).name).toBe('Agent only');
    expect((await listViews(t.agent, 'PVW')).map((v) => v.id)).toContain(mine.id);
  });
});

describe(`nothing readable (${testDialect()})`, () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
    const { createLabel } = await import('./services/labels.ts');
    await createProject(t.ctx, { key: 'HID', name: 'Hidden' });
    await createIssue(t.ctx, 'HID', { title: 'secret' });
    await createIssue(t.ctx, 'HID', { title: 'also secret', parent: 'HID-1' });
    await createLabel(t.ctx, 'HID', { name: 'hidden-label' });
  });
  afterAll(() => t.destroy());

  it('returns empty lists and unknown names when no project is public and the actor has no memberships', async () => {
    const { listProjects } = await import('./services/projects.ts');
    const { filterEventsForViewer, listEvents } = await import('./services/events.ts');
    const anon = withActor(t.ctx, ANONYMOUS_ACTOR);
    const all = (await listEvents(t.ctx, { limit: 1000 })).data;
    expect(all.some((e) => e.projectId !== null)).toBe(true);
    expect((await listProjects(t.ctx)).map((p) => p.key)).toEqual(['HID']);

    for (const who of [anon, t.member]) {
      const name = who.actor.handle;
      expect(await listProjects(who), name).toEqual([]);
      expect((await listIssues(who, {})).data, name).toEqual([]);
      expect(
        (
          await listIssues(who, {
            filter: { conditions: [{ field: 'text', op: 'contains', value: 'secret' }] },
          })
        ).data,
        name,
      ).toEqual([]);
      const unknown: [string, string, string][] = [
        ['status', 'In Progress', 'Unknown status "In Progress"'],
        ['labels', 'hidden-label', 'Unknown label "hidden-label"'],
        ['parent', 'HID-1', 'Unknown issue'],
      ];
      for (const [field, value, message] of unknown)
        await expect(
          listIssues(who, { filter: { conditions: [{ field, op: 'eq', value }] } } as never),
          `${name} ${field}`,
        ).rejects.toMatchObject({
          code: 'VALIDATION_FAILED',
          message: expect.stringContaining(message),
        });
      const events = (await listEvents(who, { limit: 1000 })).data;
      expect(
        events.every((e) => e.projectId === null),
        name,
      ).toBe(true);
      expect(await filterEventsForViewer(who, all), name).toEqual(events);
    }
    // Anonymous readers also get no project-less (user.*) events, so their log is empty.
    expect((await listEvents(anon, { limit: 1000 })).data).toEqual([]);
  });
});

describe(`admin-only and user events (${testDialect()})`, () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
  });
  afterAll(() => t.destroy());

  it('asks anonymous actors to sign in for admin-only actions, and forbids members', async () => {
    const { listWebhooks } = await import('./services/webhooks.ts');
    const { createUser } = await import('./services/users.ts');
    const anon = withActor(t.ctx, ANONYMOUS_ACTOR);
    await expect(listWebhooks(anon)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(createProject(anon, { key: 'NOPE', name: 'x' })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(createUser(anon, { handle: 'nope', name: 'x' })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(listWebhooks(t.member)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await listWebhooks(t.ctx)).toEqual([]);
  });

  it('drops user.updated events that only changed an email the viewer cannot see', async () => {
    const { createUser, updateUser, toActor } = await import('./services/users.ts');
    const { filterEventsForViewer, listEvents } = await import('./services/events.ts');
    const ada = await createUser(t.ctx, { handle: 'ada', name: 'Ada', email: 'ada@x.io' });
    const asAda = withActor(t.ctx, toActor(ada));
    await updateUser(t.ctx, 'ada', { email: 'ada@new.io' }); // email only
    await updateUser(t.ctx, 'ada', { name: 'Ada L', email: 'ada@newer.io' }); // name and email
    const all = (await listEvents(t.ctx, { types: ['user.updated'], limit: 1000 })).data;
    expect(all.map((e) => Object.keys(e.data.changes as object).sort())).toEqual([
      ['email'],
      ['email', 'name'],
    ]);
    // The member sees only the name change, without the email.
    for (const events of [
      (await listEvents(t.member, { types: ['user.updated'], limit: 1000 })).data,
      await filterEventsForViewer(t.member, all),
    ]) {
      expect(events.map((e) => e.data.changes)).toEqual([{ name: { from: 'Ada', to: 'Ada L' } }]);
      expect((events[0]!.data.user as { email: string | null }).email).toBeNull();
    }
    // The user themself and admins see both.
    for (const who of [asAda, t.ctx]) {
      expect((await listEvents(who, { types: ['user.updated'], limit: 1000 })).data).toHaveLength(
        2,
      );
      expect(await filterEventsForViewer(who, all)).toHaveLength(2);
    }
  });
});
