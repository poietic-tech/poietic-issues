import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDialect } from '@poietic-tech/issues-db/testing';
import { parseRepoRef } from '../refs.ts';
import { addRepo, removeRepo } from './repos.ts';
import { createProject, getProject } from './projects.ts';
import {
  createIssue,
  deleteIssue,
  getIssue,
  listIssueActivity,
  listIssues,
  moveIssue,
  updateIssue,
} from './issues.ts';
import { ANONYMOUS_ACTOR, withActor } from '../context.ts';
import { createTestContext, grant, type TestContext } from '../testing.ts';

describe('parseRepoRef', () => {
  it.each([
    ['acme/app', { owner: 'acme', name: 'app' }],
    ['https://github.com/acme/app', { owner: 'acme', name: 'app' }],
    ['https://github.com/acme/app.git', { owner: 'acme', name: 'app' }],
    ['github.com/acme/app/pull/12', { owner: 'acme', name: 'app' }],
    // Scheme and host in any case; owner and name keep theirs.
    ['HTTPS://GitHub.com/Acme/App', { owner: 'Acme', name: 'App' }],
    ['Http://WWW.GITHUB.COM/Acme/App.git', { owner: 'Acme', name: 'App' }],
    ['GITHUB.COM/acme/App', { owner: 'acme', name: 'App' }],
    ['Acme/App', { owner: 'Acme', name: 'App' }],
  ])('parses %s', (input, expected) => expect(parseRepoRef(input)).toEqual(expected));
  it.each([
    'acme',
    'https://gitlab.com/acme/app',
    'HTTPS://GitLab.com/acme/app',
    'acme/app/extra?x',
    '-bad/app',
    'acme/ap p',
  ])('rejects %s', (input) => expect(() => parseRepoRef(input)).toThrow(/repository/i));
  it('rejects a host-like first segment', () => {
    expect(() => parseRepoRef('a.b/c')).toThrow(/repository/i);
    // A dot at either edge of the first segment is not a host; the owner check rejects it instead.
    expect(() => parseRepoRef('.ab/c')).toThrow(/repository/i);
  });
  it('rejects a long run of dots in linear time', () => {
    const started = performance.now();
    expect(() => parseRepoRef('.'.repeat(100_000))).toThrow(/repository/i);
    expect(() => parseRepoRef(`${'.'.repeat(100_000)}/x`)).toThrow(/repository/i);
    expect(() => parseRepoRef(`a${'.'.repeat(100_000)}`)).toThrow(/repository/i);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe(`repo links (${testDialect()})`, () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
    await createProject(t.ctx, { key: 'ENG', name: 'Eng' });
  });
  afterAll(() => t.destroy());

  it('adds and lists repos, rejects duplicates, and removes them', async () => {
    const repo = await addRepo(t.ctx, 'ENG', { repo: 'https://github.com/Acme/App' });
    expect(repo).toMatchObject({
      owner: 'Acme',
      name: 'App',
      fullName: 'Acme/App',
      url: 'https://github.com/Acme/App',
    });
    await expect(addRepo(t.ctx, 'ENG', { repo: 'acme/app' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect((await getProject(t.ctx, 'ENG')).repos.map((r) => r.fullName)).toEqual(['Acme/App']);
    await removeRepo(t.ctx, 'ENG', 'acme/app');
    expect((await getProject(t.ctx, 'ENG')).repos).toEqual([]);
    await expect(removeRepo(t.ctx, 'ENG', 'acme/app')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('removing a repo clears it from issues that used it', async () => {
    const repo = await addRepo(t.ctx, 'ENG', { repo: 'acme/clear-me' });
    const issue = await createIssue(t.ctx, 'ENG', { title: 'linked', repo: 'ACME/clear-me' });
    expect(issue.repo).toBe('acme/clear-me');
    await removeRepo(t.ctx, 'ENG', repo.id);
    const after = await getIssue(t.ctx, issue.key);
    expect(after.repo).toBeNull();
    expect(after.version).toBe(issue.version + 1);
    const events = await listIssueActivity(t.ctx, issue.key);
    const last = events.data.find((e) => e.type === 'issue.updated');
    expect(last?.data).toMatchObject({ changes: { repo: { from: 'acme/clear-me', to: null } } });
  });

  it('clears a removed repo from trashed issues too', async () => {
    const repo = await addRepo(t.ctx, 'ENG', { repo: 'acme/trashed' });
    const issue = await createIssue(t.ctx, 'ENG', { title: 'to trash', repo: repo.id });
    await deleteIssue(t.ctx, issue.key);
    await removeRepo(t.ctx, 'ENG', 'acme/trashed');
    const after = await getIssue(t.ctx, issue.key);
    expect(after.deletedAt).not.toBeNull();
    expect(after.repo).toBeNull();
  });

  it('filters by repo, rejects unlinked repos, and keeps the repo on a board move', async () => {
    await addRepo(t.ctx, 'ENG', { repo: 'acme/web' });
    await createIssue(t.ctx, 'ENG', { title: 'web bug', repo: 'acme/web' });
    const found = await listIssues(t.ctx, {
      project: 'ENG',
      filter: { conditions: [{ field: 'repo', op: 'eq', value: 'acme/web' }] },
    });
    expect(found.data.map((i) => i.title)).toEqual(['web bug']);
    await expect(
      createIssue(t.ctx, 'ENG', { title: 'bad', repo: 'other/repo' }),
    ).rejects.toMatchObject({ code: 'INVALID_RELATION' });
    // Issues cannot change projects (moveIssue only reorders/changes status), so the repo stays.
    const moved = await moveIssue(t.ctx, found.data[0]!.key, { position: 'bottom' });
    expect(moved.repo).toBe('acme/web');
    const none = await listIssues(t.ctx, {
      project: 'ENG',
      filter: { conditions: [{ field: 'repo', op: 'isNull', value: true }] },
    });
    expect(none.data.map((i) => i.title)).not.toContain('web bug');
  });

  it('names the project when a repo is not linked to it, on create and update', async () => {
    const message = '"other/repo" is not linked to project ENG';
    await expect(
      createIssue(t.ctx, 'ENG', { title: 'bad', repo: 'other/repo' }),
    ).rejects.toMatchObject({ code: 'INVALID_RELATION', message });
    const issue = await createIssue(t.ctx, 'ENG', { title: 'fine' });
    await expect(updateIssue(t.ctx, issue.key, { repo: 'other/repo' })).rejects.toMatchObject({
      code: 'INVALID_RELATION',
      message,
    });
  });

  describe('access and edge cases', () => {
    it('lets only managers link and unlink repos', async () => {
      await createProject(t.ctx, { key: 'RLVL', name: 'Levels', visibility: 'public' });
      await createProject(t.ctx, { key: 'RHID', name: 'Hidden' });
      await grant(t, 'RLVL', t.member, 'viewer');
      await grant(t, 'RLVL', t.agent, 'editor');
      const linked = await addRepo(t.ctx, 'RLVL', { repo: 'acme/levels' });
      const anon = withActor(t.ctx, ANONYMOUS_ACTOR);

      for (const who of [t.member, t.agent]) {
        await expect(addRepo(who, 'RLVL', { repo: 'acme/other' })).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        await expect(removeRepo(who, 'RLVL', linked.id)).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
      }
      await expect(addRepo(anon, 'RLVL', { repo: 'acme/other' })).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      await expect(removeRepo(anon, 'RLVL', linked.id)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      // A private project is not found, never forbidden.
      for (const who of [t.member, anon]) {
        await expect(addRepo(who, 'RHID', { repo: 'acme/other' })).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });
        await expect(removeRepo(who, 'RHID', 'acme/other')).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });
      }
      expect((await getProject(t.ctx, 'RLVL')).repos.map((r) => r.fullName)).toEqual([
        'acme/levels',
      ]);

      await grant(t, 'RLVL', t.agent, 'manager');
      await addRepo(t.agent, 'RLVL', { repo: 'acme/by-manager' });
      await removeRepo(t.agent, 'RLVL', 'acme/by-manager');
      expect((await getProject(t.ctx, 'RLVL')).repos.map((r) => r.fullName)).toEqual([
        'acme/levels',
      ]);
    });

    it('does not confirm a private repo to an unscoped repo filter', async () => {
      await createProject(t.ctx, { key: 'RSEC', name: 'Secret' });
      const repo = await addRepo(t.ctx, 'RSEC', { repo: 'acme/secret-repo' });
      await createIssue(t.ctx, 'RSEC', { title: 'secret work', repo: repo.id });
      const repoFilter = (value: string) => ({
        conditions: [{ field: 'repo', op: 'eq' as const, value }],
      });
      const byName = repoFilter('acme/secret-repo');
      const byId = repoFilter(repo.id);
      const missing = repoFilter('acme/no-such-repo');

      // A non-member gets the same error as for a repo that doesn't exist, and no rows by id.
      const unknown = await listIssues(t.member, { filter: missing }).catch((e) => e);
      expect(unknown).toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(listIssues(t.member, { filter: byName })).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        message: unknown.message.replace('no-such-repo', 'secret-repo'),
      });
      expect((await listIssues(t.member, { filter: byId })).data).toEqual([]);
      await expect(
        listIssues(withActor(t.ctx, ANONYMOUS_ACTOR), { filter: byName }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      // A member finds it, and so does the admin.
      await grant(t, 'RSEC', t.member, 'viewer');
      for (const who of [t.member, t.ctx])
        expect((await listIssues(who, { filter: byName })).data.map((i) => i.title)).toEqual([
          'secret work',
        ]);
    });

    it('rejects a garbage repo ref as a validation error everywhere it is accepted', async () => {
      await createProject(t.ctx, { key: 'RBAD', name: 'Bad refs' });
      const issue = await createIssue(t.ctx, 'RBAD', { title: 'fine' });
      const match = /Not a GitHub repository/;
      for (const garbage of ['not a repo', 'https://gitlab.com/acme/app', '///', 'acme']) {
        await expect(addRepo(t.ctx, 'RBAD', { repo: garbage }), garbage).rejects.toMatchObject({
          code: 'VALIDATION_FAILED',
          message: expect.stringMatching(match),
        });
        await expect(removeRepo(t.ctx, 'RBAD', garbage), garbage).rejects.toMatchObject({
          code: 'VALIDATION_FAILED',
        });
        await expect(
          createIssue(t.ctx, 'RBAD', { title: 'x', repo: garbage }),
          garbage,
        ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
        await expect(
          updateIssue(t.ctx, issue.key, { repo: garbage }),
          garbage,
        ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
        await expect(
          listIssues(t.ctx, {
            project: 'RBAD',
            filter: { conditions: [{ field: 'repo', op: 'eq', value: garbage }] },
          }),
          garbage,
        ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      }
    });

    it('does not accept a repo that is linked to another project', async () => {
      await createProject(t.ctx, { key: 'RONE', name: 'One' });
      await createProject(t.ctx, { key: 'RTWO', name: 'Two' });
      const theirs = await addRepo(t.ctx, 'RTWO', { repo: 'acme/theirs' });
      await createIssue(t.ctx, 'RTWO', { title: 'in two', repo: theirs.id });
      const mine = await createIssue(t.ctx, 'RONE', { title: 'in one' });
      const message = '"acme/theirs" is not linked to project RONE';

      await expect(
        createIssue(t.ctx, 'RONE', { title: 'bad', repo: 'acme/theirs' }),
      ).rejects.toMatchObject({ code: 'INVALID_RELATION', message });
      await expect(updateIssue(t.ctx, mine.key, { repo: 'acme/theirs' })).rejects.toMatchObject({
        code: 'INVALID_RELATION',
        message,
      });
      // The id of another project's repo is just as foreign.
      await expect(updateIssue(t.ctx, mine.key, { repo: theirs.id })).rejects.toMatchObject({
        code: 'INVALID_RELATION',
      });
      await expect(removeRepo(t.ctx, 'RONE', 'acme/theirs')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      // Filtering project One by Two's repo names it unknown there; by id it matches nothing.
      await expect(
        listIssues(t.ctx, {
          project: 'RONE',
          filter: { conditions: [{ field: 'repo', op: 'eq', value: 'acme/theirs' }] },
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(
        (
          await listIssues(t.ctx, {
            project: 'RONE',
            filter: { conditions: [{ field: 'repo', op: 'eq', value: theirs.id }] },
          })
        ).data,
      ).toEqual([]);
      expect((await getIssue(t.ctx, mine.key)).repo).toBeNull();
    });

    it('clears an issue repo with repo: null, recording the change only when there was one', async () => {
      await createProject(t.ctx, { key: 'RNUL', name: 'Null' });
      await addRepo(t.ctx, 'RNUL', { repo: 'acme/null' });
      const issue = await createIssue(t.ctx, 'RNUL', { title: 'linked', repo: 'acme/null' });
      const cleared = await updateIssue(t.ctx, issue.key, { repo: null });
      expect(cleared.repo).toBeNull();
      expect(cleared.version).toBe(issue.version + 1);
      const updates = (await listIssueActivity(t.ctx, issue.key)).data.filter(
        (e) => e.type === 'issue.updated',
      );
      expect(updates).toHaveLength(1);
      expect(updates[0]!.data).toMatchObject({
        changes: { repo: { from: 'acme/null', to: null } },
      });

      // Already clear: nothing changes, nothing is recorded.
      const again = await updateIssue(t.ctx, issue.key, { repo: null });
      expect(again.version).toBe(cleared.version);
      expect(
        (await listIssueActivity(t.ctx, issue.key)).data.filter((e) => e.type === 'issue.updated'),
      ).toHaveLength(1);
    });

    it('records issue.updated when unlinking clears the repo of a trashed issue', async () => {
      await createProject(t.ctx, { key: 'RTRA', name: 'Trashed' });
      const repo = await addRepo(t.ctx, 'RTRA', { repo: 'acme/gone' });
      const issue = await createIssue(t.ctx, 'RTRA', { title: 'trashed', repo: repo.id });
      await deleteIssue(t.ctx, issue.key);
      const before = await getIssue(t.ctx, issue.key);
      await removeRepo(t.ctx, 'RTRA', repo.id);
      const after = await getIssue(t.ctx, issue.key);
      expect(after).toMatchObject({ repo: null, version: before.version + 1 });
      expect(after.deletedAt).toBe(before.deletedAt);
      const updates = (await listIssueActivity(t.ctx, issue.key)).data.filter(
        (e) => e.type === 'issue.updated',
      );
      expect(updates).toHaveLength(1);
      expect(updates[0]!.data).toMatchObject({
        issue: { key: issue.key, repo: null },
        changes: { repo: { from: 'acme/gone', to: null } },
      });
    });
  });
});
