import { defineConfig } from 'vitest/config';

// Each workspace package is its own Vitest project so suites can be run and reported per package.
export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'apps/server',
      'apps/cli',
      'apps/web',
      'apps/github-sync',
      'deploy/cloudflare',
    ],
    passWithNoTests: true,
  },
});
