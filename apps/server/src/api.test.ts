import { createToken } from '@poietic-tech/issues-core';
import { createTestContext, grant, type TestContext } from '@poietic-tech/issues-core/testing';
import { testDialect } from '@poietic-tech/issues-db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { testSso } from './testing.ts';

let t: TestContext;
let app: ReturnType<typeof createApp>;
let adminToken: string;
let memberToken: string;
let sso: ReturnType<typeof testSso>;

const BASE = 'http://tracker.test';

async function call(
  method: string,
  path: string,
  opts: { token?: string | null; body?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...opts.headers };
  const token = opts.token === undefined ? adminToken : opts.token;
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(`${BASE}/api/v1${path}`, {
    method,
    headers,
    ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: any = text ? JSON.parse(text) : null;
  return { status: res.status, body, headers: res.headers };
}

beforeAll(async () => {
  t = await createTestContext();
  sso = testSso(t);
  app = createApp({ db: t.db, auth: { mode: 'standard', allowDevLogin: true, sso: sso.options } });
  adminToken = await sso.bearer('admin');
  memberToken = await sso.bearer('member');
});
afterAll(() => t.destroy());

describe(`HTTP API (${testDialect()})`, () => {
  it('requires authentication and answers with problem+json', async () => {
    const res = await call('GET', '/users', { token: null });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(res.body).toMatchObject({
      code: 'UNAUTHENTICATED',
      status: 401,
      type: 'urn:tracker:error:UNAUTHENTICATED',
    });
    expect(res.body.requestId).toBe(res.headers.get('x-request-id'));
    expect((await call('GET', '/projects', { token: 'trk_nope' })).status).toBe(401);
  });

  it('creates projects and issues and resolves human refs', async () => {
    const project = await call('POST', '/projects', { body: { key: 'api', name: 'API' } });
    expect(project.status).toBe(201);
    await grant(t, 'API', t.member, 'editor');
    expect(project.body.key).toBe('API');
    expect(
      (await call('POST', '/projects', { token: memberToken, body: { key: 'NOPE', name: 'x' } }))
        .body.code,
    ).toBe('FORBIDDEN');

    const created = await call('POST', '/projects/API/issues', {
      token: memberToken,
      body: { title: 'Hello from the API', priority: 2, assignee: 'me' },
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('etag')).toBe('"v1"');
    expect(created.headers.get('location')).toBe('/api/v1/issues/API-1');
    expect(created.body).toMatchObject({
      key: 'API-1',
      assignee: { handle: 'member' },
      status: { name: 'Todo' },
    });

    const byKey = await call('GET', '/issues/api-1');
    expect(byKey.body.id).toBe(created.body.id);
    expect((await call('GET', `/issues/${created.body.id}`)).body.key).toBe('API-1');
    expect((await call('GET', '/users/me', { token: memberToken })).body.handle).toBe('member');
  });

  it('validates input with field-level errors', async () => {
    const res = await call('POST', '/projects/API/issues', { body: { title: '', priority: 9 } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.errors.map((e: { path: string }) => e.path).sort()).toEqual([
      'priority',
      'title',
    ]);
    const malformed = await app.request(`${BASE}/api/v1/projects/API/issues`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: '{nope',
    });
    expect(malformed.status).toBe(400);
    expect((await call('GET', '/nope')).body.code).toBe('NOT_FOUND');
  });

  it('enforces If-Match versions', async () => {
    const issue = (await call('POST', '/projects/API/issues', { body: { title: 'Versioned' } }))
      .body;
    const ok = await call('PATCH', `/issues/${issue.key}`, {
      body: { priority: 1 },
      headers: { 'if-match': '"v1"' },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('etag')).toBe('"v2"');
    const stale = await call('PATCH', `/issues/${issue.key}`, {
      body: { priority: 3 },
      headers: { 'if-match': '"v1"' },
    });
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe('VERSION_MISMATCH');
  });

  it('lists with query-parameter filters, sorting and cursors', async () => {
    await call('POST', '/projects', { body: { key: 'QRY', name: 'Query' } });
    await call('POST', '/projects/QRY/labels', { body: { name: 'bug' } });
    for (const [title, priority, labels] of [
      ['Alpha crash', 1, ['bug']],
      ['Beta', 2, []],
      ['Gamma crash', 3, ['bug']],
      ['Delta', 4, []],
    ] as const) {
      await call('POST', '/projects/QRY/issues', { body: { title, priority, labels } });
    }
    const titles = async (qs: string) =>
      (await call('GET', `/projects/QRY/issues?${qs}`)).body.data.map(
        (i: { title: string }) => i.title,
      );
    expect(await titles('label=bug&sort=title')).toEqual(['Alpha crash', 'Gamma crash']);
    expect(await titles('priority.gte=3&sort=-priority')).toEqual(['Delta', 'Gamma crash']);
    expect(await titles('q=crash&sort=priority')).toEqual(['Alpha crash', 'Gamma crash']);
    expect(await titles('priority=1,4&sort=title')).toEqual(['Alpha crash', 'Delta']);
    expect(await titles('assignee=none&status=Todo&sort=title')).toHaveLength(4);
    expect(
      await titles(
        `filter=${encodeURIComponent(JSON.stringify({ conditions: [{ field: 'title', op: 'eq', value: 'Beta' }] }))}`,
      ),
    ).toEqual(['Beta']);

    const page1 = await call('GET', '/projects/QRY/issues?sort=title&limit=3');
    expect(page1.body.data).toHaveLength(3);
    const page2 = await call(
      'GET',
      `/projects/QRY/issues?sort=title&limit=3&cursor=${page1.body.nextCursor}`,
    );
    expect(page2.body.data.map((i: { title: string }) => i.title)).toEqual(['Gamma crash']);
    expect(page2.body.nextCursor).toBeNull();

    const bad = await call('GET', '/projects/QRY/issues?priority.like=1');
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    expect((await call('GET', '/projects/QRY/issues?sort=nope')).status).toBe(400);

    const search = await call('POST', '/issues/search', {
      body: {
        filter: { conditions: [{ field: 'text', op: 'contains', value: 'crash' }] },
        sort: [{ field: 'title' }],
      },
    });
    expect(search.body.data.map((i: { key: string }) => i.key)).toEqual(['QRY-1', 'QRY-3']);
  });

  it('replays idempotent POSTs and rejects key reuse', async () => {
    const headers = { 'idempotency-key': 'create-once' };
    const first = await call('POST', '/projects/API/issues', { body: { title: 'Once' }, headers });
    const again = await call('POST', '/projects/API/issues', { body: { title: 'Once' }, headers });
    expect(again.status).toBe(201);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(again.body.id).toBe(first.body.id);
    const reused = await call('POST', '/projects/API/issues', {
      body: { title: 'Different' },
      headers,
    });
    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // Keys are per actor.
    const other = await call('POST', '/projects/API/issues', {
      token: memberToken,
      body: { title: 'Once' },
      headers,
    });
    expect(other.body.id).not.toBe(first.body.id);
  });

  it('supports comments, links, labels, children, activity, delete/restore', async () => {
    const a = (await call('POST', '/projects/API/issues', { body: { title: 'Parent' } })).body;
    const b = (
      await call('POST', '/projects/API/issues', { body: { title: 'Child', parent: a.key } })
    ).body;
    expect(
      (await call('GET', `/issues/${a.key}/children`)).body.data.map((i: { key: string }) => i.key),
    ).toEqual([b.key]);

    const comment = await call('POST', `/issues/${a.key}/comments`, {
      body: { body: 'Looks good' },
    });
    expect(comment.status).toBe(201);
    expect(
      (
        await call('PATCH', `/comments/${comment.body.id}`, {
          token: memberToken,
          body: { body: 'x' },
        })
      ).status,
    ).toBe(403);

    const link = await call('POST', `/issues/${a.key}/links`, {
      body: { type: 'blocks', target: b.key },
    });
    expect(link.body).toMatchObject({ direction: 'outward', label: 'blocks' });
    expect((await call('GET', `/issues/${b.key}/links`)).body.data[0].label).toBe('is blocked by');
    expect((await call('GET', '/link-types')).body.data.map((t: { key: string }) => t.key)).toEqual(
      ['blocks', 'duplicates', 'relates'],
    );
    expect((await call('DELETE', `/links/${link.body.id}`)).status).toBe(204);

    await call('POST', '/projects/API/labels', { body: { name: 'urgent' } });
    const labeled = await call('POST', `/issues/${a.key}/labels`, { body: { add: ['urgent'] } });
    expect(labeled.body.labels.map((l: { name: string }) => l.name)).toEqual(['urgent']);

    const activity = await call('GET', `/issues/${a.key}/activity`);
    expect(activity.body.data.map((e: { type: string }) => e.type)).toEqual([
      'issue.created',
      'comment.created',
      'link.created',
      'link.deleted',
      'issue.updated',
    ]);

    expect((await call('DELETE', `/issues/${b.key}`)).body.deletedAt).not.toBeNull();
    expect((await call('POST', `/issues/${b.key}/restore`)).body.deletedAt).toBeNull();
    expect(
      (await call('DELETE', `/issues/${b.key}?permanent=true`, { token: memberToken })).status,
    ).toBe(403);
  });

  it('moves issues and bulk-updates them', async () => {
    const x = (await call('POST', '/projects/API/issues', { body: { title: 'X' } })).body;
    const moved = await call('POST', `/issues/${x.key}/move`, {
      body: { status: 'In Progress', position: 'bottom' },
    });
    expect(moved.body.status.name).toBe('In Progress');
    const bulk = await call('POST', '/issues/bulk', {
      body: { issues: [x.key, 'API-1'], patch: { priority: 4 } },
    });
    expect(bulk.body.data.map((i: { priority: number }) => i.priority)).toEqual([4, 4]);
  });

  it('manages custom fields and filters issues by them', async () => {
    const field = await call('POST', '/projects/API/fields', {
      body: {
        key: 'env',
        name: 'Environment',
        type: 'select',
        options: [{ value: 'prod' }, { value: 'staging' }],
      },
    });
    expect(field.status).toBe(201);
    const issue = await call('POST', '/projects/API/issues', {
      body: { title: 'Prod incident', customFields: { env: 'prod' } },
    });
    expect(issue.body.customFields).toEqual({ env: 'prod' });
    const listed = await call('GET', '/projects/API/issues?cf.env=prod');
    expect(listed.body.data.map((i: { key: string }) => i.key)).toEqual([issue.body.key]);
    const option = await call('POST', `/fields/${field.body.id}/options`, {
      body: { value: 'dev' },
    });
    expect(option.body.options.map((o: { value: string }) => o.value)).toEqual([
      'prod',
      'staging',
      'dev',
    ]);
    const archived = await call('PATCH', `/fields/${field.body.id}`, { body: { archived: true } });
    expect(archived.body.archivedAt).not.toBeNull();
    expect((await call('GET', '/projects/API/fields')).body.data).toHaveLength(0);
    expect((await call('DELETE', `/fields/${field.body.id}`, { token: memberToken })).status).toBe(
      403,
    );
  });

  it('describes the issue input schema with live enums for agents', async () => {
    const res = await call('GET', '/projects/API/schema/issue');
    expect(res.status).toBe(200);
    expect(res.body.create.properties.status.enum).toContain('In Progress');
    expect(res.body.create.properties.labels.items.enum).toContain('urgent');
    expect(res.body.create.required).toEqual(['title']);
  });

  it('reads the event log with cursors', async () => {
    const all = await call('GET', '/events?limit=1000');
    const seqs = all.body.data.map((e: { seq: number }) => e.seq);
    const tail = await call('GET', `/events?after=${seqs.at(-2)}`);
    expect(tail.body.data.map((e: { seq: number }) => e.seq)).toEqual([seqs.at(-1)]);
    const issueEvents = await call('GET', '/events?issue=API-1&types=issue.created');
    expect(issueEvents.body.data).toHaveLength(1);
  });

  it('manages views and tokens', async () => {
    const views = await call('GET', '/projects/API/views');
    const board = views.body.data.find((v: { layout: string }) => v.layout === 'board');
    const updated = await call('PATCH', `/views/${board.id}`, {
      body: {
        config: {
          ...board.config,
          board: { ...board.config.board, cardFields: ['key', 'estimate'] },
        },
      },
    });
    expect(updated.body.config.board.cardFields).toEqual(['key', 'estimate']);
    const personal = await call('POST', '/projects/API/views', {
      token: memberToken,
      body: { name: 'Mine', layout: 'list' },
    });
    expect(personal.body.ownerId).not.toBeNull();
    expect((await call('GET', `/views/${personal.body.id}`)).status).toBe(404); // other users can't see it

    const token = await call('POST', '/users/me/tokens', {
      token: memberToken,
      body: { name: 'cli' },
    });
    expect(token.body.token).toMatch(/^trk_/);
    expect((await call('GET', '/me', { token: token.body.token })).body.handle).toBe('member');
    await call('DELETE', `/tokens/${token.body.id}`, { token: memberToken });
    expect((await call('GET', '/me', { token: token.body.token })).status).toBe(401);
  });

  it('signs in the web UI with a cookie session and blocks cross-site writes', async () => {
    const config = await call('GET', '/auth/config', { token: null });
    expect(config.body.devLogin).toBe(true);
    expect(config.body.users.map((u: { handle: string }) => u.handle)).toContain('member');

    const login = await call('POST', '/auth/dev-login', { token: null, body: { user: 'member' } });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    expect(login.headers.get('set-cookie')).toMatch(/HttpOnly/i);

    expect((await call('GET', '/me', { token: null, headers: { cookie } })).body.handle).toBe(
      'member',
    );
    const sameOrigin = await call('POST', '/projects/API/issues', {
      token: null,
      headers: { cookie, origin: BASE },
      body: { title: 'From the browser' },
    });
    expect(sameOrigin.status).toBe(201);
    const crossSite = await call('POST', '/projects/API/issues', {
      token: null,
      headers: { cookie, origin: 'https://evil.example' },
      body: { title: 'CSRF' },
    });
    expect(crossSite.status).toBe(403);

    await call('POST', '/auth/logout', { token: null, headers: { cookie, origin: BASE } });
    expect((await call('GET', '/me', { token: null, headers: { cookie } })).body).toEqual({
      anonymous: true,
    });

    const tokenLogin = await call('POST', '/auth/token-login', {
      token: null,
      body: { token: (await createToken(t.member, 'member', { name: 'login' })).token },
    });
    expect(tokenLogin.status).toBe(200);
  });

  it('refuses dev login unless enabled, and trusted mode acts as a fixed user', async () => {
    const strict = createApp({ db: t.db, auth: { mode: 'standard' } });
    const res = await strict.request(`${BASE}/api/v1/auth/dev-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'admin' }),
    });
    expect(res.status).toBe(403);

    const trusted = createApp({ db: t.db, auth: { mode: 'trusted', actor: 'bot' } });
    const me = await trusted.request(`${BASE}/api/v1/me`);
    expect(((await me.json()) as { handle: string }).handle).toBe('bot');
  });

  it('serves the OpenAPI document and API reference', async () => {
    const doc = await app.request(`${BASE}/api/v1/openapi.json`);
    expect(doc.status).toBe(200);
    const body = (await doc.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(body.openapi).toBe('3.1.0');
    expect(Object.keys(body.paths)).toContain('/issues/{issue}');
    expect((await app.request(`${BASE}/api/docs`)).status).toBe(200);
    expect((await app.request(`${BASE}/healthz`)).status).toBe(200);
  });
});
