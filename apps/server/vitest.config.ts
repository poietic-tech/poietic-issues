import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'server',
    // Inlined so vi.resetModules() also resets its module-scope JWKS cache (sso/verifier.test.ts).
    server: { deps: { inline: ['@poietic-tech/auth'] } },
  },
});
