const LEGACY_PREFIX = 'TRACKER_';
const PREFIX = 'POIETIC_ISSUES_';
/** Legacy names that are not carried over: `TRACKER_TOKEN` held a retired `trk_` API token. */
const RETIRED = new Set(['TRACKER_TOKEN']);

/**
 * Copies each legacy `TRACKER_*` variable to its `POIETIC_ISSUES_*` name when the new name is unset, and returns
 * the legacy names it copied so the caller can warn. A transition aid for the rename (ADR 0020); remove it in the
 * release after.
 */
export function applyLegacyEnv(env: Record<string, string | undefined>): string[] {
  const used: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(LEGACY_PREFIX) || RETIRED.has(name) || value === undefined) continue;
    const current = PREFIX + name.slice(LEGACY_PREFIX.length);
    if (env[current] === undefined) {
      env[current] = value;
      used.push(name);
    }
  }
  return used.sort();
}

export function legacyEnvWarning(used: string[]): string | undefined {
  if (used.length === 0) return undefined;
  const renames = used.map((name) => `${name} → ${PREFIX}${name.slice(LEGACY_PREFIX.length)}`);
  return `Deprecated environment variables (rename them; support ends in the next release): ${renames.join(', ')}`;
}
