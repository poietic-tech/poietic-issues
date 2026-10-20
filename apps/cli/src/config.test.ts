import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findProjectConfig, resolveConfig } from './config.ts';
import type { CliIO } from './io.ts';

const io = (cwd: string, env: CliIO['env'] = {}): CliIO => ({
  stdout: () => {},
  stderr: () => {},
  env,
  cwd,
  readStdin: async () => '',
  isTTY: false,
});

describe('pre-rename config locations (ADR 0020)', () => {
  it('reads .tracker.json when there is no .poietic-issues.json, preferring the new name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'poietic-issues-config-'));
    writeFileSync(join(dir, '.tracker.json'), JSON.stringify({ project: 'OLD' }));
    expect(findProjectConfig(dir)?.config.project).toBe('OLD');
    writeFileSync(join(dir, '.poietic-issues.json'), JSON.stringify({ project: 'NEW' }));
    expect(findProjectConfig(dir)?.config.project).toBe('NEW');
  });
});

describe('resolveConfig (local mode only)', () => {
  it('ignores a server and token from the environment and the project file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'poietic-issues-config-'));
    writeFileSync(
      join(dir, '.poietic-issues.json'),
      JSON.stringify({ server: 'https://issues.example.test', project: 'ENG' }),
    );
    const config = resolveConfig(
      {},
      io(dir, {
        POIETIC_ISSUES_SERVER: 'https://issues.example.test',
        POIETIC_ISSUES_TOKEN: 'identity.jwt.x',
      }),
    );
    expect(config).toEqual({
      database: `sqlite:${join(dir, 'data', 'dev.db')}`,
      actor: 'admin',
      project: 'ENG',
      format: 'table',
      sources: { database: 'default', project: '.poietic-issues.json' },
      projectConfigPath: join(dir, '.poietic-issues.json'),
    });
  });

  it('resolves a relative SQLite path in the project file against that file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'poietic-issues-config-'));
    writeFileSync(join(dir, '.poietic-issues.json'), JSON.stringify({ database: 'sqlite:x.db' }));
    expect(resolveConfig({}, io(dir)).database).toBe(`sqlite:${join(dir, 'x.db')}`);
  });

  it('refuses a project file holding a token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'poietic-issues-config-'));
    writeFileSync(join(dir, '.poietic-issues.json'), JSON.stringify({ token: 'secret' }));
    expect(() => resolveConfig({}, io(dir))).toThrow(/must not contain tokens/);
  });
});
