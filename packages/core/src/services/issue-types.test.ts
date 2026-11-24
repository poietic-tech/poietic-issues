import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDialect } from '@poietic-tech/issues-db/testing';
import { createTestContext, grant, type TestContext } from '../testing.ts';
import { listEvents } from './events.ts';
import {
  createIssueType,
  deleteIssueType,
  listIssueTypes,
  reorderIssueTypes,
  updateIssueType,
} from './issue-types.ts';
import { createIssue, getIssue, listIssueActivity, listIssues, updateIssue } from './issues.ts';
import { createProject } from './projects.ts';
import { issueInputJsonSchema } from './schema.ts';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
  await createProject(t.ctx, { key: 'TYP', name: 'Types' });
});
afterAll(() => t.destroy());

const names = async (project = 'TYP') => (await listIssueTypes(t.ctx, project)).map((x) => x.name);

describe(`issue types (${testDialect()})`, () => {
  it('gives a new project Feature, Bug and Task, recording their creation', async () => {
    expect(await names()).toEqual(['Feature', 'Bug', 'Task']);
    const events = (await listEvents(t.ctx, { types: ['issue_type.created'], limit: 1000 })).data;
    expect(events.filter((e) => e.projectId).length).toBeGreaterThanOrEqual(3);
  });

  it('leaves new issues without a type, and sets or clears one by name or id', async () => {
    const issue = await createIssue(t.ctx, 'TYP', { title: 'untyped' });
    expect(issue).toMatchObject({ typeId: null, type: null });
    const [, bug] = await listIssueTypes(t.ctx, 'TYP');
    const typed = await updateIssue(t.ctx, issue.key, { type: 'bug' });
    expect(typed.type).toEqual({ id: bug!.id, name: 'Bug', color: bug!.color });
    expect((await updateIssue(t.ctx, issue.key, { type: bug!.id })).version).toBe(typed.version);
    const cleared = await updateIssue(t.ctx, issue.key, { type: null });
    expect(cleared).toMatchObject({ typeId: null, type: null });
    const activity = await listIssueActivity(t.ctx, issue.key);
    const changes = activity.data.flatMap((e) => (e.data.changes ? [e.data.changes] : []));
    expect(changes).toContainEqual({
      type: { from: null, to: { id: bug!.id, name: 'Bug', color: bug!.color } },
    });
    expect(changes).toContainEqual({
      type: { from: { id: bug!.id, name: 'Bug', color: bug!.color }, to: null },
    });
  });

  it('creates an issue with a type, and refuses a type from another project', async () => {
    const issue = await createIssue(t.ctx, 'TYP', { title: 'a task', type: 'Task' });
    expect(issue.type?.name).toBe('Task');
    await createProject(t.ctx, { key: 'OTH', name: 'Other' });
    const [otherFeature] = await listIssueTypes(t.ctx, 'OTH');
    await expect(
      createIssue(t.ctx, 'TYP', { title: 'x', type: otherFeature!.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(createIssue(t.ctx, 'TYP', { title: 'x', type: 'Epic' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('filters by type name, id and none', async () => {
    await createIssue(t.ctx, 'TYP', { title: 'filter bug', type: 'Bug' });
    const byName = await listIssues(t.ctx, {
      project: 'TYP',
      filter: { conditions: [{ field: 'type', op: 'eq', value: 'bug' }] },
    });
    expect(byName.data.map((i) => i.title)).toEqual(['filter bug']);
    const none = await listIssues(t.ctx, {
      project: 'TYP',
      filter: { conditions: [{ field: 'type', op: 'isNull', value: true }] },
    });
    expect(none.data.map((i) => i.title)).toContain('untyped');
    expect(none.data.map((i) => i.title)).not.toContain('filter bug');
    await expect(
      listIssues(t.ctx, {
        project: 'TYP',
        filter: { conditions: [{ field: 'type', op: 'eq', value: 'Epic' }] },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('creates at a position, renames, recolors and reorders, refusing duplicate names', async () => {
    const spike = await createIssueType(t.ctx, 'TYP', { name: 'Spike', position: 1 });
    expect(await names()).toEqual(['Feature', 'Spike', 'Bug', 'Task']);
    await expect(createIssueType(t.ctx, 'TYP', { name: 'BUG' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const renamed = await updateIssueType(t.ctx, spike.id, { name: 'Research', color: '#123456' });
    expect(renamed).toMatchObject({ name: 'Research', color: '#123456' });
    await expect(updateIssueType(t.ctx, spike.id, { name: 'task' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const ids = (await listIssueTypes(t.ctx, 'TYP')).map((x) => x.id);
    const reordered = await reorderIssueTypes(t.ctx, 'TYP', [...ids].reverse());
    expect(reordered.map((x) => x.name)).toEqual(['Task', 'Bug', 'Research', 'Feature']);
    await expect(reorderIssueTypes(t.ctx, 'TYP', ids.slice(1))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('deletes a type, clearing it on its issues or moving them to another type', async () => {
    const temp = await createIssueType(t.ctx, 'TYP', { name: 'Temp' });
    const a = await createIssue(t.ctx, 'TYP', { title: 'temp a', type: 'Temp' });
    await deleteIssueType(t.ctx, temp.id);
    const after = await getIssue(t.ctx, a.key);
    expect(after).toMatchObject({ typeId: null, type: null });
    expect(after.version).toBe(a.version + 1);
    expect(await names()).not.toContain('Temp');

    const temp2 = await createIssueType(t.ctx, 'TYP', { name: 'Temp2' });
    const b = await createIssue(t.ctx, 'TYP', { title: 'temp b', type: temp2.id });
    await expect(deleteIssueType(t.ctx, temp2.id, { moveIssuesTo: 'Temp2' })).rejects.toMatchObject(
      { code: 'VALIDATION_FAILED' },
    );
    await deleteIssueType(t.ctx, temp2.id, { moveIssuesTo: 'Feature' });
    expect((await getIssue(t.ctx, b.key)).type?.name).toBe('Feature');
    const positions = (await listIssueTypes(t.ctx, 'TYP')).map((x) => x.position);
    expect(positions).toEqual(positions.map((_, i) => i));
    const deleted = (await listEvents(t.ctx, { types: ['issue_type.deleted'], limit: 1000 })).data;
    expect(deleted.map((e) => (e.data.issueType as { name: string }).name)).toEqual([
      'Temp',
      'Temp2',
    ]);
  });

  it('needs write access to change types, and read access to list them', async () => {
    await expect(createIssueType(t.member, 'TYP', { name: 'Nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await grant(t, 'TYP', t.member, 'viewer');
    expect((await listIssueTypes(t.member, 'TYP')).length).toBeGreaterThan(0);
    await expect(createIssueType(t.member, 'TYP', { name: 'Nope' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('offers the type names in the issue input schema', async () => {
    const schema = (await issueInputJsonSchema(t.ctx, 'TYP')) as {
      create: { properties: { type: { anyOf: unknown[] } } };
    };
    expect(schema.create.properties.type.anyOf).toEqual([
      { enum: await names() },
      { type: 'null' },
    ]);
  });
});
