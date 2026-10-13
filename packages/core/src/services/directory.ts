import { withWriteTx } from '@poietic-tech/issues-db';
import { CreateUserInputSchema, type User } from '@poietic-tech/issues-schema';
import { nowIso, type ServiceContext } from '../context.ts';
import { diff, recordEvent } from '../events.ts';
import { toUser } from '../mappers.ts';
import { freeHandle } from './sso.ts';
import { insertUser, ownerHandle } from './users.ts';

/** One account in the SSO issuer's directory, as its API reports it. */
export interface DirectoryPerson {
  /** The issuer's user id: the same value as the token's `sub`. */
  subject: string;
  name: string;
  avatarUrl: string | null;
  groups: readonly string[];
  kind: 'human' | 'agent';
}

export interface DirectoryApplied {
  /** Users created for member-group humans who had never signed in. */
  created: User[];
  /** Users whose name or avatar changed to match the directory. */
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
 * cache: every user already linked to the issuer takes the directory's name and avatar, and a human in `memberGroup`
 * who has never signed in is created as an active member, so they can be assigned before their first visit. Nothing
 * else changes: role, activation and handle stay the tracker's, nobody is deactivated, and agents are only refreshed
 * (they are created on first use, ADR 0023). Takes the write lock only when something differs.
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
        const avatar = avatarUrl(person.avatarUrl);
        if (name !== row.name || avatar !== row.avatar_url) updates.push({ row, name, avatar });
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
    const updated: User[] = [];
    for (const { row, name, avatar } of updates) {
      const owner = await ownerHandle(tx, row.owner_id);
      const before = toUser(row, owner);
      const user = toUser(
        await tx
          .updateTable('users')
          .set({ name, avatar_url: avatar, updated_at: now })
          .where('id', '=', row.id)
          .returningAll()
          .executeTakeFirstOrThrow(),
        owner,
      );
      await recordEvent(tx, ctx, 'user.updated', {
        data: { user, changes: diff(before, user, ['name', 'avatarUrl']) },
      });
      updated.push(user);
    }
    const created: User[] = [];
    for (const person of creates) {
      const data = CreateUserInputSchema.parse({
        handle: await freeHandle(tx, person.name),
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
