import { withWriteTx } from '@poietic-tech/issues-db';
import { CreateUserInputSchema, type User } from '@poietic-tech/issues-schema';
import { nowIso, type ServiceContext } from '../context.ts';
import { toUser } from '../mappers.ts';
import { insertUser } from './users.ts';

/** A verified identity from an SSO issuer's token. */
export interface SsoIdentity {
  issuer: string;
  subject: string;
  /** Display name from the token; used only when the user is first created. */
  name: string;
  /** The issuer's role claim; equal to `adminRole` makes a new user an active admin. */
  role: string;
  /** The issuer's group slugs. Carried for group-based approval (issue #16); not used to grant access yet. */
  groups: readonly string[];
}

export interface SsoSignIn {
  user: User;
  /** `pending` until an admin reactivates the user. */
  status: 'active' | 'pending';
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
 * later sign-ins never re-derive privilege from the token. New non-admin users start deactivated (pending).
 */
export async function signInWithSso(
  ctx: ServiceContext,
  identity: SsoIdentity,
  opts: { adminRole: string },
): Promise<SsoSignIn> {
  const result = (
    row: { deactivated_at: string | null } & Parameters<typeof toUser>[0],
  ): SsoSignIn => ({
    user: toUser(row),
    status: row.deactivated_at ? 'pending' : 'active',
  });

  return withWriteTx(ctx.db, async (tx) => {
    const known = await tx
      .selectFrom('user_identities')
      .innerJoin('users', 'users.id', 'user_identities.user_id')
      .selectAll('users')
      .where('user_identities.issuer', '=', identity.issuer)
      .where('user_identities.subject', '=', identity.subject)
      .executeTakeFirst();
    if (known) return result(known);

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

    const admin = identity.role === opts.adminRole;
    const data = CreateUserInputSchema.parse({
      handle,
      name: identity.name.trim().slice(0, 100) || 'User',
      kind: 'human',
      role: admin ? 'admin' : 'member',
    });
    const user = await insertUser(tx, ctx, data, { deactivated: !admin });
    await tx
      .insertInto('user_identities')
      .values({
        issuer: identity.issuer,
        subject: identity.subject,
        user_id: user.id,
        created_at: nowIso(ctx),
      })
      .execute();
    return { user, status: admin ? 'active' : 'pending' };
  });
}
