import { createTestContext, type TestContext } from '@poietic-tech/issues-core/testing';
import { SYSTEM_ACTOR, withActor } from '@poietic-tech/issues-core';
import { testDialect } from '@poietic-tech/issues-db/testing';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSsoDirectory } from './directory.ts';

const ISS = 'https://auth.example.test';
const KEY = 'ptk_test-key';
let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.destroy());

const user = (id: string, groups = ['crew'], over: object = {}) => ({
  id,
  name: `Person ${id}`,
  avatar_url: null,
  groups,
  kind: 'human',
  owner: null,
  created_at: 0,
  ...over,
});

/** A fake directory API: `pages` are the successive /api/users pages; `status` overrides the answer. */
function directoryApi(pages: object[][], status = 200) {
  const seen: { url: string; authorization: string | null }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push({ url: request.url, authorization: request.headers.get('authorization') });
    if (status !== 200) return new Response('nope', { status });
    const cursor = Number(new URL(request.url).searchParams.get('cursor') ?? 0);
    return Response.json({
      users: pages[cursor] ?? [],
      next_cursor: cursor + 1 < pages.length ? String(cursor + 1) : null,
    });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

function clock(start: number) {
  let now = start;
  return { now: () => new Date(now), advance: (ms: number) => void (now += ms) };
}

const logLines = () => {
  const lines: string[] = [];
  return { lines, logger: pino({ level: 'info' }, { write: (l: string) => void lines.push(l) }) };
};

describe(`createSsoDirectory (${testDialect()})`, () => {
  it('pages through the directory with the service key and creates member-group humans', async () => {
    const { seen, fetchImpl } = directoryApi([[user('p1')], [user('p2', ['other'])]]);
    const dir = createSsoDirectory({
      serviceKey: KEY,
      baseUrl: ISS,
      issuer: ISS,
      memberGroup: 'crew',
      fetchImpl,
    });
    const c = clock(Date.parse('2026-10-13T00:00:00Z'));
    await dir.refresh({ ...withActor(t.ctx, SYSTEM_ACTOR), clock: c }, logLines().logger);
    expect(seen).toEqual([
      { url: `${ISS}/api/users`, authorization: `Bearer ${KEY}` },
      { url: `${ISS}/api/users?cursor=1`, authorization: `Bearer ${KEY}` },
    ]);
    const subjects = (
      await t.db.kysely
        .selectFrom('user_identities')
        .innerJoin('users', 'users.id', 'user_identities.user_id')
        .select(['subject', 'handle'])
        .where('issuer', '=', ISS)
        .execute()
    ).map((r) => r.subject);
    expect(subjects).toContain('p1');
    expect(subjects).not.toContain('p2');
  });

  it("copies each person's handle from the directory", async () => {
    const { fetchImpl } = directoryApi([[user('p9', ['crew'], { handle: 'pat' })]]);
    const dir = createSsoDirectory({
      serviceKey: KEY,
      baseUrl: ISS,
      issuer: ISS,
      memberGroup: 'crew',
      fetchImpl,
    });
    await dir.refresh(withActor(t.ctx, SYSTEM_ACTOR), logLines().logger);
    const row = await t.db.kysely
      .selectFrom('user_identities')
      .innerJoin('users', 'users.id', 'user_identities.user_id')
      .select('handle')
      .where('subject', '=', 'p9')
      .executeTakeFirstOrThrow();
    expect(row.handle).toBe('pat');
  });

  it('refreshes at most once per TTL, and retries a failure after a minute', async () => {
    const ok = directoryApi([[]]);
    let failing = true;
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) =>
      failing
        ? Promise.resolve(new Response('down', { status: 503 }))
        : ok.fetchImpl(input, init)) as typeof fetch;
    const dir = createSsoDirectory({ serviceKey: KEY, baseUrl: ISS, issuer: ISS, fetchImpl });
    const c = clock(Date.parse('2026-10-13T00:00:00Z'));
    const ctx = { ...withActor(t.ctx, SYSTEM_ACTOR), clock: c };
    const { lines, logger } = logLines();

    await dir.refresh(ctx, logger); // fails open: no throw
    expect(lines.join('')).toContain('SSO directory refresh failed');
    expect(lines.join('')).not.toContain(KEY);
    failing = false;
    c.advance(30_000);
    await dir.refresh(ctx, logger); // still inside the retry delay
    expect(ok.seen).toHaveLength(0);
    c.advance(31_000);
    await dir.refresh(ctx, logger);
    expect(ok.seen).toHaveLength(1);
    c.advance(4 * 60_000);
    await dir.refresh(ctx, logger); // inside the 5-minute TTL
    expect(ok.seen).toHaveLength(1);
    c.advance(61_000);
    await dir.refresh(ctx, logger);
    expect(ok.seen).toHaveLength(2);
  });

  it('shares one fetch between concurrent refreshes', async () => {
    const { seen, fetchImpl } = directoryApi([[]]);
    const dir = createSsoDirectory({ serviceKey: KEY, baseUrl: ISS, issuer: ISS, fetchImpl });
    const ctx = { ...withActor(t.ctx, SYSTEM_ACTOR), clock: clock(0) };
    const { logger } = logLines();
    await Promise.all([dir.refresh(ctx, logger), dir.refresh(ctx, logger)]);
    expect(seen).toHaveLength(1);
  });

  it('fails open on a malformed entry, changing nothing', async () => {
    const { fetchImpl } = directoryApi([[user('p3'), { id: 'p4' }]]);
    const dir = createSsoDirectory({
      serviceKey: KEY,
      baseUrl: ISS,
      issuer: ISS,
      memberGroup: 'crew',
      fetchImpl,
    });
    const { lines, logger } = logLines();
    await dir.refresh({ ...withActor(t.ctx, SYSTEM_ACTOR), clock: clock(0) }, logger);
    expect(lines.join('')).toContain('SSO directory refresh failed');
    const row = await t.db.kysely
      .selectFrom('user_identities')
      .select('user_id')
      .where('subject', '=', 'p3')
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });
});
