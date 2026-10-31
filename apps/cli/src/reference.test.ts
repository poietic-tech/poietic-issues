import { describe, expect, it } from 'vitest';
import { renderCliReference } from './reference.ts';

describe('renderCliReference', () => {
  it('escapes pipes and backslashes in table cells', () => {
    const md = renderCliReference({
      globalOptions: [{ flags: '--x', description: String.raw`a|b and c\|d` }],
      exitCodes: {},
      commands: [],
    } as unknown as Parameters<typeof renderCliReference>[0]);
    expect(md).toContain('| `--x` | ' + String.raw`a\|b and c\\\|d` + ' |');
  });
});
