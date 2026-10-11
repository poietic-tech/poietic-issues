import { describe, expect, it } from 'vitest';
import type { CliIO } from './io.ts';
import { Output } from './output.ts';

const ada = {
  id: 'usr_a',
  handle: 'ada',
  name: 'Ada',
  kind: 'human',
  avatarUrl: null,
  owner: null,
};
const bot = {
  id: 'usr_b',
  handle: 'ada-bot',
  name: 'Ada bot',
  kind: 'agent',
  avatarUrl: null,
  owner: { id: 'usr_a', handle: 'ada' },
};

function table(kind: 'comment' | 'event' | 'user', rows: unknown[]): string {
  let out = '';
  const io = {
    stdout: (s) => (out += s),
    stderr: () => {},
    env: {},
    cwd: '/',
    readStdin: async () => '',
    isTTY: false,
  } satisfies CliIO;
  new Output(io, 'table', undefined).list(kind, rows);
  return out;
}

describe('actors in tables', () => {
  it('marks agents and names their owner', () => {
    const out = table('comment', [
      { id: 'cmt_1', author: ada, createdAt: '2026-01-01T00:00:00Z', body: 'Hi' },
      { id: 'cmt_2', author: bot, createdAt: '2026-01-01T00:00:00Z', body: 'On it' },
    ]);
    expect(out).toContain('@ada  ');
    expect(out).toContain('@ada-bot · agent · owned by @ada');
  });

  it('marks agents from event snapshots that predate owners', () => {
    const { owner: _, ...old } = bot;
    const out = table('event', [
      { seq: 1, type: 'issue.created', actor: old, data: {}, createdAt: '2026-01-01T00:00:00Z' },
    ]);
    expect(out).toContain('@ada-bot · agent');
    expect(out).not.toContain('owned by');
  });

  it("lists a user's owner", () => {
    const out = table('user', [
      { ...ada, role: 'admin' },
      { ...bot, role: 'member' },
    ]);
    expect(out.split('\n')[0]).toMatch(/^HANDLE\s+NAME\s+KIND\s+OWNER\s+ROLE\s+ID$/);
    expect(out).toMatch(/@ada-bot\s+Ada bot\s+agent\s+@ada\s+member/);
  });
});
