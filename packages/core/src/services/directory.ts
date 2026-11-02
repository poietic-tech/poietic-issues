import { withWriteTx } from '@poietic-tech/issues-db';
import { CreateUserInputSchema, type User } from '@poietic-tech/issues-schema';
import { nowIso, type ServiceContext } from '../context.ts';
import { diff, recordEvent } from '../events.ts';
import { toUser } from '../mappers.ts';
import { authHandle, freeAuthHandle, type HolderIdentities, isFree } from './handles.ts';
import { freeHandle } from './sso.ts';
import { insertUser, ownerHandle } from './users.ts';

/** One account in the SSO issuer's directory, as its API reports it. */
export interface DirectoryPerson {
  /** The issuer's user id: the same value as the token's `sub`. */
  subject: string;
  name: string;
  /** The issuer's handle (ADR 0031); absent from an issuer that has none. */
  handle?: string | null | undefined;
  avatarUrl: string | null;
  groups: readonly string[];
  kind: 'human' | 'agent';
}

export interface DirectoryApplied {
  /** Users created for member-group humans who had never signed in. */
  created: User[];
  /** Users whose name, handle or avatar changed to match the directory. */
  updated: User[];
}

const NAME_MAX = 100;

const displayName = (name: string, fallback: string) => name.trim().slice(0, NAME_MAX) || fallback;

/** An avatar the tracker can store: an http(s) URL, else none. */
function avatarUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Brings local users in line with the issuer's directory, which owns who people are (ADR 0027). Local rows are its
 * cache: every user already linked to the issuer takes the directory's name, handle and avatar, and a human in
 * `memberGroup` who has never signed in is created as an active member, so they can be assigned before their first
 * visit. Nothing else changes: role and activation stay the tracker's, nobody is deactivated, and agents are only
 * refreshed (they are created on first use, ADR 0023). Takes the write lock only when something differs.
 *
 * Handles are the issuer's (ADR 0031), so they are unique among listed users and can only collide with an account the
 * directory doesn't list: an unlinked one, or one whose identity it no longer has. That account is renamed
 * `<handle>-legacy`. Handles move all at once, so two users can swap theirs in one refresh. A person listed without a
 * handle keeps theirs and is never displaced; whoever wanted it keeps their current handle until the directory agrees.
 */
export async function applyDirectory(
  ctx: ServiceContext,
  people: readonly DirectoryPerson[],
  opts: { issuer: string; memberGroup?: string | undefined },
): Promise<DirectoryApplied> {
  const plan = async (db: ServiceContext['db']['kysely']) => {
    const rows = await db
      .selectFrom('user_identities')
      .innerJoin('users', 'users.id', 'user_identities.user_id')
      .selectAll('users')
      .select('user_identities.subject')
      .where('user_identities.issuer', '=', opts.issuer)
      .execute();
    const known = new Map(rows.map((r) => [r.subject, r]));
    const updates = [];
    const creates = [];
    for (const person of people) {
      const row = known.get(person.subject);
      if (row) {
        const name = displayName(person.name, row.name);
        const handle = authHandle(person.handle) ?? row.handle;
        const avatar = avatarUrl(person.avatarUrl);
        if (name !== row.name || handle !== row.handle || avatar !== row.avatar_url)
          updates.push({ row, name, handle, avatar });
      } else if (
        person.kind === 'human' &&
        opts.memberGroup !== undefined &&
        person.groups.includes(opts.memberGroup)
      )
        creates.push(person);
    }
    return { updates, creates };
  };

  const first = await plan(ctx.db.kysely);
  if (!first.updates.length && !first.creates.length) return { created: [], updated: [] };

  return withWriteTx(ctx.db, async (tx) => {
    const { updates, creates } = await plan(tx);
    const now = nowIso(ctx);
    const listed = new Set(people.map((p) => p.subject));
    const unlisted = (identities: HolderIdentities) =>
      identities.every((i) => i.issuer === opts.issuer && !listed.has(i.subject));
    // Park every moving handle first, so the new ones can land in any order. Never seen outside this transaction.
    const moving = updates.filter((u) => u.handle !== u.row.handle);
    for (const { row } of moving)
      await tx
        .updateTable('users')
        .set({ handle: `~${row.id}` })
        .where('id', '=', row.id)
        .execute();
    const updated: User[] = [];
    for (const { row, name, avatar, ...wanted } of updates) {
      let handle = wanted.handle;
      if (handle !== row.handle && !(await freeAuthHandle(tx, ctx, handle, unlisted)))
        handle = (await isFree(tx, row.handle)) ? row.handle : await freeHandle(tx, handle);
      const owner = await ownerHandle(tx, row.owner_id);
      const before = toUser(row, owner);
      const user = toUser(
        await tx
          .updateTable('users')
          .set({ name, handle, avatar_url: avatar, updated_at: now })
          .where('id', '=', row.id)
          .returningAll()
          .executeTakeFirstOrThrow(),
        owner,
      );
      await recordEvent(tx, ctx, 'user.updated', {
        data: { user, changes: diff(before, user, ['name', 'handle', 'avatarUrl']) },
      });
      updated.push(user);
    }
    const created: User[] = [];
    for (const person of creates) {
      const wanted = authHandle(person.handle);
      const data = CreateUserInputSchema.parse({
        handle:
          wanted && (await freeAuthHandle(tx, ctx, wanted, unlisted))
            ? wanted
            : await freeHandle(tx, wanted ?? person.name),
        name: displayName(person.name, 'User'),
        kind: 'human',
        role: 'member',
        avatarUrl: avatarUrl(person.avatarUrl),
      });
      const user = await insertUser(tx, ctx, data);
      await tx
        .insertInto('user_identities')
        .values({ issuer: opts.issuer, subject: person.subject, user_id: user.id, created_at: now })
        .execute();
      created.push(user);
    }
    return { created, updated };
  });
}
