import type { Tx } from '@poietic-tech/issues-db';
import { HandleSchema, type User } from '@poietic-tech/issues-schema';
import { nowIso, type ServiceContext } from '../context.ts';
import { diff, recordEvent } from '../events.ts';
import { toUser } from '../mappers.ts';
import { ownerHandle } from './users.ts';

const HANDLE_MAX = 39;

/** An issuer's handle the tracker can store, else null (tokens minted before auth had handles carry none). */
export function authHandle(value: string | null | undefined): string | null {
  const parsed = HandleSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The identities linked to a user that holds a handle someone else's identity now owns. */
export type HolderIdentities = readonly { issuer: string; subject: string }[];

/** Unlinked accounts give way to an identity's handle; linked ones keep it until the directory moves them. */
export const unlinked = (identities: HolderIdentities) => identities.length === 0;

/** `<handle>-legacy`, else `-legacy-2`, `-legacy-3`, …, with the handle clipped so the whole stays valid. */
async function legacyHandle(tx: Tx, handle: string): Promise<string> {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '-legacy' : `-legacy-${n}`;
    const candidate = `${handle.slice(0, HANDLE_MAX - suffix.length).replace(/[-_]+$/, '')}${suffix}`;
    if (await isFree(tx, candidate)) return candidate;
  }
}

export async function isFree(tx: Tx, handle: string): Promise<boolean> {
  return !(await tx
    .selectFrom('users')
    .select('id')
    .where('handle', '=', handle)
    .executeTakeFirst());
}

/** Gives a user a new handle and records `user.updated` with the change. */
export async function setHandle(
  tx: Tx,
  ctx: ServiceContext,
  userId: string,
  handle: string,
): Promise<User> {
  const row = await tx
    .selectFrom('users')
    .selectAll()
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
  const owner = await ownerHandle(tx, row.owner_id);
  const before = toUser(row, owner);
  const user = toUser(
    await tx
      .updateTable('users')
      .set({ handle, updated_at: nowIso(ctx) })
      .where('id', '=', userId)
      .returningAll()
      .executeTakeFirstOrThrow(),
    owner,
  );
  await recordEvent(tx, ctx, 'user.updated', {
    data: { user, changes: diff(before, user, ['handle']) },
  });
  return user;
}

/**
 * Makes `handle` free for the identity whose issuer assigned it (ADR 0031). A holder that `mayDisplace` gives way is
 * renamed to `<handle>-legacy`; its id, and so its history, stays. False when the holder keeps the handle.
 */
export async function freeAuthHandle(
  tx: Tx,
  ctx: ServiceContext,
  handle: string,
  mayDisplace: (identities: HolderIdentities) => boolean,
): Promise<boolean> {
  const holder = await tx
    .selectFrom('users')
    .select('id')
    .where('handle', '=', handle)
    .executeTakeFirst();
  if (!holder) return true;
  const identities = await tx
    .selectFrom('user_identities')
    .select(['issuer', 'subject'])
    .where('user_id', '=', holder.id)
    .execute();
  if (!mayDisplace(identities)) return false;
  await setHandle(tx, ctx, holder.id, await legacyHandle(tx, handle));
  return true;
}
