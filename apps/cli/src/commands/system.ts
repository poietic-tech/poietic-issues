import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Schemas, unwrap } from '@poietic-tech/issues-client';
import {
  CommentSchema,
  CreateCommentInputSchema,
  CreateIssueInputSchema,
  CreateLinkInputSchema,
  CreateProjectInputSchema,
  CreateViewInputSchema,
  EventSchema,
  inputSchema,
  IssueFilterSchema,
  IssueLinkSchema,
  IssueSchema,
  MoveIssueInputSchema,
  ProblemSchema,
  ProjectSchema,
  UpdateIssueInputSchema,
  ViewConfigSchema,
} from '@poietic-tech/issues-schema';
import type { Command, Option } from 'commander';
import { z } from 'zod';
import { PROJECT_CONFIG_FILE } from '../config.ts';
import { CliError, usage } from '../errors.ts';
import { actWithGlobals, keyValues, readJsonArg } from '../tree/args.ts';
import type { Reference, Tree } from '../tree/runtime.ts';

/** Schemas exposed by the `schema <name>` command (JSON Schema, draft 2020-12). */
const SCHEMAS: Record<string, { schema: z.ZodType; io: 'input' | 'output' }> = {
  issue: { schema: IssueSchema, io: 'output' },
  'issue-create': { schema: CreateIssueInputSchema, io: 'input' },
  'issue-update': { schema: UpdateIssueInputSchema, io: 'input' },
  'issue-move': { schema: MoveIssueInputSchema, io: 'input' },
  'issue-filter': { schema: IssueFilterSchema, io: 'input' },
  comment: { schema: CommentSchema, io: 'output' },
  'comment-create': { schema: CreateCommentInputSchema, io: 'input' },
  link: { schema: IssueLinkSchema, io: 'output' },
  'link-create': { schema: CreateLinkInputSchema, io: 'input' },
  project: { schema: ProjectSchema, io: 'output' },
  'project-create': { schema: CreateProjectInputSchema, io: 'input' },
  'view-create': { schema: CreateViewInputSchema, io: 'input' },
  'view-config': { schema: ViewConfigSchema, io: 'input' },
  event: { schema: EventSchema, io: 'output' },
  problem: { schema: ProblemSchema, io: 'output' },
};

function jsonSchema(name: string): Record<string, unknown> {
  const entry = SCHEMAS[name];
  if (!entry)
    throw usage(`Unknown schema "${name}" (available: ${Object.keys(SCHEMAS).join(', ')})`);
  if (entry.io === 'input') return inputSchema(entry.schema);
  return z.toJSONSchema(entry.schema, {
    io: 'output',
    target: 'draft-2020-12',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
}

/** `GET /me` answers `{ anonymous: true }` without credentials; the CLI treats that as not signed in. */
export function signedIn(me: Schemas['Me'], commandName: string): Schemas['User'] {
  if ('anonymous' in me)
    throw new CliError(
      'UNAUTHENTICATED',
      `Not signed in: the server answered \`${commandName} whoami\` as it answers an anonymous visitor`,
    );
  return me;
}

export function registerWhoami(parent: Command, tree: Tree): Command {
  return parent
    .command('whoami')
    .description('Show the user the CLI acts as')
    .action(
      tree.act(async (rt) => {
        const api = await rt.api();
        rt.out.item(
          'user',
          signedIn(await rt.call(api.GET('/me')), tree.commandName),
          (u) => `@${String(u.handle)} (${String(u.kind)}, ${String(u.role)})\n`,
        );
      }),
    );
}

export function registerInit(parent: Command, tree: Tree): Command {
  return parent
    .command('init')
    .description(`Write ${PROJECT_CONFIG_FILE} here: ${tree.init.describe} (never tokens)`)
    .option('--force', 'overwrite an existing file')
    .action(
      actWithGlobals(tree, async (rt, _a, _o, o) => {
        const path = join(rt.io.cwd, PROJECT_CONFIG_FILE);
        if (existsSync(path) && !o.force) throw usage(`${path} exists (use --force to overwrite)`);
        const config = tree.init.entries(o, rt.io.env);
        writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
        rt.out.raw(`Wrote ${path}\n`);
      }),
    );
}

export function registerSchema(parent: Command, tree: Tree): Command {
  return parent
    .command('schema')
    .description(
      'Print a JSON Schema: resources and inputs (use `project schema` for live per-project enums)',
    )
    .argument('[name]', `one of: ${Object.keys(SCHEMAS).join(', ')}`)
    .action(
      tree.act(async (rt, [name]) => {
        if (!name) {
          rt.out.raw(`${Object.keys(SCHEMAS).join('\n')}\n`);
          return;
        }
        rt.out.raw(`${JSON.stringify(jsonSchema(String(name)), null, 2)}\n`);
      }),
    );
}

export function registerApi(parent: Command, tree: Tree): Command {
  return parent
    .command('api')
    .description('Call any API endpoint directly and print the JSON response (like `gh api`)')
    .argument('<method>', 'GET, POST, PATCH, DELETE')
    .argument('<path>', 'path under /api/v1, e.g. /issues/ENG-1')
    .option('--input <json|@file|->', 'request body (JSON)')
    .option(
      '-f, --field <key=value>',
      'body field (repeatable; values parsed as JSON when possible)',
      (v: string, p: string[] = []) => [...p, v],
    )
    .option(
      '--query <key=value>',
      'query parameter (repeatable)',
      (v: string, p: string[] = []) => [...p, v],
    )
    .action(
      tree.act(async (rt, [method, path], o) => {
        const api = await rt.api();
        const body = o.input
          ? await readJsonArg(rt.io, String(o.input), '--input')
          : keyValues(o.field as string[] | undefined);
        const query = Object.fromEntries(
          ((o.query as string[] | undefined) ?? []).map((q) => {
            const i = q.indexOf('=');
            if (i <= 0) throw usage(`--query expects key=value, got "${q}"`);
            return [q.slice(0, i), q.slice(i + 1)];
          }),
        );
        const verb = String(method).toUpperCase() as 'GET';
        const cleanPath = `/${String(path)
          .replace(/^\/+/, '')
          .replace(/^api\/v1\//, '')}`;
        const request = (
          api as unknown as Record<
            string,
            (
              p: string,
              init: unknown,
            ) => Promise<{ data?: unknown; error?: unknown; response: Response }>
          >
        )[verb];
        if (!request) throw usage(`Unsupported method ${String(method)}`);
        const result = await request(cleanPath, { params: { query }, ...(body && { body }) });
        const data = unwrap(result);
        rt.out.raw(`${JSON.stringify(data ?? null, null, 2)}\n`);
      }),
    );
}

interface CommandInfo {
  name: string;
  aliases: string[];
  description: string;
  arguments: Array<{ name: string; required: boolean; variadic: boolean; description: string }>;
  options: Array<{
    flags: string;
    name: string;
    description: string;
    required: boolean;
    takesValue: boolean;
    default?: unknown;
  }>;
}

function describeOption(opt: Option) {
  return {
    flags: opt.flags,
    name: opt.attributeName(),
    description: opt.description,
    required: Boolean(opt.mandatory),
    takesValue: Boolean(opt.required || opt.optional),
    ...(opt.defaultValue !== undefined && { default: opt.defaultValue }),
  };
}

/** Flattened description of every leaf command — the agent's one-call map of the CLI. */
export function describeCommands(
  program: Command,
  reference: Reference,
): {
  commands: CommandInfo[];
  globalOptions: ReturnType<typeof describeOption>[];
} & Reference {
  const commands: CommandInfo[] = [];
  const walk = (cmd: Command, prefix: string[]) => {
    for (const sub of cmd.commands) {
      const path = [...prefix, sub.name()];
      if (sub.commands.length) walk(sub, path);
      else
        commands.push({
          name: path.join(' '),
          aliases: sub.aliases(),
          description: sub.description(),
          arguments: sub.registeredArguments.map((a) => ({
            name: a.name(),
            required: a.required,
            variadic: a.variadic,
            description: a.description,
          })),
          options: sub.options.map(describeOption),
        });
    }
  };
  walk(program, []);
  return {
    commands,
    globalOptions: program.options.map(describeOption),
    ...reference,
  };
}

/**
 * `commands`: describes `root()` (the command tree it is registered in, with its global options) as JSON,
 * whatever the output format: the host owns the format, and this reference has one shape.
 */
export function registerCommands(parent: Command, tree: Tree, root: () => Command): Command {
  const reference = tree.reference;
  if (!reference) throw new Error('The `commands` command needs the tree’s reference');
  return parent
    .command('commands')
    .description('Describe every command, option, exit code and error code as JSON (for agents)')
    .action(
      tree.act(async (rt) => {
        rt.out.raw(`${JSON.stringify(describeCommands(root(), reference), null, 2)}\n`);
      }),
    );
}
