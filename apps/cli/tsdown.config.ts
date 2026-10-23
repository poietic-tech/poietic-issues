import { defineConfig } from 'tsdown';

/**
 * The published module (`pnpm --filter @poietic-tech/issues build:module`): `dist/poietic-tech.js`, the entry the
 * `poietic-tech` host imports. Workspace packages and pure-JS libraries are inlined; commander and the host
 * itself are the host's, and the module imports them for types only.
 */
export default defineConfig({
  entry: { 'poietic-tech': 'src/module/index.ts' },
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: true,
  fixedExtension: false,
  dts: false,
  sourcemap: false,
  deps: {
    alwaysBundle: [/.*/],
    neverBundle: ['commander', /^@poietic-tech\/cli(\/|$)/],
    onlyBundle: false,
  },
});
