import { type Tx, withWriteTx } from '@poietic-tech/issues-db';
import { CreateUserInputSchema, type User } from '@poietic-tech/issues-schema';
import { nowIso, type ServiceContext } from '../context.ts';
import { forbidden } from '../errors.ts';
import { toUser } from '../mappers.ts';
import { insertUser } from './users.ts';

/** A verified identity from an SSO issuer's token. */
export interface SsoIdentity {
  issuer: string;
  subject: string;
  /** Display name from the token; used only when the user is first created. */
  name: string;
  /** The issuer's role claim; equal to `adminRole` makes a new human an active admin. Ignored for agents. */
  role: string;
  /** The issuer's group slugs. Carried for group-based approval (issue #16); not used to grant access yet. */
  groups: readonly string[];
  /** A person, or an agent acting for one (ADR 0023). */
  kind: 'human' | 'agent';
  /** For an agent, the owner's subject at the same issuer; null for a person. */
  owner: string | null;
}

export interface SsoSignIn {
  user: User;
  /**
   * `pending` until an admin reactivates the user. `owner_inactive`: an agent whose owner is deactivated, so it
   * may not act until the owner is reactivated.
   */
  status: 'active' | 'pending' | 'owner_inactive';
}

const HANDLE_MAX = 30;
/** Handles that resolve to something else (`me` is the actor, `system` the system user). */
const RESERVED_HANDLES = new Set(['me', 'system']);

/** Derives a handle from a display name: lowercase ASCII letters, digits, `-` and `_`; `user` if nothing usable remains. */
export function handleFromName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, HANDLE_MAX)
    .replace(/[-_]+$/, '');
  return slug.length >= 2 && !RESERVED_HANDLES.has(slug) ? slug : 'user';
}

/**
 * Maps an SSO identity to its poietic-issues user, creating one on first sign-in. Role and name are fixed at creation:
 * later sign-ins never re-derive privilege from the token. New non-admin humans start deactivated (pending).
 *
 * An agent becomes a `kind: 'agent'` member owned by the user its `owner` subject maps to, active exactly when that
 * owner is. An agent whose owner has never signed in is refused, so there are no orphan agents. A known agent may act
 * only while both it and its owner are active.
 */
export async function signInWithSso(
  ctx: ServiceContext,
  identity: SsoIdentity,
  opts: { adminRole: string },
): Promise<SsoSignIn> {
  // Every identity-token request lands here, so a known identity is resolved without taking the write lock.
  const known = await findIdentity(ctx.db.kysely, identity);
  if (known) return known;
  return withWriteTx(ctx.db, async (tx) => {
    const raced = await findIdentity(tx, identity);
    if (raced) return raced;

    let owner: { id: string; deactivated_at: string | null } | undefined;
    if (identity.kind === 'agent') {
      owner = await tx
        .selectFrom('user_identities')
        .innerJoin('users', 'users.id', 'user_identities.user_id')
        .select(['users.id', 'users.deactivated_at'])
        .where('user_identities.issuer', '=', identity.issuer)
        .where('user_identities.subject', '=', identity.owner ?? '')
        .executeTakeFirst();
      if (!owner)
        throw forbidden(
          "This agent's owner has never signed in here. The owner must sign in before their agents can act.",
        );
    }

    const base = handleFromName(identity.name);
    const taken = new Set(
      (
        await tx
          .selectFrom('users')
          .select('handle')
          .where((eb) => eb.or([eb('handle', '=', base), eb('handle', 'like', `${base}-%`)]))
          .execute()
      ).map((r) => r.handle.toLowerCase()),
    );
    let handle = base;
    for (let n = 2; taken.has(handle); n++) handle = `${base}-${n}`;

    const admin = identity.kind === 'human' && identity.role === opts.adminRole;
    const active = owner ? !owner.deactivated_at : admin;
    const data = CreateUserInputSchema.parse({
      handle,
      name: identity.name.trim().slice(0, 100) || (owner ? 'Agent' : 'User'),
      kind: identity.kind,
      role: admin ? 'admin' : 'member',
    });
    const user = await insertUser(tx, ctx, data, {
      deactivated: !active,
      ...(owner && { ownerId: owner.id }),
    });
    await tx
      .insertInto('user_identities')
      .values({
        issuer: identity.issuer,
        subject: identity.subject,
        user_id: user.id,
        created_at: nowIso(ctx),
      })
      .execute();
    return { user, status: active ? 'active' : owner ? 'owner_inactive' : 'pending' };
  });
}

async function findIdentity(
  db: Tx,
  identity: Pick<SsoIdentity, 'issuer' | 'subject'>,
): Promise<SsoSignIn | undefined> {
  const row = await db
    .selectFrom('user_identities')
    .innerJoin('users', 'users.id', 'user_identities.user_id')
    .leftJoin('users as owners', 'owners.id', 'users.owner_id')
    .selectAll('users')
    .select('owners.deactivated_at as owner_deactivated_at')
    .where('user_identities.issuer', '=', identity.issuer)
    .where('user_identities.subject', '=', identity.subject)
    .executeTakeFirst();
  if (!row) return undefined;
  const { owner_deactivated_at, ...user } = row;
  return {
    user: toUser(user),
    status: user.deactivated_at ? 'pending' : owner_deactivated_at ? 'owner_inactive' : 'active',
  };
}
