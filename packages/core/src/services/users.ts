import { type Tx, withWriteTx } from '@poietic-tech/issues-db';
import {
  type CreateUserInput,
  CreateUserInputSchema,
  type UpdateUserInput,
  UpdateUserInputSchema,
  type User,
} from '@poietic-tech/issues-schema';
import type { z } from 'zod';
import { type Actor, nowIso, type ServiceContext } from '../context.ts';
import { conflict, forbidden, isUniqueViolation, parseInput } from '../errors.ts';
import { diff, recordEvent } from '../events.ts';
import { toUser } from '../mappers.ts';
import { isAdmin, requireAdmin, requireSignedIn } from '../permissions.ts';
import { getUserRow } from '../refs.ts';

export function toActor(user: Pick<User, 'id' | 'handle' | 'name' | 'kind' | 'role'>): Actor {
  return { id: user.id, handle: user.handle, name: user.name, kind: user.kind, role: user.role };
}

/** Emails are private: only admins and the user themselves see them. */
function redact(ctx: ServiceContext, u: User): User {
  return isAdmin(ctx) || u.id === ctx.actor.id ? u : { ...u, email: null };
}

/** Lists users. Deactivated users are included only when asked. */
export async function listUsers(
  ctx: ServiceContext,
  opts: { includeDeactivated?: boolean } = {},
): Promise<User[]> {
  requireSignedIn(ctx, 'see users');
  let q = ctx.db.kysely
    .selectFrom('users')
    .selectAll()
    .where('kind', '!=', 'system')
    .orderBy('handle');
  if (!opts.includeDeactivated) q = q.where('deactivated_at', 'is', null);
  return (await q.execute()).map((r) => redact(ctx, toUser(r)));
}

/** Gets a user by id, handle, `@handle` or `me`. */
export async function getUser(ctx: ServiceContext, ref: string): Promise<User> {
  requireSignedIn(ctx, 'see users');
  return redact(ctx, toUser(await getUserRow(ctx, ctx.db.kysely, ref)));
}

/** Creates a human or agent user. Admin only. */
export async function createUser(ctx: ServiceContext, input: CreateUserInput): Promise<User> {
  requireAdmin(ctx, 'create users');
  const data = parseInput(CreateUserInputSchema, input);
  return createUserUnchecked(ctx, data);
}

/** Creates a user without a permission check (bootstrap / seeding). */
export async function createUserUnchecked(
  ctx: ServiceContext,
  input: CreateUserInput,
): Promise<User> {
  const data = parseInput(CreateUserInputSchema, input);
  try {
    return await withWriteTx(ctx.db, (tx) => insertUser(tx, ctx, data));
  } catch (error) {
    if (isUniqueViolation(error))
      throw conflict(`A user with handle "${data.handle}" or that email already exists`);
    throw error;
  }
}

/** Inserts a user inside an existing write transaction and records `user.created`. */
export async function insertUser(
  tx: Tx,
  ctx: ServiceContext,
  data: z.output<typeof CreateUserInputSchema>,
  opts: { deactivated?: boolean; ownerId?: string } = {},
): Promise<User> {
  const now = nowIso(ctx);
  const row = await tx
    .insertInto('users')
    .values({
      id: ctx.ids('user'),
      handle: data.handle,
      name: data.name,
      email: data.email ?? null,
      kind: data.kind,
      role: data.role,
      avatar_url: data.avatarUrl ?? null,
      created_at: now,
      updated_at: now,
      deactivated_at: opts.deactivated ? now : null,
      owner_id: opts.ownerId ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const user = toUser(row);
  await recordEvent(tx, ctx, 'user.created', { data: { user } });
  return user;
}

/** Updates a user. Admins can change anything; users can change their own name, email and avatar. */
export async function updateUser(
  ctx: ServiceContext,
  ref: string,
  input: UpdateUserInput,
): Promise<User> {
  const patch = parseInput(UpdateUserInputSchema, input);
  return withWriteTx(ctx.db, async (tx) => {
    const row = await getUserRow(ctx, tx, ref);
    const self = row.id === ctx.actor.id;
    const adminOnly = patch.role !== undefined || patch.deactivated !== undefined;
    if (!isAdmin(ctx) && (!self || adminOnly))
      throw forbidden('You can only edit your own profile');
    const before = toUser(row);
    const now = nowIso(ctx);
    const updated = await tx
      .updateTable('users')
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.email !== undefined && { email: patch.email }),
        ...(patch.role !== undefined && { role: patch.role }),
        ...(patch.avatarUrl !== undefined && { avatar_url: patch.avatarUrl }),
        ...(patch.deactivated !== undefined && { deactivated_at: patch.deactivated ? now : null }),
        updated_at: now,
      })
      .where('id', '=', row.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    const user = toUser(updated);
    const changes = diff(before, user, ['name', 'email', 'role', 'avatarUrl', 'deactivatedAt']);
    if (Object.keys(changes).length > 0)
      await recordEvent(tx, ctx, 'user.updated', { data: { user, changes } });
    return user;
  });
}
