import type { TestContext } from '@poietic-tech/issues-core/testing';
import type { SsoOptions } from './env.ts';
import type { SsoClaims } from './sso/verifier.ts';

const ISS = 'https://auth.example.test';

/**
 * Tests authenticate with identity tokens through a fake verifier: the token is the subject. Liveness and the
 * directory are stubbed so they always succeed. `bearer(handle)` links the existing test user to a subject and returns
 * the bearer value to send.
 */
export function testSso(t: TestContext): {
  options: SsoOptions;
  bearer(handle: string): Promise<string>;
} {
  const options: SsoOptions = {
    name: 'Example',
    cookie: 'example_session',
    issuer: ISS,
    loginUrl: `${ISS}/login`,
    adminRole: 'admin',
    verifier: {
      verify: async (token) =>
        ({
          iss: ISS,
          aud: 'x',
          sub: token,
          name: `Person ${token}`,
          role: 'user',
          groups: [],
          kind: 'human',
          owner: null,
          sid: 's1',
          iat: 0,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }) satisfies SsoClaims,
    },
    liveness: { isLive: async () => true },
    directory: { refresh: async () => {} },
  };
  return {
    options,
    async bearer(handle) {
      const user = await t.db.kysely
        .selectFrom('users')
        .select('id')
        .where('handle', '=', handle)
        .executeTakeFirstOrThrow();
      const subject = `test-${handle}`;
      await t.db.kysely
        .insertInto('user_identities')
        .values({
          issuer: ISS,
          subject,
          user_id: user.id,
          created_at: new Date().toISOString(),
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      return subject;
    },
  };
}
