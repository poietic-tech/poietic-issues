import { describe, expect, it } from 'vitest';
import { agentNote, formatActor } from './actors.ts';

const ada = { handle: 'ada', name: 'Ada Lovelace', kind: 'human', owner: null } as const;
const bot = {
  handle: 'opal-bot',
  name: 'Opal bot',
  kind: 'agent',
  owner: { handle: 'opal' },
} as const;

describe('formatActor', () => {
  it('shows a human by name, or by handle', () => {
    expect(formatActor(ada)).toBe('Ada Lovelace');
    expect(formatActor(ada, { label: 'handle' })).toBe('@ada');
  });

  it('marks an agent and names its owner', () => {
    expect(formatActor(bot)).toBe('Opal bot · agent · owned by @opal');
    expect(formatActor(bot, { label: 'handle' })).toBe('@opal-bot · agent · owned by @opal');
  });

  it('marks an agent without an owner, or from a snapshot that predates owners', () => {
    expect(formatActor({ ...bot, owner: null })).toBe('Opal bot · agent');
    const { owner: _, ...old } = bot;
    expect(formatActor(old)).toBe('Opal bot · agent');
  });
});

describe('agentNote', () => {
  it('is the agent suffix alone, and null for humans', () => {
    expect(agentNote(bot)).toBe('agent · owned by @opal');
    expect(agentNote({ kind: 'agent', owner: null })).toBe('agent');
    expect(agentNote(ada)).toBeNull();
  });
});
