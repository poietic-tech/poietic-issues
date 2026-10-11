import { createTestContext, type TestContext } from '@poietic-tech/issues-core/testing';
import { testDialect } from '@poietic-tech/issues-db/testing';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { SsoOptions } from './env.ts';
import type { SsoClaims } from './sso/verifier.ts';

const BASE = 'http://tracker.test';
const ISS = 'https://auth.example.test';
let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.destroy());

/**
 * A fake verifier: the token is the subject; "admin-*" subjects carry role admin; "agent:<owner>:<n>" is an agent
 * owned by subject <owner>; "bad" fails; "down" throws.
 */
function sso(): SsoOptions {
  return {
    name: 'Example',
    cookie: 'example_session',
    issuer: ISS,
    loginUrl: `${ISS}/login`,
    refreshUrl: `${ISS}/me`,
    adminRole: 'admin',
    verifier: {
      verify: async (token) => {
        if (token === 'down') throw new Error('JWKS unavailable');
        return token === 'bad'
          ? null
          : ({
              iss: ISS,
              aud: 'x',
              sub: token,
              name: `Person ${token}`,
              role: token.startsWith('admin') ? 'admin' : 'user',
              groups: [],
              kind: token.startsWith('agent:') ? 'agent' : 'human',
              owner: token.startsWith('agent:') ? token.split(':')[1]! : null,
              sid: 's1',
              iat: 0,
              exp: 0,
            } satisfies SsoClaims);
      },
    },
  };
}

function post(app: ReturnType<typeof createApp>, cookie: string | null, origin = BASE) {
  const headers: Record<string, string> = { origin };
  if (cookie !== null) headers.cookie = `example_session=${cookie}`;
  return app.request(`${BASE}/api/v1/auth/sso`, { method: 'POST', headers });
}

describe(`SSO sign-in (${testDialect()})`, () => {
  it('advertises SSO in /auth/config', async () => {
    const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
    const res = await app.request(`${BASE}/api/v1/auth/config`);
    expect(await res.json()).toMatchObject({
      devLogin: false,
      sso: { name: 'Example', loginUrl: `${ISS}/login`, refreshUrl: `${ISS}/me` },
    });
    const off = createApp({ db: t.db, auth: { mode: 'standard' } });
    expect(await (await off.request(`${BASE}/api/v1/auth/config`)).json()).toMatchObject({
      sso: null,
    });
  });

  it('signs an admin-role identity in with a tracker session', async () => {
    const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
    const res = await post(app, 'admin-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ role: 'admin', name: 'Person admin-1' });
    const session = res.headers.get('set-cookie')!.split(';')[0]!;
    expect(session).toMatch(/^poietic_issues_session=/);
    const me = await app.request(`${BASE}/api/v1/me`, { headers: { cookie: session } });
    expect(((await me.json()) as { name: string }).name).toBe('Person admin-1');
  });

  it('still accepts the pre-rename tracker_session cookie, and logout clears it', async () => {
    const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
    const res = await post(app, 'admin-legacy');
    const value = res.headers.get('set-cookie')!.split(';')[0]!.split('=')[1]!;
    const legacy = { cookie: `tracker_session=${value}` };
    const me = await app.request(`${BASE}/api/v1/me`, { headers: legacy });
    expect(me.status).toBe(200);
    const out = await app.request(`${BASE}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { ...legacy, origin: BASE },
    });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toMatch(/^tracker_session=;/);
    const after = await app.request(`${BASE}/api/v1/me`, { headers: legacy });
    expect(await after.json()).toEqual({ anonymous: true });
  });

  it('answers PENDING_APPROVAL for a new non-admin identity, without a session', async () => {
    const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
    const res = await post(app, 'u-1');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('PENDING_APPROVAL');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('refuses an agent identity a browser session', async () => {
    const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
    await post(app, 'admin-owner');
    const res = await post(app, 'agent:admin-owner:1');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('FORBIDDEN');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('answers 401 without a valid cookie, 403 cross-origin, 404 when off', async () => {
    const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
    expect((await post(app, null)).status).toBe(401);
    expect((await post(app, 'bad')).status).toBe(401);
    expect((await post(app, 'admin-2', 'https://evil.example')).status).toBe(403);
    const off = createApp({ db: t.db, auth: { mode: 'standard' } });
    expect((await post(off, 'admin-3')).status).toBe(404);
  });

  it('answers 503 UNAVAILABLE, with no session, when the verifier cannot reach the issuer', async () => {
    const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
    const res = await post(app, 'down');
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('UNAVAILABLE');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('logs a warning when the verifier fails', async () => {
    const lines: string[] = [];
    const logger = pino({ level: 'warn' }, { write: (l: string) => void lines.push(l) });
    const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() }, logger });
    await post(app, 'down');
    expect(lines.join('')).toContain('JWKS unavailable');
  });

  describe('identity tokens in the Authorization header', () => {
    const bearer = (token: string, extra: Record<string, string> = {}) => ({
      headers: { authorization: `Bearer ${token}`, ...extra },
    });
    const code = async (res: Response) => ((await res.json()) as { code: string }).code;

    it('acts as an agent owned by its signed-in owner, provisioning it on first use', async () => {
      const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
      const owner = (await (await post(app, 'admin-own1')).json()) as { id: string };
      const res = await app.request(`${BASE}/api/v1/me`, bearer('agent:admin-own1:a'));
      expect(res.status).toBe(200);
      const me = (await res.json()) as { id: string };
      expect(me).toMatchObject({
        kind: 'agent',
        role: 'member',
        ownerId: owner.id,
        deactivatedAt: null,
      });
      const again = await app.request(`${BASE}/api/v1/me`, bearer('agent:admin-own1:a'));
      expect(((await again.json()) as { id: string }).id).toBe(me.id);
    });

    it('needs no same-origin check: an identity token is not an ambient credential', async () => {
      const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
      await post(app, 'admin-own2');
      const res = await app.request(`${BASE}/api/v1/users/me`, {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer agent:admin-own2:a',
          origin: 'https://evil.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Renamed bot' }),
      });
      expect(res.status).toBe(200);
    });

    it('refuses an agent whose owner has never signed in, and a pending human', async () => {
      const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
      const orphan = await app.request(`${BASE}/api/v1/me`, bearer('agent:nobody:a'));
      expect(orphan.status).toBe(403);
      expect(await code(orphan)).toBe('FORBIDDEN');
      const pending = await app.request(`${BASE}/api/v1/me`, bearer('u-pending'));
      expect(pending.status).toBe(403);
      expect(await code(pending)).toBe('PENDING_APPROVAL');
    });

    it('decides on its own: an invalid bearer is 401 even with a valid session cookie', async () => {
      const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
      const session = (await post(app, 'admin-own3')).headers.get('set-cookie')!.split(';')[0]!;
      const res = await app.request(`${BASE}/api/v1/me`, bearer('bad', { cookie: session }));
      expect(res.status).toBe(401);
    });

    it('treats trk_ values as API tokens, never as identity tokens', async () => {
      const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
      // The fake verifier would accept this value as a subject; it must never reach it.
      expect((await app.request(`${BASE}/api/v1/me`, bearer('trk_admin-own4'))).status).toBe(401);
    });

    it('answers 503 when the issuer is unreachable, and 401 when SSO is off', async () => {
      const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
      const down = await app.request(`${BASE}/api/v1/me`, bearer('down'));
      expect(down.status).toBe(503);
      expect(await code(down)).toBe('UNAVAILABLE');
      const off = createApp({ db: t.db, auth: { mode: 'standard' } });
      expect((await off.request(`${BASE}/api/v1/me`, bearer('admin-own5'))).status).toBe(401);
    });
  });
});
