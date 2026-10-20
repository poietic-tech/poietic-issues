import { Command, CommanderError, Option } from 'commander';
import { toCliError } from './errors.ts';
import type { CliIO } from './io.ts';
import { dbCommand, serveCommand } from './local/commands.ts';
import { adminTree } from './runtime.ts';
import { registerTree } from './tree/index.ts';

export const CLI_VERSION = '0.1.0';

/** The operator tool's name, in help and in the messages the command tree prints. */
export const ADMIN_NAME = 'poietic-issues-admin';

/**
 * Builds the operator tool: the command tree over the in-process app on a local database (trusted mode, acting
 * as `--actor`), plus `db` and `serve`. Pure: no I/O until an action runs.
 */
export function buildProgram(io: CliIO): Command {
  const program = new Command(ADMIN_NAME)
    .description(
      'Operator tool for poietic-issues: the command tree over a local database (trusted mode), plus db and\n' +
        'serve. Never published; remote callers use `poietic-tech issues`.\n\n' +
        'Machine use: add --json (or set POIETIC_ISSUES_FORMAT=json); errors go to stderr as problem JSON with stable\n' +
        `codes; exit codes are documented (\`${ADMIN_NAME} commands --json\`). Nothing ever prompts.`,
    )
    .version(CLI_VERSION, '-V, --version')
    .addOption(
      new Option(
        '--database <url>',
        'database URL, e.g. sqlite:./data/dev.db (default from POIETIC_ISSUES_DATABASE_URL)',
      ),
    )
    .addOption(
      new Option(
        '--actor <handle>',
        'act as this user (default from POIETIC_ISSUES_ACTOR, else the first admin)',
      ),
    )
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
  // The shared command tree, with this tool's local-only commands interleaved in the existing help order.
  const tree = adminTree(io, ADMIN_NAME);
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
