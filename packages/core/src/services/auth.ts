import { createHash, randomBytes } from 'node:crypto';
import { toJson, withWriteTx } from '@poietic-tech/issues-db';
import {
  type ApiToken,
  type CreatedApiToken,
  type CreateTokenInput,
  CreateTokenInputSchema,
} from '@poietic-tech/issues-schema';
import { type Actor, nowIso, type ServiceContext } from '../context.ts';
import { forbidden, notFound, parseInput } from '../errors.ts';
import { toApiToken } from '../mappers.ts';
import { isAdmin, requireSignedIn } from '../permissions.ts';
import { getUserRow } from '../refs.ts';
import { toActor } from './users.ts';

export const TOKEN_PREFIX = 'trk_';
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function randomBase62(length: number): string {
  const bytes = randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length && i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b < 248) out += BASE62[b % 62]; // rejection sampling: 248 = 4 * 62, avoids modulo bias
  }
  return out.length === length ? out : randomBase62(length);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Issues an API token for a user (yourself, or anyone if admin). The plaintext is returned once. */
export async function createToken(
  ctx: ServiceContext,
  userRef: string,
  input: CreateTokenInput,
): Promise<CreatedApiToken> {
  requireSignedIn(ctx, 'create tokens');
  const data = parseInput(CreateTokenInputSchema, input);
  return withWriteTx(ctx.db, async (tx) => {
    const user = await getUserRow(ctx, tx, userRef);
    if (user.id !== ctx.actor.id && !isAdmin(ctx))
      throw forbidden('Only admins can create tokens for other users');
    const token = `${TOKEN_PREFIX}${randomBase62(40)}`;
    const row = await tx
      .insertInto('api_tokens')
      .values({
        id: ctx.ids('apiToken'),
        user_id: user.id,
        name: data.name,
        token_hash: sha256(token),
        prefix: token.slice(0, 8),
        scopes: toJson(['*']),
        created_at: nowIso(ctx),
        last_used_at: null,
        expires_at: data.expiresAt ?? null,
        revoked_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { ...toApiToken(row), token };
  });
}

/** Lists a user's tokens (never includes secrets). */
export async function listTokens(ctx: ServiceContext, userRef: string): Promise<ApiToken[]> {
  requireSignedIn(ctx, 'see tokens');
  const user = await getUserRow(ctx, ctx.db.kysely, userRef);
  if (user.id !== ctx.actor.id && !isAdmin(ctx))
    throw forbidden("Only admins can list other users' tokens");
  const rows = await ctx.db.kysely
    .selectFrom('api_tokens')
    .selectAll()
    .where('user_id', '=', user.id)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map(toApiToken);
}

export async function revokeToken(ctx: ServiceContext, tokenId: string): Promise<ApiToken> {
  requireSignedIn(ctx, 'revoke tokens');
  return withWriteTx(ctx.db, async (tx) => {
    const row = await tx
      .selectFrom('api_tokens')
      .selectAll()
      .where('id', '=', tokenId)
      .executeTakeFirst();
    if (!row) throw notFound('Token', tokenId);
    if (row.user_id !== ctx.actor.id && !isAdmin(ctx))
      throw forbidden("Only admins can revoke other users' tokens");
    const updated = await tx
      .updateTable('api_tokens')
      .set({ revoked_at: row.revoked_at ?? nowIso(ctx) })
      .where('id', '=', tokenId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toApiToken(updated);
  });
}

/** How stale `last_used_at` may get before we pay for a write to refresh it. */
const LAST_USED_THROTTLE_MS = 60_000;

/**
 * Resolves a bearer token to its actor, or null if unknown, revoked, expired, or the user is deactivated.
 */
export async function authenticateToken(
  ctx: Pick<ServiceContext, 'db' | 'clock'>,
  token: string,
): Promise<Actor | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const row = await ctx.db.kysely
    .selectFrom('api_tokens')
    .innerJoin('users', 'users.id', 'api_tokens.user_id')
    .selectAll('users')
    .select([
      'api_tokens.id as token_id',
      'api_tokens.revoked_at',
      'api_tokens.expires_at',
      'api_tokens.last_used_at',
    ])
    .where('api_tokens.token_hash', '=', sha256(token))
    .executeTakeFirst();
  const now = ctx.clock.now();
  if (!row || row.revoked_at || row.deactivated_at) return null;
  if (row.expires_at && row.expires_at <= now.toISOString()) return null;
  if (!row.last_used_at || now.getTime() - Date.parse(row.last_used_at) > LAST_USED_THROTTLE_MS) {
    await withWriteTx(ctx.db, (tx) =>
      tx
        .updateTable('api_tokens')
        .set({ last_used_at: now.toISOString() })
        .where('id', '=', row.token_id)
        .execute(),
    );
  }
  return toActor(row);
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Creates a web session; returns the cookie value (only its hash is stored). */
export async function createSession(
  ctx: Pick<ServiceContext, 'db' | 'clock'>,
  userId: string,
): Promise<{ cookie: string; expiresAt: string }> {
  const cookie = randomBytes(32).toString('base64url');
  const now = ctx.clock.now();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  await withWriteTx(ctx.db, (tx) =>
    tx
      .insertInto('sessions')
      .values({
        id: sha256(cookie),
        user_id: userId,
        created_at: now.toISOString(),
        expires_at: expiresAt,
      })
      .execute(),
  );
  return { cookie, expiresAt };
}

export async function authenticateSession(
  ctx: Pick<ServiceContext, 'db' | 'clock'>,
  cookie: string,
): Promise<Actor | null> {
  const row = await ctx.db.kysely
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .selectAll('users')
    .select('sessions.expires_at as session_expires_at')
    .where('sessions.id', '=', sha256(cookie))
    .executeTakeFirst();
  if (!row || row.deactivated_at || row.session_expires_at <= ctx.clock.now().toISOString())
    return null;
  return toActor(row);
}

export async function deleteSession(
  ctx: Pick<ServiceContext, 'db'>,
  cookie: string,
): Promise<void> {
  await withWriteTx(ctx.db, (tx) =>
    tx.deleteFrom('sessions').where('id', '=', sha256(cookie)).execute(),
  );
}

/** Resolves a user for dev login / trusted local mode. Returns null if missing or deactivated. */
export async function actorForUser(
  ctx: Pick<ServiceContext, 'db' | 'actor'>,
  ref: string,
): Promise<Actor | null> {
  const row = await getUserRow(ctx, ctx.db.kysely, ref).catch(() => undefined);
  if (!row || row.deactivated_at) return null;
  return toActor(row);
}
