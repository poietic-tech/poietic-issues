import type { describeCommands } from './commands/system.ts';

type Info = ReturnType<typeof describeCommands>;

/** Renders `poietic-issues-admin commands --json` output as the markdown reference in docs/cli-reference.md. */
export function renderCliReference(info: Info): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|');
  const lines = [
    '# CLI reference',
    '',
    '<!-- Generated from `poietic-issues-admin commands --json` by the CLI test suite. Do not edit; run `pnpm vitest run --project cli -u`. -->',
    '',
    'See [cli.md](cli.md) for concepts, output formats and configuration.',
    '',
    '## Global options',
    '',
    '| Option | Description |',
    '| --- | --- |',
    ...info.globalOptions.map((o) => `| \`${o.flags}\` | ${esc(o.description)} |`),
    '',
    '## Exit codes',
    '',
    '| Code | Meaning |',
    '| --- | --- |',
    ...Object.entries(info.exitCodes).map(([code, meaning]) => `| ${code} | ${meaning} |`),
    '',
    '## Commands',
    '',
  ];
  for (const c of info.commands) {
    const args = c.arguments.map((a) =>
      a.required
        ? `<${a.name}${a.variadic ? '...' : ''}>`
        : `[${a.name}${a.variadic ? '...' : ''}]`,
    );
    lines.push(`### \`tracker ${[c.name, ...args].join(' ')}\``, '', c.description, '');
    if (c.aliases.length) lines.push(`Aliases: ${c.aliases.map((a) => `\`${a}\``).join(', ')}`, '');
    if (c.arguments.length) {
      lines.push('| Argument | Description |', '| --- | --- |');
      for (const a of c.arguments)
        lines.push(`| \`${a.name}\` | ${esc(a.description)}${a.required ? '' : ' (optional)'} |`);
      lines.push('');
    }
    if (c.options.length) {
      lines.push('| Option | Description |', '| --- | --- |');
      for (const o of c.options)
        lines.push(
          `| \`${o.flags}\` | ${esc(o.description)}${o.required ? ' **(required)**' : ''}${o.default !== undefined ? ` (default: \`${String(o.default)}\`)` : ''} |`,
        );
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}
