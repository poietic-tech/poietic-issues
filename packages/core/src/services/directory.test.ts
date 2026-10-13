import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDialect } from '@poietic-tech/issues-db/testing';
import { SYSTEM_ACTOR, withActor } from '../context.ts';
import { createTestContext, type TestContext } from '../testing.ts';
import { applyDirectory, type DirectoryPerson } from './directory.ts';
import { signInWithSso } from './sso.ts';
import { updateUser } from './users.ts';

const ISS = 'https://auth.example.test';
let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.destroy());

const sys = () => withActor(t.ctx, SYSTEM_ACTOR);
const opts = { issuer: ISS, memberGroup: 'crew' };
const person = (subject: string, over: Partial<DirectoryPerson> = {}): DirectoryPerson => ({
  subject,
  name: `Person ${subject}`,
  avatarUrl: null,
  groups: ['crew'],
  kind: 'human',
  ...over,
});
const signIn = (subject: string, name: string, role = 'user') =>
  signInWithSso(
    sys(),
    { issuer: ISS, subject, name, role, groups: [], kind: 'human', owner: null },
    { adminRole: 'admin' },
  );
const events = async (type: string, userId: string) =>
  (await t.db.kysely.selectFrom('events').select('data').where('type', '=', type).execute()).filter(
    (e) => e.data.includes(userId),
  ).length;

describe(`applyDirectory (${testDialect()})`, () => {
  it('creates a member-group human who has never signed in, whom sign-in then finds', async () => {
    const r = await applyDirectory(
      sys(),
      [person('d1', { name: 'Dana Directory', avatarUrl: 'https://img.example/d1.png' })],
      opts,
    );
    expect(r.created).toHaveLength(1);
    expect(r.created[0]).toMatchObject({
      handle: 'dana-directory',
      name: 'Dana Directory',
      avatarUrl: 'https://img.example/d1.png',
      kind: 'human',
      role: 'member',
      deactivatedAt: null,
    });
    const later = await signIn('d1', 'Dana Directory');
    expect(later).toMatchObject({ status: 'active', user: { id: r.created[0]!.id } });
  });

  it('creates nobody outside the group, no agents, and nobody without a member group', async () => {
    const r = await applyDirectory(
      sys(),
      [person('d2', { groups: ['other'] }), person('d3', { kind: 'agent' })],
      opts,
    );
    expect(r.created).toEqual([]);
    expect((await applyDirectory(sys(), [person('d4')], { issuer: ISS })).created).toEqual([]);
  });

  it("refreshes a known user's name and avatar, records user.updated, and is idempotent", async () => {
    const { user } = await signIn('d5', 'Old Name');
    const r = await applyDirectory(
      sys(),
      [person('d5', { name: 'New Name', avatarUrl: 'https://img.example/d5.png', groups: [] })],
      opts,
    );
    expect(r.updated.map((u) => u.id)).toEqual([user.id]);
    expect(r.updated[0]).toMatchObject({
      name: 'New Name',
      avatarUrl: 'https://img.example/d5.png',
      handle: user.handle,
    });
    expect(await events('user.updated', user.id)).toBe(1);
    expect(
      await applyDirectory(
        sys(),
        [person('d5', { name: 'New Name', avatarUrl: 'https://img.example/d5.png' })],
        opts,
      ),
    ).toEqual({ created: [], updated: [] });
    expect(await events('user.updated', user.id)).toBe(1);
  });

  it('never changes role or activation, and leaves other issuers alone', async () => {
    const admin = await signIn('d6', 'Admin Person', 'admin');
    const pending = await signIn('d7', 'Pending Person');
    await updateUser(t.ctx, admin.user.id, { deactivated: true });
    const r = await applyDirectory(
      sys(),
      [person('d6', { name: 'Admin Renamed' }), person('d7', { name: 'Pending Renamed' })],
      opts,
    );
    expect(r.updated).toEqual([
      expect.objectContaining({ role: 'admin', deactivatedAt: expect.any(String) }),
      expect.objectContaining({ role: 'member', deactivatedAt: expect.any(String) }),
    ]);
    expect(pending.status).toBe('pending');
    const other = await applyDirectory(sys(), [person('d6', { name: 'Elsewhere' })], {
      issuer: 'https://other.test',
    });
    expect(other).toEqual({ created: [], updated: [] });
  });

  it('keeps the local name for a blank directory name and drops an unusable avatar', async () => {
    const { user } = await signIn('d8', 'Kept Name');
    const r = await applyDirectory(
      sys(),
      [person('d8', { name: '   ', avatarUrl: 'javascript:alert(1)' })],
      opts,
    );
    expect(r.updated).toEqual([]);
    expect(user.name).toBe('Kept Name');
  });
});
