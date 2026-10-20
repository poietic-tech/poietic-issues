import type { Schemas } from '@poietic-tech/issues-client';
import type { Command } from 'commander';
import { usage } from '../errors.ts';
import { formatIssue } from '../output.ts';
import {
  collect,
  collectRaw,
  keyValues,
  nullable,
  parseIntStrict,
  parsePriority,
  readJsonArg,
  readTextArg,
} from '../tree/args.ts';
import type { CommandRuntime, Tree } from '../tree/runtime.ts';

type Opts = Record<string, unknown>;

/** Shared flags for create/edit. */
function issueFieldOptions(cmd: Command, mode: 'create' | 'edit'): Command {
  cmd
    .option('-t, --title <title>', 'title')
    .option('-d, --description <markdown>', 'description (markdown)')
    .option('--body-file <path>', 'read the description from a file, or - for stdin')
    .option('-s, --status <status>', 'status name or id')
    .option('-p, --priority <priority>', 'none|urgent|high|medium|low or 0-4', parsePriority)
    .option('-a, --assignee <user>', 'handle, @handle, me, or none to unassign')
    .option('--parent <issue>', 'parent issue key, or none')
    .option('-e, --estimate <points>', 'estimate, or none')
    .option('--due <date>', 'due date YYYY-MM-DD, or none')
    .option(
      '--repo <owner/name>',
      "one of the project's linked GitHub repos (owner/name, URL or id); none, null or '' clears it",
    )
    .option(
      '--set <field=value>',
      'custom field (repeatable), e.g. --set severity=high --set points=3',
      collectRaw,
    )
    .option('--meta <key=value>', 'metadata entry (repeatable; merged)', collectRaw)
    .option(
      '--input <json|@file|->',
      'full JSON payload (CreateIssueInput / UpdateIssueInput); flags override it',
    );
  if (mode === 'create')
    cmd.option('-l, --label <labels>', 'labels (repeatable or comma-separated)', collect);
  else
    cmd
      .option('-l, --label <labels>', 'replace all labels (repeatable or comma-separated)', collect)
      .option('--add-label <labels>', 'add labels', collect)
      .option('--remove-label <labels>', 'remove labels', collect)
      .option(
        '--if-version <n>',
        'fail with a version_mismatch conflict unless the issue is at this version',
        parseIntStrict('--if-version'),
      );
  return cmd;
}

async function buildIssueInput(
  rt: CommandRuntime,
  o: Opts,
  existingMetadata?: Record<string, unknown>,
) {
  const input: Record<string, unknown> = o.input
    ? await readJsonArg(rt.io, String(o.input), '--input')
    : {};
  const set = (key: string, value: unknown) => {
    if (value !== undefined) input[key] = value;
  };
  set('title', o.title);
  set('description', o.description);
  if (o.bodyFile) input.description = await readTextArg(rt.io, String(o.bodyFile));
  set('status', o.status);
  set('priority', o.priority);
  if (o.assignee !== undefined) input.assignee = nullable(String(o.assignee));
  if (o.parent !== undefined) input.parent = nullable(String(o.parent));
  if (o.estimate !== undefined) {
    const v = nullable(String(o.estimate));
    if (v !== null && Number.isNaN(Number(v))) throw usage('--estimate must be a number or none');
    input.estimate = v === null ? null : Number(v);
  }
  if (o.due !== undefined) input.dueDate = nullable(String(o.due));
  if (o.repo !== undefined) input.repo = o.repo === '' ? null : nullable(String(o.repo));
  set('labels', o.label);
  set('addLabels', o.addLabel);
  set('removeLabels', o.removeLabel);
  const customFields = keyValues(o.set as string[] | undefined, 'cf.');
  if (customFields) input.customFields = { ...(input.customFields as object), ...customFields };
  const meta = keyValues(o.meta as string[] | undefined);
  if (meta) input.metadata = { ...existingMetadata, ...(input.metadata as object), ...meta };
  if (o.ifVersion !== undefined) input.expectedVersion = o.ifVersion;
  return input;
}

export function registerIssue(parent: Command, tree: Tree): Command {
  const act: Tree['act'] = (fn) => tree.act(fn);
  const issue = parent.command('issue').description('Create, find, edit and organize issues');

  issue
    .command('list')
    .alias('ls')
    .description('List issues in a project (filters are ANDed; comma lists mean "any of")')
    .option('-s, --status <statuses>', 'status names/ids', collect)
    .option(
      '--category <categories>',
      'status categories: backlog,unstarted,started,completed,canceled',
      collect,
    )
    .option('-a, --assignee <users>', 'handles/ids, me, none', collect)
    .option('--creator <users>', 'creator handles/ids', collect)
    .option('-l, --label <labels>', 'has any of these labels', collect)
    .option('-p, --priority <priorities>', 'priorities (names or 0-4)', collect)
    .option('--parent <issue>', 'children of this issue, or none for top-level issues')
    .option('--search <text>', 'text in key, title or description')
    .option(
      '-w, --where <field.op=value>',
      'any filter, e.g. priority.gte=2, dueDate.isNull=true, cf.severity=high',
      collectRaw,
    )
    .option('--filter-json <json|@file|->', 'an IssueFilter JSON object')
    .option('--sort <fields>', 'sort fields, - for descending (e.g. -priority,updatedAt)')
    .option('--limit <n>', 'page size (1-200)', parseIntStrict('--limit'))
    .option('--cursor <cursor>', 'continue from a previous page')
    .option('--all', 'fetch every page')
    .option(
      '--include-deleted',
      'include issues in the trash (only in projects you can write in; ignored elsewhere)',
    )
    .option('--all-projects', 'search across all projects')
    .action(
      act(async (rt, _args, o) => {
        const api = await rt.api();
        const query: Record<string, string> = {};
        const add = (key: string, values: unknown) => {
          if (Array.isArray(values) && values.length) query[key] = values.join(',');
          else if (typeof values === 'string') query[key] = values;
        };
        add('status', o.status);
        add('statusCategory', o.category);
        add('assignee', o.assignee);
        add('creator', o.creator);
        add('label', o.label);
        if (o.priority)
          query.priority = (o.priority as string[]).map((p) => String(parsePriority(p))).join(',');
        add('parent', o.parent);
        add('q', o.search);
        for (const w of (o.where as string[] | undefined) ?? []) {
          const idx = w.indexOf('=');
          if (idx <= 0) throw usage(`--where expects field.op=value, got "${w}"`);
          query[w.slice(0, idx)] = w.slice(idx + 1);
        }
        if (o.filterJson)
          query.filter = JSON.stringify(
            await readJsonArg(rt.io, String(o.filterJson), '--filter-json'),
          );
        add('sort', o.sort);
        if (o.limit) query.limit = String(o.limit);
        if (o.includeDeleted) query.includeDeleted = 'true';

        const fetchPage = async (cursor: string | undefined) => {
          if (o.allProjects) {
            const filter = query.filter ? JSON.parse(query.filter) : undefined;
            if (
              Object.keys(query).some(
                (k) => !['filter', 'sort', 'limit', 'includeDeleted'].includes(k),
              )
            )
              throw usage(
                '--all-projects supports only --filter-json, --sort, --limit and --include-deleted',
              );
            return rt.call(
              api.POST('/issues/search', {
                body: {
                  ...(filter && { filter }),
                  ...(query.sort && { sort: parseSortArg(query.sort) }),
                  ...(o.limit !== undefined && { limit: Number(o.limit) }),
                  ...(cursor && { cursor }),
                  includeDeleted: Boolean(o.includeDeleted),
                },
              }),
            );
          }
          return rt.call(
            api.GET('/projects/{project}/issues', {
              params: {
                path: { project: rt.project() },
                query: { ...query, ...(cursor && { cursor }) } as Record<string, string>,
              },
            }),
          );
        };
        let page = await fetchPage(o.cursor as string | undefined);
        if (o.all) {
          const data = [...page.data];
          while (page.nextCursor) {
            page = await fetchPage(page.nextCursor);
            data.push(...page.data);
          }
          page = { data, nextCursor: null };
        }
        rt.out.list('issue', page);
      }),
    );

  issue
    .command('view')
    .alias('show')
    .description('Show one issue')
    .argument('<issue>', 'issue key (ENG-42) or id')
    .action(
      act(async (rt, [ref]) => {
        const api = await rt.api();
        const data = await rt.call(
          api.GET('/issues/{issue}', { params: { path: { issue: String(ref) } } }),
        );
        rt.out.item('issue', data, formatIssue);
      }),
    );

  issueFieldOptions(
    issue
      .command('create')
      .alias('new')
      .description('Create an issue (prints the new issue; -q prints only its key)'),
    'create',
  ).action(
    act(async (rt, _args, o) => {
      const api = await rt.api();
      const body = await buildIssueInput(rt, o);
      if (!body.title) throw usage('--title is required (or provide it in --input)');
      const data = await rt.call(
        api.POST('/projects/{project}/issues', {
          params: { path: { project: rt.project() } },
          body: body as Schemas['CreateIssueInput'],
        }),
      );
      rt.out.item('issue', data, formatIssue);
    }),
  );

  issueFieldOptions(
    issue
      .command('edit')
      .alias('update')
      .description('Edit one or more issues (several issues are updated atomically)')
      .argument('<issues...>', 'issue keys or ids'),
    'edit',
  ).action(
    act(async (rt, [refs], o) => {
      const api = await rt.api();
      const list = refs as string[];
      let existingMetadata: Record<string, unknown> | undefined;
      if (o.meta && list.length === 1) {
        const current = await rt.call(
          api.GET('/issues/{issue}', { params: { path: { issue: list[0]! } } }),
        );
        existingMetadata = current.metadata;
      }
      const body = await buildIssueInput(rt, o, existingMetadata);
      if (Object.keys(body).length === 0)
        throw usage('Nothing to change: pass at least one field flag');
      if (list.length === 1) {
        const data = await rt.call(
          api.PATCH('/issues/{issue}', {
            params: { path: { issue: list[0]! } },
            body: body as Schemas['UpdateIssueInput'],
          }),
        );
        return rt.out.item('issue', data, formatIssue);
      }
      if (body.expectedVersion !== undefined) throw usage('--if-version works with a single issue');
      if (body.metadata !== undefined) throw usage('--meta works with a single issue');
      const data = await rt.call(api.POST('/issues/bulk', { body: { issues: list, patch: body } }));
      rt.out.list('issue', data.data);
    }),
  );

  issue
    .command('move')
    .description('Move an issue on the board: change status and/or position within the column')
    .argument('<issue>', 'issue key or id')
    .option('-s, --status <status>', 'target status (name or id)')
    .option('--after <issue>', 'place directly after this issue')
    .option('--before <issue>', 'place directly before this issue')
    .option('--top', 'place at the top of the column (default)')
    .option('--bottom', 'place at the bottom of the column')
    .option(
      '--if-version <n>',
      'fail unless the issue is at this version',
      parseIntStrict('--if-version'),
    )
    .action(
      act(async (rt, [ref], o) => {
        const api = await rt.api();
        if ([o.after, o.before, o.top, o.bottom].filter(Boolean).length > 1)
          throw usage('Use only one of --after, --before, --top, --bottom');
        const data = await rt.call(
          api.POST('/issues/{issue}/move', {
            params: { path: { issue: String(ref) } },
            body: {
              ...(o.status !== undefined && { status: String(o.status) }),
              ...(o.after !== undefined && { afterId: String(o.after) }),
              ...(o.before !== undefined && { beforeId: String(o.before) }),
              ...(o.bottom
                ? { position: 'bottom' as const }
                : o.top
                  ? { position: 'top' as const }
                  : {}),
              ...(o.ifVersion !== undefined && { expectedVersion: Number(o.ifVersion) }),
            },
          }),
        );
        rt.out.item('issue', data, formatIssue);
      }),
    );

  issue
    .command('delete')
    .alias('rm')
    .description('Move an issue to the trash (restorable); --permanent deletes for good (admin)')
    .argument('<issue>', 'issue key or id')
    .option('--permanent', 'delete permanently, with comments and links')
    .option(
      '--if-version <n>',
      'fail unless the issue is at this version',
      parseIntStrict('--if-version'),
    )
    .action(
      act(async (rt, [ref], o) => {
        const api = await rt.api();
        const data = await rt.call(
          api.DELETE('/issues/{issue}', {
            params: {
              path: { issue: String(ref) },
              query: o.permanent ? { permanent: 'true' } : {},
              header: o.ifVersion !== undefined ? { 'if-match': `"v${String(o.ifVersion)}"` } : {},
            },
          }),
        );
        rt.out.item(
          'issue',
          data,
          (i) =>
            `${String(i.key)} ${o.permanent ? 'permanently deleted' : `moved to the trash (${tree.commandName} issue restore to undo)`}\n`,
        );
      }),
    );

  issue
    .command('restore')
    .description('Restore an issue from the trash')
    .argument('<issue>', 'issue key or id')
    .action(
      act(async (rt, [ref]) => {
        const api = await rt.api();
        rt.out.item(
          'issue',
          await rt.call(
            api.POST('/issues/{issue}/restore', { params: { path: { issue: String(ref) } } }),
          ),
          formatIssue,
        );
      }),
    );

  issue
    .command('children')
    .description('List sub-issues')
    .argument('<issue>', 'issue key or id')
    .action(
      act(async (rt, [ref]) => {
        const api = await rt.api();
        rt.out.list(
          'issue',
          (
            await rt.call(
              api.GET('/issues/{issue}/children', { params: { path: { issue: String(ref) } } }),
            )
          ).data,
        );
      }),
    );

  issue
    .command('activity')
    .alias('history')
    .description('Show the history of an issue (changes, comments, links)')
    .argument('<issue>', 'issue key or id')
    .option('--after <seq>', 'only events after this sequence number', parseIntStrict('--after'))
    .option('--limit <n>', 'page size', parseIntStrict('--limit'))
    .action(
      act(async (rt, [ref], o) => {
        const api = await rt.api();
        const data = await rt.call(
          api.GET('/issues/{issue}/activity', {
            params: {
              path: { issue: String(ref) },
              query: {
                ...(o.after !== undefined && { after: Number(o.after) }),
                ...(o.limit !== undefined && { limit: Number(o.limit) }),
              },
            },
          }),
        );
        rt.out.list('event', data);
      }),
    );

  return issue;
}

export function parseSortArg(value: string): Array<{ field: string; dir: 'asc' | 'desc' }> {
  return value
    .split(',')
    .map((p) => ({ field: p.replace(/^[-+]/, ''), dir: p.startsWith('-') ? 'desc' : 'asc' }));
}
