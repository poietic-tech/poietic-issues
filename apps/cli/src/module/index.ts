import type { ModuleContext, PoieticTechModule } from '@poietic-tech/cli/module';
import type { Command } from 'commander';
import { readAll } from '../io.ts';
import { CliError, toCliError } from '../errors.ts';
import { registerTree } from '../tree/index.ts';
import type { Tree } from '../tree/runtime.ts';
import { MODULE_REFERENCE, toHostError } from './errors.ts';
import { type HostErrors, type ModuleIO, ModuleRuntime } from './runtime.ts';
import { resolveServer } from './server.ts';

export { toHostError } from './errors.ts';
export { resolveServer } from './server.ts';

/** The command name the tree uses in messages. */
export const COMMAND_NAME = 'poietic-tech issues';

/** A host CliError (from `ctx.fail`, the caller or the output), which is not this module's own. */
const isHostCliError = (e: unknown): boolean =>
  e instanceof Error && e.name === 'CliError' && !(e instanceof CliError);

function processModuleIO(): ModuleIO {
  return {
    stdout: (chunk) => void process.stdout.write(chunk),
    cwd: process.cwd(),
    readStdin: () => readAll(process.stdin),
  };
}

/**
 * Registers `poietic-tech issues …` on `ctx.program`. Every command and option is made from the host's own
 * commander objects; nothing is read (no login, no config) until an action runs.
 */
export function setup(ctx: ModuleContext, io: ModuleIO = processModuleIO()): void {
  const root: Command = ctx.program;
  root
    .option(
      '-P, --project <key>',
      'project key (default from POIETIC_ISSUES_PROJECT or .poietic-issues.json)',
    )
    .option('--fields <list>', 'comma-separated fields to include, e.g. key,title,status');
  const tree: Tree = {
    commandName: COMMAND_NAME,
    reference: MODULE_REFERENCE,
    init: {
      describe: 'the --project given, and the server from POIETIC_ISSUES_SERVER when it is set',
      entries: (globals, env) => ({
        ...(env.POIETIC_ISSUES_SERVER ? { server: resolveServer(env, io.cwd) } : {}),
        ...(typeof globals.project === 'string' ? { project: globals.project } : {}),
      }),
    },
    act:
      (handler) =>
      async (...all) => {
        const command = all.at(-1) as Command;
        const hostErrors: HostErrors = new WeakSet();
        const rt = new ModuleRuntime(ctx, io, command.optsWithGlobals(), hostErrors);
        try {
          await handler(rt, all.slice(0, -2), command.opts());
        } catch (error) {
          if (
            (typeof error === 'object' && error !== null && hostErrors.has(error)) ||
            isHostCliError(error)
          )
            throw error;
          const e = toHostError(toCliError(error));
          ctx.fail(e.code, e.message, e.status !== undefined ? { status: e.status } : undefined);
        }
      },
  };
  registerTree(root, tree);
  registerTree(root, tree, ['commands']);
}

const issues: PoieticTechModule = { api: 1, setup };
export default issues;
