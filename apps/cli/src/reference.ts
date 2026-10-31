import type { describeCommands } from './commands/system.ts';

type Info = ReturnType<typeof describeCommands>;

/** Renders `poietic-tech issues commands` output as the markdown reference in docs/cli-reference.md. */
export function renderCliReference(info: Info): string {
  const esc = (s: string) => s.replace(/[\\|]/g, '\\$&');
  const lines = [
    '# CLI reference',
    '',
    '<!-- Generated from `poietic-tech issues commands` by the CLI test suite. Do not edit; run `pnpm vitest run --project cli -u`. -->',
    '',
    'See [cli.md](cli.md) for concepts, output formats and configuration.',
    '',
    '## Global options',
    '',
    'Options of `poietic-tech issues`, which every subcommand inherits. The output format is the host’s:',
    '`--json`, `--format table|json|ndjson|ids` and `-q` come from `poietic-tech` (see `poietic-tech --help`).',
    '',
    '| Option | Description |',
    '| --- | --- |',
    ...info.globalOptions.map((o) => `| \`${o.flags}\` | ${esc(o.description)} |`),
    '',
    '## Exit codes',
    '',
    'The exit codes of `poietic-tech` (`poietic-tech help exit-codes`), as this module’s failures use them.',
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
    lines.push(`### \`poietic-tech issues ${[c.name, ...args].join(' ')}\``, '', c.description, '');
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
