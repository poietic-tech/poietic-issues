/**
 * Reads the SSO issuer's directory with `@poietic-tech/auth` (issue #16 stage 3, ADR 0027).
 *
 * auth.poietic.tech owns who people are; local user rows are its cache. `refresh` pages through the directory's
 * users with the service key and hands them to core's `applyDirectory`, which refreshes names, handles and avatars and creates
 * member-group humans who have never signed in. It runs at most once per `ttlMs` (default 5 minutes) against the
 * injected clock, one fetch at a time, and fails open: an unreachable directory is logged and the local users are
 * served as they are. A failed attempt is retried after `retryMs` (default 1 minute), not on every request.
 */

import { PoieticAuthApi } from '@poietic-tech/auth';
import {
  applyDirectory,
  type DirectoryPerson,
  type ServiceContext,
} from '@poietic-tech/issues-core';
import { z } from 'zod';
import type { Logger } from '../logger.ts';

const DirectoryUserSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  handle: z.string().optional(),
  avatar_url: z.string().nullable(),
  groups: z.array(z.string()),
  kind: z.enum(['human', 'agent']),
});

export interface SsoDirectory {
  /** Brings local users in line with the directory if the last refresh is stale. Never throws. */
  refresh(ctx: ServiceContext, logger: Logger): Promise<void>;
}

export function createSsoDirectory(opts: {
  /** The service key (`ptk_…`). Server only. */
  serviceKey: string;
  /** The directory API's origin (auth.poietic.tech). */
  baseUrl: string;
  issuer: string;
  memberGroup?: string | undefined;
  fetchImpl?: typeof fetch;
  /** Abort each directory request after this many milliseconds (default 5000). */
  fetchTimeoutMs?: number;
  ttlMs?: number;
  retryMs?: number;
}): SsoDirectory {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.fetchTimeoutMs ?? 5000;
  const ttlMs = opts.ttlMs ?? 5 * 60_000;
  const retryMs = opts.retryMs ?? 60_000;
  const api = new PoieticAuthApi({
    serviceKey: opts.serviceKey,
    baseUrl: opts.baseUrl,
    fetchImpl: (input, init) =>
      fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
  });
  let nextAt = -Infinity;
  let inFlight: Promise<void> | null = null;

  async function run(ctx: ServiceContext, logger: Logger): Promise<void> {
    const started = ctx.clock.now().getTime();
    try {
      const people: DirectoryPerson[] = [];
      for await (const item of api.users.list()) {
        // The package passes items through unchecked; one malformed entry fails the refresh (and so fails open).
        const u = DirectoryUserSchema.parse(item);
        people.push({
          subject: u.id,
          name: u.name,
          handle: u.handle,
          avatarUrl: u.avatar_url,
          groups: u.groups,
          kind: u.kind,
        });
      }
      const { created, updated } = await applyDirectory(ctx, people, {
        issuer: opts.issuer,
        memberGroup: opts.memberGroup,
      });
      if (created.length || updated.length)
        logger.info(
          { created: created.length, updated: updated.length },
          'Refreshed users from the SSO directory',
        );
      nextAt = started + ttlMs;
    } catch (error) {
      logger.warn({ err: error }, 'SSO directory refresh failed; serving local users');
      nextAt = started + retryMs;
    }
  }

  return {
    async refresh(ctx, logger) {
      if (ctx.clock.now().getTime() < nextAt) return;
      inFlight ??= run(ctx, logger).finally(() => {
        inFlight = null;
      });
      await inFlight;
    },
  };
}
