import { describe, expect, it } from 'vitest';
import { applyLegacyEnv, legacyEnvWarning } from './legacy-env.ts';

describe('applyLegacyEnv', () => {
  it('copies TRACKER_* to POIETIC_ISSUES_* when the new name is unset', () => {
    const env: Record<string, string | undefined> = {
      TRACKER_PORT: '4000',
      TRACKER_TOKEN: 'old',
      POIETIC_ISSUES_TOKEN: 'new',
      OTHER: 'x',
    };
    expect(applyLegacyEnv(env)).toEqual(['TRACKER_PORT']);
    expect(env.POIETIC_ISSUES_PORT).toBe('4000');
    expect(env.POIETIC_ISSUES_TOKEN).toBe('new');
  });

  it('never carries TRACKER_TOKEN over: it held a retired trk_ API token', () => {
    const env: Record<string, string | undefined> = { TRACKER_TOKEN: 'trk_old' };
    expect(applyLegacyEnv(env)).toEqual([]);
    expect(env.POIETIC_ISSUES_TOKEN).toBeUndefined();
  });

  it('warns only when a legacy name was used', () => {
    expect(legacyEnvWarning([])).toBeUndefined();
    expect(legacyEnvWarning(['TRACKER_PORT'])).toContain('TRACKER_PORT → POIETIC_ISSUES_PORT');
  });
});
