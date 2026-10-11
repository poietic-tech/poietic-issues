import {
  actorForUser,
  ANONYMOUS_ACTOR,
  authenticateSession,
  authenticateToken,
  DomainError,
  signInWithSso,
  SYSTEM_ACTOR,
  TOKEN_PREFIX,
  toActor,
  type Actor,
  type ServiceContext,
} from '@poietic-tech/issues-core';
import { newId } from '@poietic-tech/issues-schema';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import {
  type AppEnv,
  LEGACY_SESSION_COOKIE,
  type ResolvedDeps,
  SESSION_COOKIE,
  type SsoOptions,
} from '../env.ts';
import type { Logger } from '../logger.ts';
import { problem } from '../problem.ts';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Assigns a request id (honouring a client-supplied `X-Request-Id`) and echoes it back. */
export const requestId = createMiddleware<AppEnv>(async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const id =
    incoming && /^[\w.:-]{1,100}$/.test(incoming)
      ? incoming
      : newId('event').replace('evt_', 'req_');
  c.set('requestId', id);
  await next();
  c.header('x-request-id', id);
});

/**
 * Resolves the actor from a bearer token, a session cookie, or (trusted mode) configuration, and builds the
 * per-request ServiceContext. Without credentials (or with a stale session cookie) the context acts as the
 * anonymous actor, which can read public projects only (ADR 0021). Cookie-authenticated unsafe requests must
 * be same-origin (CSRF protection); bearer requests carry no ambient credentials and are exempt.
 *
 * A bearer value is an API token when it starts with `trk_`. With SSO configured, any other value is an identity
 * token from the issuer (an agent's, usually; ADR 0023). Either way the header decides on its own: an invalid
 * bearer is a 401 and never falls back to the session cookie. With a liveness check configured, an identity-token
 * write is also refused (401) once the issuer says the token's session has ended.
 */
export function authenticate(deps: ResolvedDeps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const db = deps.getDb();
    const clock = deps.clock ?? { now: () => new Date() };
    let actor = null;
    let via: AppEnv['Variables']['authVia'] = null;

    if (deps.auth.mode === 'trusted') {
      actor = await actorForUser({ db, actor: SYSTEM_ACTOR }, deps.auth.actor);
      if (!actor)
        return problem(
          c,
          'UNAUTHENTICATED',
          `Local actor "${deps.auth.actor}" not found or deactivated`,
        );
      via = 'trusted';
    } else {
      const header = c.req.header('authorization');
      if (header) {
        const value = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
        const sso = deps.auth.sso;
        if (value && sso && !value.startsWith(TOKEN_PREFIX)) {
          actor = await identityActor(
            { db, clock, ids: deps.ids ?? newId, requestId: c.get('requestId') },
            sso,
            value,
            c.get('logger'),
          );
          via = 'identity';
          if (actor && UNSAFE.has(c.req.method) && sso.liveness)
            if (!(await sessionIsLive(sso, value, clock.now(), c.get('logger'))))
              return problem(c, 'UNAUTHENTICATED', 'The session behind this token has ended');
        } else {
          actor = value ? await authenticateToken({ db, clock }, value) : null;
          via = 'bearer';
        }
        if (!actor) return problem(c, 'UNAUTHENTICATED', 'Invalid, expired or revoked token');
      } else {
        const cookie = getCookie(c, SESSION_COOKIE) ?? getCookie(c, LEGACY_SESSION_COOKIE);
        if (cookie) {
          actor = await authenticateSession({ db, clock }, cookie);
          if (actor) {
            via = 'session';
            if (UNSAFE.has(c.req.method) && !sameOrigin(c.req.raw, deps.auth.allowedOrigins ?? []))
              return problem(c, 'FORBIDDEN', 'Cross-origin request rejected (CSRF protection)');
          }
        }
      }
    }

    c.set('actor', actor);
    c.set('authVia', via);
    c.set('ctx', {
      db,
      actor: actor ?? ANONYMOUS_ACTOR,
      clock,
      ids: deps.ids ?? newId,
      requestId: c.get('requestId'),
    });
    await next();
  });
}

/**
 * Resolves an SSO identity token to its actor, provisioning the user (or agent) on first use, or null when the token
 * does not verify. Throws UNAVAILABLE when the issuer's keys can't be fetched and PENDING_APPROVAL for an inactive user.
 */
async function identityActor(
  deps: Omit<ServiceContext, 'actor'>,
  sso: SsoOptions,
  token: string,
  logger: Logger,
): Promise<Actor | null> {
  let claims;
  try {
    claims = await sso.verifier.verify(token);
  } catch (error) {
    logger.warn({ err: error }, 'SSO identity token verification failed');
    throw new DomainError('UNAVAILABLE', `Could not reach ${sso.name} to verify the token`);
  }
  if (!claims) return null;
  const { user, status } = await signInWithSso(
    { ...deps, actor: SYSTEM_ACTOR },
    {
      issuer: sso.issuer,
      subject: claims.sub,
      name: claims.name,
      role: claims.role,
      groups: claims.groups,
      kind: claims.kind,
      owner: claims.owner,
    },
    { adminRole: sso.adminRole },
  );
  if (status === 'owner_inactive')
    throw new DomainError('PENDING_APPROVAL', `@${user.handle}'s owner is deactivated`);
  if (status === 'pending')
    throw new DomainError(
      'PENDING_APPROVAL',
      `@${user.handle} is waiting for an admin to approve access`,
    );
  return toActor(user);
}

/**
 * Whether the issuer still vouches for an identity token's session, asked before a write so a revoked agent token
 * stops writing within the liveness cache's lifetime rather than the token's. Fails closed: an issuer that can't be
 * asked is a 503, as when its keys can't be fetched.
 */
async function sessionIsLive(
  sso: SsoOptions,
  token: string,
  now: Date,
  logger: Logger,
): Promise<boolean> {
  try {
    return await sso.liveness!.isLive(token, now);
  } catch (error) {
    logger.warn({ err: error }, 'SSO session liveness check failed');
    throw new DomainError('UNAVAILABLE', `Could not reach ${sso.name} to check the session`);
  }
}

/** Anonymous requests may read (core decides what is visible, ADR 0021); everything else needs a user. */
export const requireActor = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get('actor') && c.req.method !== 'GET' && c.req.method !== 'HEAD')
    return problem(
      c,
      'UNAUTHENTICATED',
      'Authenticate with "Authorization: Bearer <token>" or sign in',
    );
  await next();
});

export function sameOrigin(request: Request, allowed: string[]): boolean {
  const target = new URL(request.url).origin;
  const origin = request.headers.get('origin');
  if (origin) return origin === target || allowed.includes(origin);
  const site = request.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none';
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      const ref = new URL(referer).origin;
      return ref === target || allowed.includes(ref);
    } catch {
      return false;
    }
  }
  // Non-browser clients (no Origin/Referer/Sec-Fetch-*) cannot be CSRF vectors.
  return true;
}
