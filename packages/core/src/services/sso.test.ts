import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDialect } from '@poietic-tech/issues-db/testing';
import { SYSTEM_ACTOR, withActor } from '../context.ts';
import { createTestContext, type TestContext } from '../testing.ts';
import { createComment, listComments } from './comments.ts';
import { listEvents } from './events.ts';
import { createIssue, getIssue } from './issues.ts';
import { addMember, listMembers } from './members.ts';
import { createProject } from './projects.ts';
import { handleFromName, signInWithSso } from './sso.ts';
import { getUser, listUsers, toActor, updateUser } from './users.ts';

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
      {
        issuer: ISS,
        subject: 'u1',
        name: 'Grace Hopper',
        role: 'user',
        groups: [],
        kind: 'human',
        owner: null,
      },
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
      {
        issuer: ISS,
        subject: 'a1',
        name: 'Boss',
        role: 'admin',
        groups: [],
        kind: 'human',
        owner: null,
      },
      opts,
    );
    expect(r.status).toBe('active');
    expect(r.user).toMatchObject({ handle: 'boss', role: 'admin' });
    expect(r.user.deactivatedAt).toBeNull();
  });

  it('returns the same user for a known identity and never changes name or role', async () => {
    const first = await signInWithSso(
      sys(),
      {
        issuer: ISS,
        subject: 'k1',
        name: 'Kay',
        role: 'admin',
        groups: [],
        kind: 'human',
        owner: null,
      },
      opts,
    );
    const again = await signInWithSso(
      sys(),
      {
        issuer: ISS,
        subject: 'k1',
        name: 'Renamed',
        role: 'user',
        groups: [],
        kind: 'human',
        owner: null,
      },
      opts,
    );
    expect(again.user.id).toBe(first.user.id);
    expect(again.user).toMatchObject({ name: 'Kay', role: 'admin' });
    expect(again.status).toBe('active');
  });

  it('keeps an identity pending until an admin reactivates the user', async () => {
    const p = await signInWithSso(
      sys(),
      {
        issuer: ISS,
        subject: 'p1',
        name: 'Pat',
        role: 'user',
        groups: [],
        kind: 'human',
        owner: null,
      },
      opts,
    );
    expect(
      (
        await signInWithSso(
          sys(),
          {
            issuer: ISS,
            subject: 'p1',
            name: 'Pat',
            role: 'user',
            groups: [],
            kind: 'human',
            owner: null,
          },
          opts,
        )
      ).status,
    ).toBe('pending');
    await updateUser(t.ctx, p.user.id, { deactivated: false });
    expect(
      (
        await signInWithSso(
          sys(),
          {
            issuer: ISS,
            subject: 'p1',
            name: 'Pat',
            role: 'user',
            groups: [],
            kind: 'human',
            owner: null,
          },
          opts,
        )
      ).status,
    ).toBe('active');
  });

  it('suffixes handles that are taken, and separates issuers', async () => {
    // 'member' and 'admin' exist from createTestContext.
    const r = await signInWithSso(
      sys(),
      {
        issuer: ISS,
        subject: 'm1',
        name: 'Member',
        role: 'user',
        groups: [],
        kind: 'human',
        owner: null,
      },
      opts,
    );
    expect(r.user.handle).toBe('member-2');
    const other = await signInWithSso(
      sys(),
      {
        issuer: 'https://other.test',
        subject: 'm1',
        name: 'Member',
        role: 'user',
        groups: [],
        kind: 'human',
        owner: null,
      },
      opts,
    );
    expect(other.user.id).not.toBe(r.user.id);
    expect(other.user.handle).toBe('member-3');
  });

  it('creates a user named User from a whitespace-only name, never a reserved handle', async () => {
    const blank = await signInWithSso(
      sys(),
      {
        issuer: ISS,
        subject: 'blank',
        name: '   ',
        role: 'user',
        groups: [],
        kind: 'human',
        owner: null,
      },
      opts,
    );
    expect(blank.user.name).toBe('User');
    const me = await signInWithSso(
      sys(),
      {
        issuer: ISS,
        subject: 'me1',
        name: 'Me',
        role: 'user',
        groups: [],
        kind: 'human',
        owner: null,
      },
      opts,
    );
    expect(me.user.handle).not.toBe('me');
    expect(me.user.handle).toMatch(/^user(-\d+)?$/);
  });

  it('records a user.created event', async () => {
    const r = await signInWithSso(
      sys(),
      {
        issuer: ISS,
        subject: 'e1',
        name: 'Evie',
        role: 'user',
        groups: [],
        kind: 'human',
        owner: null,
      },
      opts,
    );
    const evs = await t.db.kysely
      .selectFrom('events')
      .select(['type', 'data'])
      .where('type', '=', 'user.created')
      .execute();
    expect(evs.some((e) => e.data.includes(r.user.id))).toBe(true);
  });

  describe('agents', () => {
    const human = (subject: string, name: string, role = 'user') =>
      ({ issuer: ISS, subject, name, role, groups: [], kind: 'human', owner: null }) as const;
    const agent = (subject: string, owner: string, name = 'Helper', role = 'user') =>
      ({ issuer: ISS, subject, name, role, groups: [], kind: 'agent', owner }) as const;

    it('creates an agent of an active owner as an active member owned by that user', async () => {
      const owner = await signInWithSso(sys(), human('o1', 'Olive', 'admin'), opts);
      const r = await signInWithSso(sys(), agent('ag1', 'o1', 'Olive bot', 'admin'), opts);
      expect(r.status).toBe('active');
      expect(r.user).toMatchObject({
        kind: 'agent',
        role: 'member', // an agent's role claim never makes it an admin
        handle: 'olive-bot',
        ownerId: owner.user.id,
        deactivatedAt: null,
      });
      expect(owner.user.ownerId).toBeNull();
      const again = await signInWithSso(sys(), agent('ag1', 'o1'), opts);
      expect(again).toMatchObject({ status: 'active', user: { id: r.user.id } });
    });

    it('creates an agent of a pending owner as pending', async () => {
      const owner = await signInWithSso(sys(), human('o2', 'Pending Pat'), opts);
      expect(owner.status).toBe('pending');
      const r = await signInWithSso(sys(), agent('ag2', 'o2'), opts);
      expect(r.status).toBe('pending');
      expect(r.user.deactivatedAt).not.toBeNull();
      expect((await signInWithSso(sys(), agent('ag2', 'o2'), opts)).status).toBe('pending');
    });

    it('refuses an agent whose owner has never signed in, and creates nothing', async () => {
      await expect(signInWithSso(sys(), agent('ag3', 'nobody'), opts)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      const row = await t.db.kysely
        .selectFrom('user_identities')
        .select('user_id')
        .where('subject', '=', 'ag3')
        .executeTakeFirst();
      expect(row).toBeUndefined();
    });

    it('stops a known agent while its owner is deactivated', async () => {
      const owner = await signInWithSso(sys(), human('o4', 'Otto', 'admin'), opts);
      expect((await signInWithSso(sys(), agent('ag4', 'o4'), opts)).status).toBe('active');
      await updateUser(t.ctx, owner.user.id, { deactivated: true });
      expect((await signInWithSso(sys(), agent('ag4', 'o4'), opts)).status).toBe('owner_inactive');
      await updateUser(t.ctx, owner.user.id, { deactivated: false });
      expect((await signInWithSso(sys(), agent('ag4', 'o4'), opts)).status).toBe('active');
    });

    it("names the agent's owner wherever the agent appears", async () => {
      const owner = await signInWithSso(sys(), human('o5', 'Opal', 'admin'), opts);
      const bot = await signInWithSso(sys(), agent('ag5', 'o5', 'Opal bot'), opts);
      const ref = { id: owner.user.id, handle: 'opal' };
      expect(bot.user.owner).toEqual(ref);
      expect(owner.user.owner).toBeNull();

      await createProject(t.ctx, { key: 'OWN', name: 'Owners' });
      await addMember(t.ctx, 'OWN', { user: bot.user.id, role: 'editor' });
      const botCtx = withActor(t.ctx, toActor(bot.user));
      const issue = await createIssue(botCtx, 'OWN', { title: 'Hi', assignee: bot.user.id });
      await createComment(botCtx, issue.key, { body: 'On it' });

      const fetched = await getIssue(t.ctx, issue.key);
      expect(fetched.creator.owner).toEqual(ref);
      expect(fetched.assignee?.owner).toEqual(ref);
      const [comment] = await listComments(t.ctx, issue.key);
      expect(comment!.author.owner).toEqual(ref);
      const members = await listMembers(t.ctx, 'OWN');
      expect(members.find((m) => m.user.id === bot.user.id)!.user.owner).toEqual(ref);
      const events = (await listEvents(t.ctx, { limit: 1000 })).data;
      expect(events.find((e) => e.actorId === bot.user.id)!.actor!.owner).toEqual(ref);
      expect((await getUser(t.ctx, bot.user.id)).owner).toEqual(ref);
      const users = await listUsers(t.ctx);
      expect(users.find((u) => u.id === bot.user.id)!.owner).toEqual(ref);
      expect(users.find((u) => u.id === owner.user.id)!.owner).toBeNull();
    });
  });
});
