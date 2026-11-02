import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDialect } from '@poietic-tech/issues-db/testing';
import { SYSTEM_ACTOR, withActor } from '../context.ts';
import { createTestContext, type TestContext } from '../testing.ts';
import { applyDirectory, type DirectoryPerson } from './directory.ts';
import { listEvents } from './events.ts';
import { signInWithSso, type SsoIdentity } from './sso.ts';
import { createUserUnchecked, getUser } from './users.ts';

const ISS = 'https://auth.example.test';
let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.destroy());

const sys = () => withActor(t.ctx, SYSTEM_ACTOR);
const signIn = (subject: string, over: Partial<SsoIdentity> = {}) =>
  signInWithSso(
    sys(),
    {
      issuer: ISS,
      subject,
      name: `Person ${subject}`,
      role: 'admin',
      groups: [],
      kind: 'human',
      owner: null,
      ...over,
    },
    { adminRole: 'admin' },
  );
const person = (subject: string, over: Partial<DirectoryPerson> = {}): DirectoryPerson => ({
  subject,
  name: `Person ${subject}`,
  avatarUrl: null,
  groups: [],
  kind: 'human',
  ...over,
});
const refresh = (people: DirectoryPerson[]) => applyDirectory(sys(), people, { issuer: ISS });
const legacy = (handle: string) => createUserUnchecked(sys(), { handle, name: `Legacy ${handle}` });
const handleChanges = async (userId: string) =>
  (await listEvents(sys(), { types: ['user.updated'], limit: 1000 })).data
    .filter((e) => (e.data as { user: { id: string } }).user.id === userId)
    .map((e) => (e.data as { changes?: { handle?: unknown } }).changes?.handle)
    .filter(Boolean);

describe(`handles from auth at sign-in (${testDialect()})`, () => {
  it("takes the token's handle for a new identity instead of deriving one", async () => {
    const r = await signIn('s1', { name: 'Ada Lovelace', handle: 'countess' });
    expect(r.user.handle).toBe('countess');
  });

  it('derives a handle as before when the token has none', async () => {
    const r = await signIn('s2', { name: 'Brin Derived' });
    expect(r.user.handle).toBe('brin-derived');
  });

  it('derives a handle when the claim is not a valid handle', async () => {
    const r = await signIn('s3', { name: 'Cleo Invalid', handle: '-nope' });
    expect(r.user.handle).toBe('cleo-invalid');
  });

  it('renames an unlinked account holding the handle to <handle>-legacy, recording it', async () => {
    const old = await legacy('claude');
    const r = await signIn('s4', { name: 'Claude', handle: 'claude' });
    expect(r.user.handle).toBe('claude');
    expect((await getUser(sys(), old.id)).handle).toBe('claude-legacy');
    expect(await handleChanges(old.id)).toEqual([{ from: 'claude', to: 'claude-legacy' }]);
  });

  it('counts up when <handle>-legacy is taken too', async () => {
    await legacy('dot-legacy');
    const old = await legacy('dot');
    await signIn('s5', { handle: 'dot' });
    expect((await getUser(sys(), old.id)).handle).toBe('dot-legacy-2');
  });

  it('clips a long handle so the legacy suffix fits', async () => {
    const long = 'l'.repeat(39);
    const old = await legacy(long);
    await signIn('s6', { handle: long });
    const renamed = (await getUser(sys(), old.id)).handle;
    expect(renamed).toBe(`${'l'.repeat(32)}-legacy`);
  });

  it('leaves a linked holder alone and suffixes the newcomer until a refresh settles it', async () => {
    const holder = await signIn('s7', { handle: 'emma' });
    const r = await signIn('s8', { handle: 'emma' });
    expect(r.user.handle).toBe('emma-2');
    expect((await getUser(sys(), holder.user.id)).handle).toBe('emma');
  });

  it("follows a known identity's renamed handle, recording the change", async () => {
    const first = await signIn('s9', { handle: 'finn' });
    const again = await signIn('s9', { handle: 'finnegan' });
    expect(again.user).toMatchObject({ id: first.user.id, handle: 'finnegan' });
    expect(await handleChanges(first.user.id)).toEqual([{ from: 'finn', to: 'finnegan' }]);
  });

  it('keeps a known handle when the token has none', async () => {
    const first = await signIn('s10', { handle: 'gus' });
    const again = await signIn('s10');
    expect(again.user.handle).toBe('gus');
    expect(first.user.id).toBe(again.user.id);
  });

  it("keeps a known handle when the new one is a linked user's", async () => {
    await signIn('s11', { handle: 'hana' });
    const other = await signIn('s12', { handle: 'ivo' });
    const again = await signIn('s12', { handle: 'hana' });
    expect(again.user).toMatchObject({ id: other.user.id, handle: 'ivo' });
  });
});

describe(`handles from the directory (${testDialect()})`, () => {
  it("copies a linked user's handle and records it with the other changes", async () => {
    const u = (await signIn('d1', { handle: 'jade' })).user;
    const r = await refresh([person('d1', { name: 'Jade Renamed', handle: 'jade-r' })]);
    expect(r.updated).toHaveLength(1);
    expect(r.updated[0]).toMatchObject({ id: u.id, handle: 'jade-r', name: 'Jade Renamed' });
    expect(await handleChanges(u.id)).toEqual([{ from: 'jade', to: 'jade-r' }]);
  });

  it('swaps the handles of two linked users in one refresh', async () => {
    const a = (await signIn('d2', { handle: 'kai' })).user;
    const b = (await signIn('d3', { handle: 'lou' })).user;
    await refresh([person('d2', { handle: 'lou' }), person('d3', { handle: 'kai' })]);
    expect((await getUser(sys(), a.id)).handle).toBe('lou');
    expect((await getUser(sys(), b.id)).handle).toBe('kai');
  });

  it("settles a newcomer's suffix once the holder's rename reaches the directory", async () => {
    const holder = (await signIn('d4', { handle: 'max' })).user;
    const newcomer = (await signIn('d5', { handle: 'max' })).user;
    expect(newcomer.handle).toBe('max-2');
    await refresh([person('d4', { handle: 'maxwell' }), person('d5', { handle: 'max' })]);
    expect((await getUser(sys(), holder.id)).handle).toBe('maxwell');
    expect((await getUser(sys(), newcomer.id)).handle).toBe('max');
  });

  it('renames an unlinked holder, and a linked one the directory no longer lists, to -legacy', async () => {
    const old = await legacy('nia');
    const gone = (await signIn('d6', { handle: 'oto' })).user;
    const a = (await signIn('d7', { handle: 'nia-x' })).user;
    const b = (await signIn('d8', { handle: 'oto-x' })).user;
    await refresh([person('d7', { handle: 'nia' }), person('d8', { handle: 'oto' })]);
    expect((await getUser(sys(), a.id)).handle).toBe('nia');
    expect((await getUser(sys(), b.id)).handle).toBe('oto');
    expect((await getUser(sys(), old.id)).handle).toBe('nia-legacy');
    expect((await getUser(sys(), gone.id)).handle).toBe('oto-legacy');
  });

  it('never displaces a listed user that has no handle from the directory', async () => {
    const holder = (await signIn('d9', { handle: 'pia' })).user;
    const other = (await signIn('d10', { handle: 'quin' })).user;
    await refresh([person('d9'), person('d10', { handle: 'pia' })]);
    expect((await getUser(sys(), holder.id)).handle).toBe('pia');
    expect((await getUser(sys(), other.id)).handle).toBe('quin');
  });

  it('creates a member-group human with the directory handle', async () => {
    const r = await applyDirectory(
      sys(),
      [person('d11', { name: 'Rae Created', handle: 'rae', groups: ['crew'] })],
      { issuer: ISS, memberGroup: 'crew' },
    );
    expect(r.created[0]?.handle).toBe('rae');
  });

  it('changes nothing when every handle already matches', async () => {
    await signIn('d12', { name: 'Sol Same', handle: 'sol' });
    const r = await refresh([person('d12', { name: 'Sol Same', handle: 'sol' })]);
    expect(r).toEqual({ created: [], updated: [] });
  });
});
