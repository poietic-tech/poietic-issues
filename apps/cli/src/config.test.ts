import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findProjectConfig, readUserConfig, userConfigPath, writeUserConfig } from './config.ts';

describe('pre-rename config locations (ADR 0020)', () => {
  it('reads .tracker.json when there is no .poietic-issues.json, preferring the new name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'poietic-issues-config-'));
    writeFileSync(join(dir, '.tracker.json'), JSON.stringify({ project: 'OLD' }));
    expect(findProjectConfig(dir)?.config.project).toBe('OLD');
    writeFileSync(join(dir, '.poietic-issues.json'), JSON.stringify({ project: 'NEW' }));
    expect(findProjectConfig(dir)?.config.project).toBe('NEW');
  });

  it('reads ~/.config/tracker until the next write moves it to ~/.config/poietic-issues', () => {
    const env = { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'poietic-issues-xdg-')) };
    mkdirSync(join(env.XDG_CONFIG_HOME, 'tracker'));
    writeFileSync(
      join(env.XDG_CONFIG_HOME, 'tracker', 'config.json'),
      JSON.stringify({ tokens: { 'http://old': 'identity.jwt.x' } }),
    );
    const config = readUserConfig(env);
    expect(config.tokens).toEqual({ 'http://old': 'identity.jwt.x' });
    expect(writeUserConfig(env, config)).toBe(userConfigPath(env));
    expect(userConfigPath(env)).toBe(join(env.XDG_CONFIG_HOME, 'poietic-issues', 'config.json'));
    expect(readUserConfig(env).tokens).toEqual({ 'http://old': 'identity.jwt.x' });
  });
});
