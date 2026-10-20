import { defineConfig } from 'tsdown';

/**
 * Production bundles (`pnpm build`): the server and the operator tool (`poietic-issues-admin`) as single ESM
 * files in `dist/`, with every workspace package and pure-JS dependency inlined. Only native or optional modules stay external and are
 * installed next to the bundle (see Dockerfile).
 */
export default defineConfig({
  entry: {
    server: 'apps/server/src/main.ts',
    'poietic-issues-admin': 'apps/cli/src/admin-bin.ts',
  },
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: true,
  dts: false,
  sourcemap: true,
  deps: {
    alwaysBundle: [/.*/],
    neverBundle: ['better-sqlite3', 'pg-native'],
    onlyBundle: false,
  },
});
