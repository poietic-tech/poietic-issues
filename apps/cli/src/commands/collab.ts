import type { Command } from 'commander';
import { usage } from '../errors.ts';
import { actWithGlobals, readTextArg } from '../tree/args.ts';
import type { CommandRuntime, Tree } from '../tree/runtime.ts';

type Opts = Record<string, unknown>;

/** Natural-language link aliases → [type, direction]. */
const LINK_ALIASES: Record<string, [string, 'outward' | 'inward']> = {
  blocks: ['blocks', 'outward'],
  'blocked-by': ['blocks', 'inward'],
  'is-blocked-by': ['blocks', 'inward'],
  relates: ['relates', 'outward'],
  'relates-to': ['relates', 'outward'],
  duplicates: ['duplicates', 'outward'],
  'duplicated-by': ['duplicates', 'inward'],
  'is-duplicated-by': ['duplicates', 'inward'],
};

async function bodyFrom(rt: CommandRuntime, words: string[] | undefined, o: Opts): Promise<string> {
  if (o.bodyFile) return readTextArg(rt.io, String(o.bodyFile));
  if (o.body) return String(o.body);
  if (words?.length) return words.join(' ');
  throw usage('Provide the text as arguments, --body, or --body-file <path|->');
}

export function registerComment(parent: Command, tree: Tree): Command {
  const act: Tree['act'] = (fn) => tree.act(fn);
  const cmd = parent.command('comment').description('Discuss issues');
  cmd
    .command('list')
    .alias('ls')
    .description('List comments on an issue (oldest first)')
    .argument('<issue>', 'issue key or id')
    .action(
      act(async (rt, [issue]) => {
        const api = await rt.api();
        rt.out.list(
          'comment',
          (
            await rt.call(
              api.GET('/issues/{issue}/comments', {
                params: { path: { issue: String(issue) }, query: {} },
              }),
            )
          ).data,
        );
      }),
    );
  cmd
    .command('add')
    .description('Comment on an issue (markdown)')
    .argument('<issue>', 'issue key or id')
    .argument('[text...]', 'comment text')
    .option('-b, --body <markdown>', 'comment text')
    .option('--body-file <path>', 'read the text from a file, or - for stdin')
    .action(
      act(async (rt, [issue, words], o) => {
        const api = await rt.api();
        const body = await bodyFrom(rt, words as string[], o);
        rt.out.item(
          'comment',
          await rt.call(
            api.POST('/issues/{issue}/comments', {
              params: { path: { issue: String(issue) } },
              body: { body },
            }),
          ),
        );
      }),
    );
  cmd
    .command('edit')
    .description('Edit your comment')
    .argument('<id>', 'comment id')
    .argument('[text...]', 'new text')
    .option('-b, --body <markdown>', 'new text')
    .option('--body-file <path>', 'read the text from a file, or - for stdin')
    .action(
      act(async (rt, [id, words], o) => {
        const api = await rt.api();
        const body = await bodyFrom(rt, words as string[], o);
        rt.out.item(
          'comment',
          await rt.call(
            api.PATCH('/comments/{id}', { params: { path: { id: String(id) } }, body: { body } }),
          ),
        );
      }),
    );
  cmd
    .command('delete')
    .alias('rm')
    .description('Delete your comment')
    .argument('<id>', 'comment id')
    .action(
      act(async (rt, [id]) => {
        const api = await rt.api();
        rt.out.item(
          'comment',
          await rt.call(api.DELETE('/comments/{id}', { params: { path: { id: String(id) } } })),
          () => 'Comment deleted\n',
        );
      }),
    );
  return cmd;
}

export function registerLink(parent: Command, tree: Tree): Command {
  const act: Tree['act'] = (fn) => tree.act(fn);
  const cmd = parent.command('link').description('Relate issues (blocks, relates, duplicates)');
  cmd
    .command('list')
    .alias('ls')
    .description("List an issue's links from its perspective")
    .argument('<issue>', 'issue key or id')
    .action(
      act(async (rt, [issue]) => {
        const api = await rt.api();
        rt.out.list(
          'link',
          (
            await rt.call(
              api.GET('/issues/{issue}/links', { params: { path: { issue: String(issue) } } }),
            )
          ).data,
        );
      }),
    );
  cmd
    .command('add')
    .description(
      'Link two issues, e.g. `link add ENG-1 blocks ENG-2` or `link add ENG-2 blocked-by ENG-1`',
    )
    .argument('<issue>', 'issue key or id')
    .argument('<relation>', `link type key or alias (${Object.keys(LINK_ALIASES).join(', ')})`)
    .argument('<target>', 'the other issue')
    .action(
      act(async (rt, [issue, relation, target]) => {
        const api = await rt.api();
        const [type, direction] = LINK_ALIASES[String(relation).toLowerCase()] ?? [
          String(relation),
          'outward',
        ];
        rt.out.item(
          'link',
          await rt.call(
            api.POST('/issues/{issue}/links', {
              params: { path: { issue: String(issue) } },
              body: { type, target: String(target), direction },
            }),
          ),
        );
      }),
    );
  cmd
    .command('remove')
    .alias('rm')
    .description('Remove a link by id (see `link list`)')
    .argument('<id>', 'link id')
    .action(
      act(async (rt, [id]) => {
        const api = await rt.api();
        const res = await api.DELETE('/links/{id}', { params: { path: { id: String(id) } } });
        await rt.call(res as never);
        rt.out.item('raw', { id: String(id), removed: true }, () => 'Link removed\n');
      }),
    );
  cmd
    .command('types')
    .description('List link types')
    .action(
      act(async (rt) => {
        const api = await rt.api();
        rt.out.list('linkType', (await rt.call(api.GET('/link-types'))).data);
      }),
    );
  return cmd;
}

/**
 * The event log is global; filter by project only when --project/POIETIC_ISSUES_PROJECT is given explicitly
 * (not when it comes from `.poietic-issues.json`).
 */
function explicitProject(rt: CommandRuntime, globals: Opts): string | undefined {
  const flag = globals.project;
  if (typeof flag === 'string' && flag !== '') return flag;
  const env = rt.io.env.POIETIC_ISSUES_PROJECT;
  return env !== undefined && env !== '' ? env : undefined;
}

export function registerEvent(parent: Command, tree: Tree): Command {
  const cmd = parent
    .command('event')
    .description('Read the event log (what changed, in commit order)');
  const filters = (c: Command) =>
    c
      .option('--issue <issue>', 'only this issue (use the global --project to filter by project)')
      .option('--types <types>', 'comma-separated event types, e.g. issue.created,issue.updated');
  filters(
    cmd
      .command('list')
      .alias('ls')
      .description('List events after a sequence number (use the last seq you saw as --after)')
      .option('--after <seq>', 'exclusive cursor', (v) => Number(v))
      .option('--limit <n>', 'max events (1-1000)', (v) => Number(v)),
  ).action(
    actWithGlobals(tree, async (rt, _a, o, globals) => {
      const api = await rt.api();
      const data = await rt.call(
        api.GET('/events', {
          params: {
            query: {
              ...(o.after !== undefined && { after: Number(o.after) }),
              ...(o.limit !== undefined && { limit: Number(o.limit) }),
              ...(explicitProject(rt, globals) && { project: explicitProject(rt, globals)! }),
              ...(o.issue !== undefined && { issue: String(o.issue) }),
              ...(o.types !== undefined && { types: String(o.types) }),
            },
          },
        }),
      );
      rt.out.list('event', data);
    }),
  );
  filters(
    cmd
      .command('tail')
      .description('Follow new events as NDJSON (one event per line) until interrupted')
      .option('--after <seq>', 'start after this seq (default: now)', (v) => Number(v))
      .option('--interval <ms>', 'poll interval', (v) => Number(v), 1000)
      .option('--max <n>', 'exit after this many events', (v) => Number(v)),
  ).action(
    actWithGlobals(tree, async (rt, _a, o, globals) => {
      const api = await rt.api();
      const query = {
        ...(explicitProject(rt, globals) && { project: explicitProject(rt, globals)! }),
        ...(o.issue !== undefined && { issue: String(o.issue) }),
        ...(o.types !== undefined && { types: String(o.types) }),
      };
      let after = o.after as number | undefined;
      if (after === undefined) {
        // Start from the current end of the log.
        after = 0;
        for (;;) {
          const page: { data: Array<{ seq: number }>; nextCursor: string | null } = await rt.call(
            api.GET('/events', { params: { query: { after, limit: 1000 } } }),
          );
          after = page.data.at(-1)?.seq ?? after;
          if (!page.nextCursor) break;
        }
      }
      let emitted = 0;
      const max = o.max as number | undefined;
      for (;;) {
        const page: { data: Array<{ seq: number }>; nextCursor: string | null } = await rt.call(
          api.GET('/events', { params: { query: { ...query, after, limit: 1000 } } }),
        );
        for (const event of page.data) {
          rt.out.raw(`${JSON.stringify(event)}\n`);
          after = event.seq;
          if (max !== undefined && ++emitted >= max) return;
        }
        if (!page.nextCursor) await new Promise((r) => setTimeout(r, Number(o.interval)));
      }
    }),
  );
  return cmd;
}

export function registerAttachment(parent: Command, tree: Tree): Command {
  const act: Tree['act'] = (fn) => tree.act(fn);
  const cmd = parent.command('attachment').alias('attach').description('Attach files to issues');
  cmd
    .command('add')
    .description(
      'Upload one or more files to an issue (the media type is detected from the content)',
    )
    .argument('<issue>', 'issue key or id')
    .argument('<files...>', 'paths to upload, or - for stdin (with --name)')
    .option('--name <filename>', 'filename to store (default: the file’s basename)')
    .option('--comment <id>', 'associate the upload with a comment on the issue')
    .action(
      act(async (rt, [issue, files], o) => {
        const { readFile } = await import('node:fs/promises');
        const { basename, resolve } = await import('node:path');
        const paths = files as string[];
        if (o.name && paths.length > 1) throw usage('--name applies to a single file');
        const api = await rt.api();
        const uploaded = [];
        for (const path of paths) {
          let data: Uint8Array;
          if (path === '-') {
            if (!o.name) throw usage('Uploading from stdin needs --name <filename>');
            data = new TextEncoder().encode(await rt.io.readStdin());
          } else {
            try {
              data = new Uint8Array(await readFile(resolve(rt.io.cwd, path)));
            } catch (error) {
              throw usage(`Cannot read ${path}: ${(error as Error).message}`);
            }
          }
          const form = new FormData();
          form.set(
            'file',
            new File([data as Uint8Array<ArrayBuffer>], String(o.name ?? basename(path))),
          );
          if (o.comment) form.set('commentId', String(o.comment));
          uploaded.push(
            await rt.call(
              api.POST('/issues/{issue}/attachments', {
                params: { path: { issue: String(issue) } },
                body: {} as never,
                bodySerializer: () => form,
              }),
            ),
          );
        }
        if (uploaded.length === 1) rt.out.item('attachment', uploaded[0]);
        else rt.out.list('attachment', uploaded);
      }),
    );
  cmd
    .command('list')
    .alias('ls')
    .description('List the files attached to an issue')
    .argument('<issue>', 'issue key or id')
    .action(
      act(async (rt, [issue]) => {
        const api = await rt.api();
        rt.out.list(
          'attachment',
          (
            await rt.call(
              api.GET('/issues/{issue}/attachments', {
                params: { path: { issue: String(issue) } },
              }),
            )
          ).data,
        );
      }),
    );
  cmd
    .command('view')
    .description('Show an attachment’s metadata')
    .argument('<id>', 'attachment id')
    .action(
      act(async (rt, [id]) => {
        const api = await rt.api();
        rt.out.item(
          'attachment',
          await rt.call(api.GET('/attachments/{id}', { params: { path: { id: String(id) } } })),
        );
      }),
    );
  cmd
    .command('download')
    .alias('get')
    .description(
      'Download an attachment’s content to a file (default: its filename) or - for stdout',
    )
    .argument('<id>', 'attachment id')
    .option('-o, --output <path>', 'where to write it; - writes the bytes to stdout')
    .action(
      act(async (rt, [id], o) => {
        const api = await rt.api();
        const meta = await rt.call(
          api.GET('/attachments/{id}', { params: { path: { id: String(id) } } }),
        );
        const bytes = new Uint8Array(
          (await rt.call(
            api.GET('/attachments/{id}/content', {
              params: { path: { id: String(id) } },
              parseAs: 'arrayBuffer',
            }),
          )) as ArrayBuffer,
        );
        if (o.output === '-') {
          rt.out.rawBytes(bytes);
          return;
        }
        const { writeFile } = await import('node:fs/promises');
        const { basename, resolve } = await import('node:path');
        const target = resolve(rt.io.cwd, String(o.output ?? basename(meta.filename)));
        await writeFile(target, bytes);
        rt.out.item(
          'raw',
          { path: target, size: bytes.byteLength, sha256: meta.sha256 },
          () => `Saved ${target} (${bytes.byteLength} bytes)\n`,
        );
      }),
    );
  cmd
    .command('remove')
    .alias('rm')
    .description('Delete an attachment (uploader or admin)')
    .argument('<id>', 'attachment id')
    .action(
      act(async (rt, [id]) => {
        const api = await rt.api();
        rt.out.item(
          'attachment',
          await rt.call(api.DELETE('/attachments/{id}', { params: { path: { id: String(id) } } })),
          (r) => `Deleted ${String(r.filename)}\n`,
        );
      }),
    );
  return cmd;
}
