import { createToken } from '@poietic-tech/issues-core';
import { createTestContext, type TestContext } from '@poietic-tech/issues-core/testing';
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

function as(
  token: string | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return Promise.resolve(
    app.request(`${BASE}/api/v1${path}`, {
      method,
      headers: {
        ...(token && { authorization: `Bearer ${token}` }),
        'content-type': 'application/json',
        origin: BASE,
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
  );
}

function asAdmin(path: string, init: { method?: string; body?: unknown } = {}) {
  return app.request(`${BASE}/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
}

beforeAll(async () => {
  t = await createTestContext();
  sso = testSso(t);
  app = createApp({ db: t.db, auth: { mode: 'standard', allowDevLogin: true, sso: sso.options } });
  adminToken = await sso.bearer('admin');
  memberToken = await sso.bearer('member');
  for (const [key, visibility] of [
    ['PUB', 'public'],
    ['PRV', 'private'],
  ] as const) {
    const res = await asAdmin('/projects', {
      method: 'POST',
      body: { key, name: key, visibility },
    });
    expect(res.status).toBe(201);
  }
});
afterAll(() => t.destroy());

describe(`anonymous HTTP access (${testDialect()})`, () => {
  it('treats requests without credentials as anonymous, never as admin', async () => {
    const me = await app.request(`${BASE}/api/v1/me`);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ anonymous: true });
    expect((await app.request(`${BASE}/api/v1/projects`)).status).toBe(200);
    const list = (await (await app.request(`${BASE}/api/v1/projects`)).json()) as {
      data: { key: string; myAccess: string }[];
    };
    expect(list.data.map((p) => [p.key, p.myAccess])).toEqual([['PUB', 'read']]);
    expect((await app.request(`${BASE}/api/v1/projects/PRV`)).status).toBe(404);
    expect((await app.request(`${BASE}/api/v1/users`)).status).toBe(401);
    const post = await app.request(`${BASE}/api/v1/projects/PUB/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ title: 'x' }),
    });
    expect(post.status).toBe(401);
    const admin = await app.request(`${BASE}/api/v1/webhooks`);
    expect(admin.status).toBe(401);
  });

  it('answers 401, not 403, to anonymous reads of admin-only routes, before any lookup', async () => {
    const created = await asAdmin('/webhooks', {
      method: 'POST',
      body: { url: 'https://hooks.example.com/x', events: ['issue.created'] },
    });
    expect(created.status).toBe(201);
    const hook = (await created.json()) as { id: string };
    for (const path of [
      '/webhooks',
      `/webhooks/${hook.id}`,
      `/webhooks/${hook.id}/deliveries`,
      '/webhooks/whk_00000000000000000000000000/deliveries',
      '/webhook-deliveries/whd_00000000000000000000000000',
    ]) {
      const res = await app.request(`${BASE}/api/v1${path}`);
      expect(res.status, path).toBe(401);
      expect(((await res.json()) as { code: string }).code, path).toBe('UNAUTHENTICATED');
      // Signed-in non-admins are still forbidden.
      expect((await as(memberToken, 'GET', path)).status, path).toBe(403);
    }
  });

  it('reports the access level of signed-in callers on project responses', async () => {
    const res = await app.request(`${BASE}/api/v1/projects`, {
      headers: { authorization: `Bearer ${memberToken}` },
    });
    const body = (await res.json()) as { data: { key: string; myAccess: string }[] };
    expect(body.data.map((p) => [p.key, p.myAccess])).toEqual([['PUB', 'read']]);
    const admin = (await (await asAdmin('/projects/PRV')).json()) as { myAccess: string };
    expect(admin.myAccess).toBe('manage');
  });

  it('does not reveal whether a user exists through their tokens', async () => {
    for (const user of ['admin', 'member', 'nobody-here']) {
      const res = await app.request(`${BASE}/api/v1/users/${user}/tokens`);
      expect(res.status, user).toBe(401);
      expect(((await res.json()) as { code: string }).code).toBe('UNAUTHENTICATED');
    }
  });

  it('still rejects an invalid bearer token instead of falling back to anonymous', async () => {
    const res = await app.request(`${BASE}/api/v1/projects`, {
      headers: { authorization: 'Bearer trk_nope' },
    });
    expect(res.status).toBe(401);
  });

  it('keeps the sign-in endpoints working for signed-out callers', async () => {
    const config = (await (await app.request(`${BASE}/api/v1/auth/config`)).json()) as {
      users: { handle: string; email?: unknown }[];
    };
    expect(config.users.map((u) => u.handle)).toContain('member');
    expect(config.users.every((u) => !('email' in u))).toBe(true);

    const dev = await app.request(`${BASE}/api/v1/auth/dev-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ user: 'member' }),
    });
    expect(dev.status).toBe(200);
    expect(((await dev.json()) as { handle: string }).handle).toBe('member');

    const tokenLogin = await app.request(`${BASE}/api/v1/auth/token-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({
        token: (await createToken(t.member, 'member', { name: 'login' })).token,
      }),
    });
    expect(tokenLogin.status).toBe(200);
    expect(((await tokenLogin.json()) as { handle: string }).handle).toBe('member');
  });
});

describe(`member and repo routes (${testDialect()})`, () => {
  it('manages members and repos over HTTP', async () => {
    const add = await as(adminToken, 'POST', '/projects/PRV/members', {
      user: '@member',
      role: 'viewer',
    });
    expect(add.status).toBe(201);
    const added = (await add.json()) as { user: { handle: string }; role: string };
    expect(added.user.handle).toBe('member');
    expect(added.role).toBe('viewer');
    expect((await as(memberToken, 'GET', '/projects/PRV')).status).toBe(200);

    const list = await as(memberToken, 'GET', '/projects/PRV/members');
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { data: { user: { handle: string }; role: string }[] };
    expect(listed.data.map((m) => [m.user.handle, m.role])).toEqual([['member', 'viewer']]);

    // A viewer cannot manage.
    expect(
      (await as(memberToken, 'POST', '/projects/PRV/repos', { repo: 'acme/app' })).status,
    ).toBe(403);
    expect(
      (await as(memberToken, 'POST', '/projects/PRV/members', { user: 'admin', role: 'viewer' }))
        .status,
    ).toBe(403);
    expect(
      (await as(memberToken, 'PATCH', '/projects/PRV/members/@member', { role: 'manager' })).status,
    ).toBe(403);

    const patched = await as(adminToken, 'PATCH', '/projects/PRV/members/@member', {
      role: 'editor',
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { role: string }).role).toBe('editor');
    expect(
      (await as(adminToken, 'POST', '/projects/PRV/members', { user: '@member', role: 'viewer' }))
        .status,
    ).toBe(409);

    const repo = await as(adminToken, 'POST', '/projects/PRV/repos', { repo: 'acme/app' });
    expect(repo.status).toBe(201);
    const linked = (await repo.json()) as { id: string; owner: string; name: string };
    expect(linked).toMatchObject({ owner: 'acme', name: 'app' });
    expect(linked.id.startsWith('rpo_')).toBe(true);
    expect((await as(adminToken, 'POST', '/projects/PRV/repos', { repo: 'acme/app' })).status).toBe(
      409,
    );
    expect(
      (await as(adminToken, 'POST', '/projects/PRV/repos', { repo: 'not a repo' })).status,
    ).toBe(400);
    const shown = (await (await as(adminToken, 'GET', '/projects/PRV')).json()) as {
      repos: { id: string }[];
    };
    expect(shown.repos.map((r) => r.id)).toEqual([linked.id]);

    // Unlink by URL-encoded owner/name, then by id.
    const byName = await as(
      adminToken,
      'DELETE',
      `/projects/PRV/repos/${encodeURIComponent('acme/app')}`,
    );
    expect(byName.status).toBe(204);
    expect(await byName.text()).toBe('');
    expect(
      (await as(adminToken, 'DELETE', `/projects/PRV/repos/${encodeURIComponent('acme/app')}`))
        .status,
    ).toBe(404);
    const again = (await (
      await as(adminToken, 'POST', '/projects/PRV/repos', { repo: 'acme/app' })
    ).json()) as { id: string };
    expect((await as(adminToken, 'DELETE', `/projects/PRV/repos/${again.id}`)).status).toBe(204);

    expect((await as(adminToken, 'DELETE', '/projects/PRV/members/@member')).status).toBe(204);
    expect((await as(adminToken, 'DELETE', '/projects/PRV/members/@member')).status).toBe(404);
    expect((await as(memberToken, 'GET', '/projects/PRV')).status).toBe(404);
  });

  it('hides private projects from non-members and rejects anonymous writes', async () => {
    // Own state: whatever earlier tests left, the member starts without a membership of PRV.
    await asAdmin('/projects/PRV/members/@member', { method: 'DELETE' });
    expect((await as(memberToken, 'GET', '/projects/PRV')).status).toBe(404);
    expect((await as(memberToken, 'GET', '/projects/PRV/members')).status).toBe(404);
    expect(
      (await as(memberToken, 'POST', '/projects/PRV/repos', { repo: 'acme/app' })).status,
    ).toBe(404);
    expect((await as(memberToken, 'DELETE', '/projects/PRV/members/@member')).status).toBe(404);
    expect((await as(undefined, 'GET', '/projects/PRV/members')).status).toBe(404);
    expect((await as(undefined, 'GET', '/projects/PUB/members')).status).toBe(200);
    expect(
      (await as(undefined, 'POST', '/projects/PUB/members', { user: '@member', role: 'viewer' }))
        .status,
    ).toBe(401);
    expect((await as(undefined, 'POST', '/projects/PUB/repos', { repo: 'acme/app' })).status).toBe(
      401,
    );
    expect((await as(undefined, 'DELETE', '/projects/PUB/members/@member')).status).toBe(401);
    expect(
      (await as(memberToken, 'POST', '/projects/PUB/repos', { repo: 'acme/app' })).status,
    ).toBe(403);
  });

  it('forbids non-managers to unlink repos or remove members', async () => {
    expect(
      (await asAdmin('/projects', { method: 'POST', body: { key: 'SRV', name: 'Srv' } })).status,
    ).toBe(201);
    expect(
      (await as(adminToken, 'POST', '/projects/SRV/members', { user: '@member', role: 'viewer' }))
        .status,
    ).toBe(201);
    expect(
      (await as(adminToken, 'POST', '/projects/SRV/members', { user: '@bot', role: 'editor' }))
        .status,
    ).toBe(201);
    expect((await as(adminToken, 'POST', '/projects/SRV/repos', { repo: 'acme/srv' })).status).toBe(
      201,
    );
    const botToken = await sso.bearer('bot');

    // A viewer (the member) and an editor (the bot) both get 403, not 404: they can see the project.
    for (const [who, token] of [
      ['viewer', memberToken],
      ['editor', botToken],
    ] as const) {
      const repo = await as(
        token,
        'DELETE',
        `/projects/SRV/repos/${encodeURIComponent('acme/srv')}`,
      );
      expect(repo.status, `${who} unlinking a repo`).toBe(403);
      expect(((await repo.json()) as { code: string }).code).toBe('FORBIDDEN');
      const member = await as(token, 'DELETE', '/projects/SRV/members/@bot');
      expect(member.status, `${who} removing a member`).toBe(403);
      expect(((await member.json()) as { code: string }).code).toBe('FORBIDDEN');
    }

    // Nothing was removed.
    const shown = (await (await as(adminToken, 'GET', '/projects/SRV')).json()) as {
      repos: { fullName: string }[];
    };
    expect(shown.repos.map((r) => r.fullName)).toEqual(['acme/srv']);
    const members = (await (await as(adminToken, 'GET', '/projects/SRV/members')).json()) as {
      data: { user: { handle: string } }[];
    };
    expect(members.data.map((m) => m.user.handle)).toEqual(['bot', 'member']);
  });
});

describe(`"me" as a user path parameter (${testDialect()})`, () => {
  it('resolves to the caller on user and token routes', async () => {
    const me = await as(memberToken, 'GET', '/users/me');
    expect(me.status).toBe(200);
    expect(((await me.json()) as { handle: string }).handle).toBe('member');
    const atMe = await as(adminToken, 'GET', '/users/@me');
    expect(((await atMe.json()) as { handle: string }).handle).toBe('admin');

    const list = await as(memberToken, 'GET', '/users/me/tokens');
    expect(list.status).toBe(200);
    const before = ((await list.json()) as { data: { id: string }[] }).data;
    expect(before.length).toBeGreaterThan(0);

    const created = await as(memberToken, 'POST', '/users/me/tokens', { name: 'via me' });
    expect(created.status).toBe(201);
    const token = (await created.json()) as { id: string; token: string };
    // The new token belongs to the caller, so it signs in as the member.
    const check = await as(token.token, 'GET', '/users/me');
    expect(((await check.json()) as { handle: string }).handle).toBe('member');
    const after = (
      (await (await as(memberToken, 'GET', '/users/me/tokens')).json()) as {
        data: { id: string }[];
      }
    ).data;
    expect(after.map((x) => x.id)).toContain(token.id);
    expect((await as(memberToken, 'DELETE', `/tokens/${token.id}`)).status).toBe(200);
  });

  it('is not a way around sign-in or around other users', async () => {
    expect((await as(undefined, 'GET', '/users/me')).status).toBe(401);
    expect((await as(undefined, 'GET', '/users/me/tokens')).status).toBe(401);
    expect((await as(undefined, 'POST', '/users/me/tokens', { name: 'x' })).status).toBe(401);
    // "me" is the member, so a member can't use it to reach the admin's tokens.
    const mine = (await (await as(memberToken, 'GET', '/users/me/tokens')).json()) as {
      data: { id: string }[];
    };
    const admins = (await (await as(adminToken, 'GET', '/users/admin/tokens')).json()) as {
      data: { id: string }[];
    };
    expect(mine.data.some((x) => admins.data.some((a) => a.id === x.id))).toBe(false);
    expect((await as(memberToken, 'GET', '/users/admin/tokens')).status).toBe(403);
  });
});
