import type { ApiClient, Schemas } from '@poietic-tech/issues-client';
import type { Command } from 'commander';
import { CliError, usage } from '../errors.ts';
import { collect, readJsonArg } from '../tree/args.ts';
import type { CommandRuntime, Tree } from '../tree/runtime.ts';

type Field = Schemas['CustomField'];

async function fieldByKey(rt: CommandRuntime, api: ApiClient, ref: string): Promise<Field> {
  const fields = (
    await rt.call(
      api.GET('/projects/{project}/fields', {
        params: { path: { project: rt.project() }, query: { includeArchived: 'true' } },
      }),
    )
  ).data;
  const field = fields.find((f) => f.key === ref || f.id === ref);
  if (!field)
    throw new CliError(
      'NOT_FOUND',
      `Custom field "${ref}" not found in ${rt.project()} (${fields.map((f) => f.key).join(', ') || 'none'})`,
    );
  return field;
}

function describe(field: Field): string {
  const options = field.options.length
    ? `\n  options: ${field.options.map((o) => `${o.value}${o.archivedAt ? ' (archived)' : ''}`).join(', ')}`
    : '';
  return `${field.key}  ${field.name}  [${field.type}]${field.archivedAt ? '  (archived)' : ''}${options}\n`;
}

export function registerField(parent: Command, tree: Tree): Command {
  const act: Tree['act'] = (fn) => tree.act(fn);
  const cmd = parent
    .command('field')
    .description(
      'Custom fields: define them per project, set them with `issue edit --set key=value`',
    );
  cmd
    .command('list')
    .alias('ls')
    .description('List custom fields')
    .option('--include-archived', 'include archived fields')
    .action(
      act(async (rt, _a, o) => {
        const api = await rt.api();
        const fields = (
          await rt.call(
            api.GET('/projects/{project}/fields', {
              params: {
                path: { project: rt.project() },
                query: o.includeArchived ? { includeArchived: 'true' } : {},
              },
            }),
          )
        ).data;
        if (rt.out.format === 'table') {
          if (!fields.length) return rt.io.stderr('No custom fields.\n');
          return rt.out.raw(fields.map(describe).join(''));
        }
        rt.out.list('raw', fields);
      }),
    );
  cmd
    .command('create')
    .description(
      'Create a custom field, e.g. `field create severity --type select --option low,high`',
    )
    .argument('<key>', 'immutable key (lowercase, digits, _)')
    .requiredOption('--type <type>', 'text|number|date|boolean|select|multi_select|user|url')
    .option('-n, --name <name>', 'display name (default: the key)')
    .option('--description <text>', 'description')
    .option(
      '--option <values>',
      'options for select types (repeatable or comma-separated)',
      collect,
    )
    .option('--config <json|@file|->', 'display hints JSON, e.g. {"unit":"pts"}')
    .action(
      act(async (rt, [key], o) => {
        const api = await rt.api();
        const body = {
          key: String(key),
          name: String(o.name ?? key),
          type: o.type as Field['type'],
          ...(o.description !== undefined && { description: String(o.description) }),
          ...(o.option !== undefined && {
            options: (o.option as string[]).map((value) => ({ value })),
          }),
          ...(o.config !== undefined && {
            config: await readJsonArg(rt.io, String(o.config), '--config'),
          }),
        };
        const field = await rt.call(
          api.POST('/projects/{project}/fields', {
            params: { path: { project: rt.project() } },
            body,
          }),
        );
        rt.out.item('raw', field, () => describe(field));
      }),
    );
  cmd
    .command('edit')
    .description('Rename, describe, reorder or (un)archive a field')
    .argument('<field>', 'field key or id')
    .option('-n, --name <name>', 'display name')
    .option('--description <text>', 'description')
    .option('--position <n>', 'display position', (v) => Number(v))
    .option('--archive', 'hide the field (values are kept)')
    .option('--unarchive', 'show the field again')
    .action(
      act(async (rt, [ref], o) => {
        const api = await rt.api();
        const field = await fieldByKey(rt, api, String(ref));
        const body: Schemas['UpdateCustomFieldInput'] = {};
        if (o.name !== undefined) body.name = String(o.name);
        if (o.description !== undefined) body.description = String(o.description);
        if (o.position !== undefined) body.position = Number(o.position);
        if (o.archive) body.archived = true;
        if (o.unarchive) body.archived = false;
        if (!Object.keys(body).length) throw usage('Nothing to change');
        const updated = await rt.call(
          api.PATCH('/fields/{id}', { params: { path: { id: field.id } }, body }),
        );
        rt.out.item('raw', updated, () => describe(updated));
      }),
    );
  cmd
    .command('delete')
    .description(
      'Delete a field and all its values permanently (admin; prefer `field edit --archive`)',
    )
    .argument('<field>', 'field key or id')
    .action(
      act(async (rt, [ref]) => {
        const api = await rt.api();
        const field = await fieldByKey(rt, api, String(ref));
        await rt.call(api.DELETE('/fields/{id}', { params: { path: { id: field.id } } }));
        rt.out.item('raw', { key: field.key, deleted: true }, () => `Deleted field ${field.key}\n`);
      }),
    );
  cmd
    .command('option-add')
    .description('Add options to a select / multi_select field')
    .argument('<field>', 'field key or id')
    .argument('<values...>', 'option values')
    .option('--color <hex>', 'color for the new options')
    .action(
      act(async (rt, [ref, values], o) => {
        const api = await rt.api();
        let field = await fieldByKey(rt, api, String(ref));
        for (const value of values as string[])
          field = await rt.call(
            api.POST('/fields/{id}/options', {
              params: { path: { id: field.id } },
              body: { value, ...(o.color !== undefined && { color: String(o.color) }) },
            }),
          );
        rt.out.item('raw', field, () => describe(field));
      }),
    );
  cmd
    .command('option-edit')
    .description('Relabel, recolor or (un)archive an option')
    .argument('<field>', 'field key or id')
    .argument('<value>', 'option value')
    .option('--label <label>', 'display label')
    .option('--color <hex>', 'color')
    .option('--archive', 'archive (cannot be chosen anymore; existing values stay)')
    .option('--unarchive', 'unarchive')
    .action(
      act(async (rt, [ref, value], o) => {
        const api = await rt.api();
        const field = await fieldByKey(rt, api, String(ref));
        const option = field.options.find((x) => x.value === value);
        if (!option)
          throw new CliError('NOT_FOUND', `Option "${String(value)}" not found on ${field.key}`);
        const body: Schemas['UpdateFieldOptionInput'] = {};
        if (o.label !== undefined) body.label = String(o.label);
        if (o.color !== undefined) body.color = String(o.color);
        if (o.archive) body.archived = true;
        if (o.unarchive) body.archived = false;
        const updated = await rt.call(
          api.PATCH('/field-options/{id}', { params: { path: { id: option.id } }, body }),
        );
        rt.out.item('raw', updated, () => describe(updated));
      }),
    );
  return cmd;
}
