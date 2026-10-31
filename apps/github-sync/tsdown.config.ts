import { defineConfig } from 'tsdown';

/**
 * The deployable bundle (`pnpm --filter @poietic-tech/issues-github-sync build`): `dist/github-sync.mjs`, one ESM
 * file with every dependency inlined. Its state store is `node:sqlite`, so the image needs no native modules.
 */
export default defineConfig({
  entry: { 'github-sync': 'src/main.ts' },
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  target: 'node24',
  clean: true,
  dts: false,
  sourcemap: true,
  deps: {
    alwaysBundle: [/.*/],
    onlyBundle: false,
  },
});
