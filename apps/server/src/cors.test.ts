import { createLabel, createProject } from '@poietic-tech/issues-core';
import { createTestContext, grantGroup, type TestContext } from '@poietic-tech/issues-core/testing';
import { testDialect } from '@poietic-tech/issues-db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { testSso } from './testing.ts';

const BASE = 'http://tracker.test';
const NEWSROOM = 'https://newsroom.example.test';
const STAGING = 'https://newsroom-staging.example.test';
const EVIL = 'https://evil.example';

let t: TestContext;
let sso: ReturnType<typeof testSso>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  t = await createTestContext();
  sso = testSso(t);
  app = createApp({
    db: t.db,
    auth: {
      mode: 'standard',
      allowDevLogin: true,
      allowedOrigins: [NEWSROOM, STAGING],
      sso: { ...sso.options, memberGroup: 'crew' },
    },
  });
  await createProject(t.ctx, { key: 'news', name: 'Newsroom' });
  await createLabel(t.ctx, 'NEWS', { name: 'staging' });
  await grantGroup(t, 'NEWS', 'crew', 'editor');
});
afterAll(() => t.destroy());

const corsHeaders = (res: Response) =>
  [...res.headers.keys()].filter((name) => name.startsWith('access-control-'));

function preflight(path: string, origin: string, headers = 'content-type, x-change-reason') {
  return app.request(`${BASE}/api/v1${path}`, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': headers,
    },
  });
}

/** Signs a crew member in through `POST /auth/sso` from `origin`, as the newsroom's page does. */
function ssoSignIn(subject: string, origin: string) {
  return app.request(`${BASE}/api/v1/auth/sso`, {
    method: 'POST',
    headers: { origin, cookie: `example_session=${subject}`, 'sec-fetch-site': 'same-site' },
  });
}

function createIssue(cookie: string, origin: string) {
  return app.request(`${BASE}/api/v1/projects/NEWS/issues`, {
    method: 'POST',
    headers: {
      origin,
      cookie,
      'content-type': 'application/json',
      'x-change-reason': 'Reader%20feedback',
    },
    body: JSON.stringify({
      title: 'Headline is wrong',
      description: 'The **headline** misstates the date.',
      labels: ['staging'],
      metadata: {
        'newsroom.feedback_id': 'fb_1',
        'newsroom.article_url': 'https://newsroom.example.test/a/1',
      },
    }),
  });
}

describe(`CORS for allowed origins (${testDialect()})`, () => {
  it('answers a preflight from an allowed origin with 204 and the methods and headers the API needs', async () => {
    for (const [path, origin] of [
      ['/auth/sso', NEWSROOM],
      ['/projects/NEWS/issues', NEWSROOM],
      ['/issues/NEWS-1', STAGING],
    ] as const) {
      const res = await preflight(path, origin);
      expect(res.status, path).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe(origin);
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
      const methods = res.headers.get('access-control-allow-methods')!.split(/,\s*/);
      expect(methods).toEqual(expect.arrayContaining(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']));
      const allowed = res.headers.get('access-control-allow-headers')!.toLowerCase().split(/,\s*/);
      expect(allowed).toEqual(
        expect.arrayContaining([
          'content-type',
          'x-change-reason',
          'if-match',
          'idempotency-key',
          'authorization',
        ]),
      );
      expect(res.headers.get('vary')).toMatch(/\bOrigin\b/);
      expect(await res.text()).toBe('');
    }
  });

  it('gives other origins, and requests without one, no CORS headers at all', async () => {
    for (const origin of [EVIL, 'null', 'https://newsroom.example.test.evil.example', '*']) {
      const res = await preflight('/projects/NEWS/issues', origin);
      expect(res.status, origin).not.toBe(204);
      expect(corsHeaders(res), origin).toEqual([]);
      const get = await app.request(`${BASE}/api/v1/auth/config`, { headers: { origin } });
      expect(get.status).toBe(200);
      expect(corsHeaders(get), origin).toEqual([]);
      expect(get.headers.get('vary')).toMatch(/\bOrigin\b/);
    }
    expect(corsHeaders(await app.request(`${BASE}/api/v1/auth/config`))).toEqual([]);
  });

  it('adds no CORS headers when no origins are allowed, nor outside the API', async () => {
    const plain = createApp({ db: t.db, auth: { mode: 'standard', sso: sso.options } });
    const res = await plain.request(`${BASE}/api/v1/projects/NEWS/issues`, {
      method: 'OPTIONS',
      headers: { origin: NEWSROOM, 'access-control-request-method': 'POST' },
    });
    expect(corsHeaders(res)).toEqual([]);
    expect(res.headers.get('vary')).toBeNull();
    const health = await app.request(`${BASE}/healthz`, { headers: { origin: NEWSROOM } });
    expect(corsHeaders(health)).toEqual([]);
  });

  it('signs in through POST /auth/sso from an allowed origin, with CORS headers on the answer', async () => {
    const res = await ssoSignIn('test-reporter+crew', NEWSROOM);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(NEWSROOM);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^poietic_issues_session=/);
    // Host-only (no Domain), Path=/ and SameSite=Lax: a same-site page's credentialed fetches send it back.
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it('still refuses POST /auth/sso from another origin, without CORS headers', async () => {
    const res = await ssoSignIn('test-reporter2+crew', EVIL);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('FORBIDDEN');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(corsHeaders(res)).toEqual([]);
  });

  it('accepts a cookie-authenticated write from an allowed origin and still rejects other origins', async () => {
    const signIn = await ssoSignIn('test-writer+crew', STAGING);
    const cookie = signIn.headers.get('set-cookie')!.split(';')[0]!;

    const created = await createIssue(cookie, STAGING);
    expect(created.status).toBe(201);
    expect(created.headers.get('access-control-allow-origin')).toBe(STAGING);
    expect(created.headers.get('access-control-allow-credentials')).toBe('true');
    expect(created.headers.get('access-control-expose-headers')).toMatch(/\bLocation\b/);
    expect(await created.json()).toMatchObject({
      key: expect.stringMatching(/^NEWS-\d+$/),
      labels: [expect.objectContaining({ name: 'staging' })],
      metadata: { 'newsroom.feedback_id': 'fb_1' },
    });

    const forged = await createIssue(cookie, EVIL);
    expect(forged.status).toBe(403);
    expect(((await forged.json()) as { code: string }).code).toBe('FORBIDDEN');
    expect(corsHeaders(forged)).toEqual([]);
  });

  it('puts CORS headers on problem responses, so the page can read the error', async () => {
    const res = await app.request(`${BASE}/api/v1/projects/NEWS/issues`, {
      method: 'POST',
      headers: { origin: NEWSROOM, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Anonymous' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(res.headers.get('access-control-allow-origin')).toBe(NEWSROOM);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });
});
