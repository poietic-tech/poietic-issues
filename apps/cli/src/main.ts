import { Command, CommanderError, Option } from 'commander';
import { toCliError } from './errors.ts';
import type { CliIO } from './io.ts';
import { authCommand, dbCommand, serveCommand } from './local/commands.ts';
import { adminTree } from './runtime.ts';
import { registerTree } from './tree/index.ts';

export const CLI_VERSION = '0.1.0';

/** Builds the command tree. Pure: no I/O until an action runs. */
export function buildProgram(io: CliIO): Command {
  const program = new Command('poietic-issues')
    .description(
      'Command-line interface to poietic-issues — designed for humans and AI agents.\n\n' +
        'Machine use: add --json (or set POIETIC_ISSUES_FORMAT=json); errors go to stderr as problem JSON with stable\n' +
        'codes; exit codes are documented (`poietic-issues commands --json`). Nothing ever prompts.',
    )
    .version(CLI_VERSION, '-V, --version')
    .addOption(new Option('--server <url>', 'poietic-issues server URL (remote mode)'))
    .addOption(new Option('--token <token>', 'API token (remote mode)'))
    .addOption(
      new Option('--database <url>', 'database URL (local mode), e.g. sqlite:./data/dev.db'),
    )
    .addOption(new Option('--actor <handle>', 'local mode: act as this user'))
    .addOption(
      new Option(
        '-P, --project <key>',
        'project key (default from POIETIC_ISSUES_PROJECT or .poietic-issues.json)',
      ),
    )
    .addOption(
      new Option('--format <format>', 'output format').choices(['table', 'json', 'ndjson', 'ids']),
    )
    .addOption(new Option('--json', 'JSON output (same as --format json)'))
    .addOption(new Option('-q, --quiet', 'print only ids/keys (same as --format ids)'))
    .addOption(
      new Option('--fields <fields>', 'comma-separated fields to include, e.g. key,title,status'),
    )
    .showSuggestionAfterError(true)
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.stdout(s),
      writeErr: (s) => io.stderr(s),
      outputError: () => {}, // rendered by run() so --json can format it
    });
  // The shared command tree, with this binary's local-only commands interleaved in the existing help order.
  const tree = adminTree(io);
  registerTree(program, tree, [
    'issue',
    'comment',
    'link',
    'attachment',
    'project',
    'status',
    'label',
    'field',
    'view',
    'event',
    'webhook',
    'user',
  ]);
  program.addCommand(authCommand(io));
  registerTree(program, tree, ['whoami', 'init']);
  program.addCommand(dbCommand(io));
  program.addCommand(serveCommand(io));
  registerTree(program, tree, ['schema', 'api', 'commands']);
  for (const cmd of program.commands) configureRecursively(cmd, io);
  return program;
}

function configureRecursively(cmd: Command, io: CliIO) {
  cmd.exitOverride().configureOutput({
    writeOut: (s) => io.stdout(s),
    writeErr: (s) => io.stderr(s),
    outputError: () => {},
  });
  cmd.showSuggestionAfterError(true);
  for (const sub of cmd.commands) configureRecursively(sub, io);
}

/** Runs the CLI with the given arguments and returns the exit code (never calls process.exit). */
export async function run(argv: string[], io: CliIO): Promise<number> {
  const program = buildProgram(io);
  const wantsJson =
    argv.includes('--json') ||
    argv.includes('--format=json') ||
    io.env.POIETIC_ISSUES_FORMAT === 'json' ||
    argv.some((a, i) => a === '--format' && ['json', 'ndjson'].includes(argv[i + 1] ?? ''));
  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return 0; // --help, --version
      const message = error.message.replace(/^error: /, '');
      if (wantsJson)
        io.stderr(
          `${JSON.stringify({ code: 'VALIDATION_FAILED', status: 400, detail: message })}\n`,
        );
      else io.stderr(`error: ${message}\n(see --help)\n`);
      return 2;
    }
    const e = toCliError(error);
    if (wantsJson) {
      io.stderr(
        `${JSON.stringify({ code: e.code, detail: e.message, ...(e.errors?.length && { errors: e.errors }) })}\n`,
      );
    } else {
      io.stderr(`error: ${e.message}${e.code === 'INTERNAL' ? '' : ` [${e.code}]`}\n`);
      for (const fe of e.errors ?? [])
        if (!e.message.includes(fe.message)) io.stderr(`  ${fe.path}: ${fe.message}\n`);
    }
    return e.exitCode;
  }
}
