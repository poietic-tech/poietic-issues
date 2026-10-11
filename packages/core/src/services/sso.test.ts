import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDialect } from '@poietic-tech/issues-db/testing';
import { SYSTEM_ACTOR, withActor } from '../context.ts';
import { createTestContext, type TestContext } from '../testing.ts';
import { handleFromName, signInWithSso } from './sso.ts';
import { updateUser } from './users.ts';

const ISS = 'https://auth.example.test';
let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.destroy());

const sys = () => withActor(t.ctx, SYSTEM_ACTOR);
const opts = { adminRole: 'admin' };

describe('handleFromName', () => {
  it('slugifies names into valid handles', () => {
    expect(handleFromName('Ada Lovelace')).toBe('ada-lovelace');
    expect(handleFromName('  Zoë  Ünder_score ')).toBe('zoe-under_score');
    expect(handleFromName('李')).toBe('user');
    expect(handleFromName('x')).toBe('user');
    expect(handleFromName('Me')).toBe('user');
    expect(handleFromName('SYSTEM')).toBe('user');
    expect(handleFromName('a'.repeat(80))).toHaveLength(30);
  });
});

describe(`signInWithSso (${testDialect()})`, () => {
  it('creates an unknown non-admin identity as a pending member', async () => {
    const r = await signInWithSso(
      sys(),
      { issuer: ISS, subject: 'u1', name: 'Grace Hopper', role: 'user', groups: [] },
      opts,
    );
    expect(r.status).toBe('pending');
    expect(r.user).toMatchObject({
      handle: 'grace-hopper',
      name: 'Grace Hopper',
      role: 'member',
      kind: 'human',
    });
    expect(r.user.deactivatedAt).not.toBeNull();
  });

  it('creates an unknown admin-role identity as an active admin', async () => {
    const r = await signInWithSso(
      sys(),
      { issuer: ISS, subject: 'a1', name: 'Boss', role: 'admin', groups: [] },
      opts,
    );
    expect(r.status).toBe('active');
    expect(r.user).toMatchObject({ handle: 'boss', role: 'admin' });
    expect(r.user.deactivatedAt).toBeNull();
  });

  it('returns the same user for a known identity and never changes name or role', async () => {
    const first = await signInWithSso(
      sys(),
      { issuer: ISS, subject: 'k1', name: 'Kay', role: 'admin', groups: [] },
      opts,
    );
    const again = await signInWithSso(
      sys(),
      { issuer: ISS, subject: 'k1', name: 'Renamed', role: 'user', groups: [] },
      opts,
    );
    expect(again.user.id).toBe(first.user.id);
    expect(again.user).toMatchObject({ name: 'Kay', role: 'admin' });
    expect(again.status).toBe('active');
  });

  it('keeps an identity pending until an admin reactivates the user', async () => {
    const p = await signInWithSso(
      sys(),
      { issuer: ISS, subject: 'p1', name: 'Pat', role: 'user', groups: [] },
      opts,
    );
    expect(
      (
        await signInWithSso(
          sys(),
          { issuer: ISS, subject: 'p1', name: 'Pat', role: 'user', groups: [] },
          opts,
        )
      ).status,
    ).toBe('pending');
    await updateUser(t.ctx, p.user.id, { deactivated: false });
    expect(
      (
        await signInWithSso(
          sys(),
          { issuer: ISS, subject: 'p1', name: 'Pat', role: 'user', groups: [] },
          opts,
        )
      ).status,
    ).toBe('active');
  });

  it('suffixes handles that are taken, and separates issuers', async () => {
    // 'member' and 'admin' exist from createTestContext.
    const r = await signInWithSso(
      sys(),
      { issuer: ISS, subject: 'm1', name: 'Member', role: 'user', groups: [] },
      opts,
    );
    expect(r.user.handle).toBe('member-2');
    const other = await signInWithSso(
      sys(),
      { issuer: 'https://other.test', subject: 'm1', name: 'Member', role: 'user', groups: [] },
      opts,
    );
    expect(other.user.id).not.toBe(r.user.id);
    expect(other.user.handle).toBe('member-3');
  });

  it('creates a user named User from a whitespace-only name, never a reserved handle', async () => {
    const blank = await signInWithSso(
      sys(),
      { issuer: ISS, subject: 'blank', name: '   ', role: 'user', groups: [] },
      opts,
    );
    expect(blank.user.name).toBe('User');
    const me = await signInWithSso(
      sys(),
      { issuer: ISS, subject: 'me1', name: 'Me', role: 'user', groups: [] },
      opts,
    );
    expect(me.user.handle).not.toBe('me');
    expect(me.user.handle).toMatch(/^user(-\d+)?$/);
  });

  it('records a user.created event', async () => {
    const r = await signInWithSso(
      sys(),
      { issuer: ISS, subject: 'e1', name: 'Evie', role: 'user', groups: [] },
      opts,
    );
    const evs = await t.db.kysely
      .selectFrom('events')
      .select(['type', 'data'])
      .where('type', '=', 'user.created')
      .execute();
    expect(evs.some((e) => e.data.includes(r.user.id))).toBe(true);
  });
});
