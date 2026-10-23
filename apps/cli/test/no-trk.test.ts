import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Where the retired credential may still be named, each for a stated reason. Everything else must be clean.
const allowed = [
  // History, never rewritten.
  'docs/adr',
  'docs/superpowers',
  'packages/db/src/migrations', // 0007_drop_api_tokens and the migrations before it
  'apps/cli/test/no-trk.test.ts', // this test names the patterns
  // Negative tests: an old `trk_` bearer must be rejected (401), never honoured.
  'apps/server/src/access.test.ts',
  'apps/server/src/api.test.ts',
  'apps/server/src/sso.test.ts',
  'apps/server/src/sso/verifier.test.ts',
  'apps/server/src/testing.ts', // the fake verifier fails `trk_` values as the real one does
  // The legacy-env shim must never carry the old `TRACKER_TOKEN` (a `trk_` value) over, and a test proves it.
  'packages/core/src/legacy-env.ts',
  'packages/core/src/legacy-env.test.ts',
  // The CLI's config test proves a retired POIETIC_ISSUES_TOKEN in the environment is ignored.
  'apps/cli/src/config.test.ts',
];

describe('the retired API token', () => {
  it('is named nowhere outside ADRs, history and negative tests', async () => {
    const args = [
      'grep',
      '-n',
      '-e',
      'trk_',
      '-e',
      'POIETIC_ISSUES_TOKEN',
      '-e',
      'poietic-issues token',
      '--',
      '.',
      ...allowed.map((p) => `:(exclude)${p}`),
    ];
    const out = await promisify(execFile)('git', args, { cwd: root }).then(
      (r) => r.stdout,
      (e: { code?: number; stdout?: string }) => {
        if (e.code === 1) return ''; // git grep: no match
        throw e;
      },
    );
    expect(out).toBe('');
  });
});
