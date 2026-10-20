import { fromJson } from '@poietic-tech/issues-db';
import {
  CreateIssueInputSchema,
  inputSchema,
  UpdateIssueInputSchema,
} from '@poietic-tech/issues-schema';
import { atLeast, projectLevel } from '../access.ts';
import { isAnonymous, type ServiceContext } from '../context.ts';
import { getProjectRow } from '../refs.ts';
import { reposOf } from './repos.ts';

type JsonSchema = Record<string, unknown> & {
  properties?: Record<string, Record<string, unknown>>;
};

/** Moved to the schema package so the CLI's command tree can use it without core. */
export { inputSchema };

/**
 * JSON Schema (draft 2020-12) for creating and updating issues in a project, with the project's live values
 * filled in as enums: status names, label names, linked repos, assignable user handles and custom field
 * definitions. Designed for agents: one call tells them every valid value.
 *
 * Assignable users are those who can write the project (its editors and managers, plus admins); `me` is offered
 * only when the caller can write too. Anonymous callers get no user handles at all (ADR 0021: signed-out visitors
 * see handles only where they are embedded in resources they can read).
 */
export async function issueInputJsonSchema(
  ctx: ServiceContext,
  projectRef: string,
): Promise<Record<string, unknown>> {
  const db = ctx.db.kysely;
  const project = await getProjectRow(ctx, db, projectRef, 'read');
  const anonymous = isAnonymous(ctx);
  const callerCanWrite = !anonymous && atLeast(await projectLevel(ctx, db, project), 'write');
  const [statuses, labels, users, fields, options, repos] = await Promise.all([
    db
      .selectFrom('statuses')
      .select(['name', 'category'])
      .where('project_id', '=', project.id)
      .orderBy('position')
      .execute(),
    db
      .selectFrom('labels')
      .select('name')
      .where('project_id', '=', project.id)
      .where('archived_at', 'is', null)
      .orderBy('name')
      .execute(),
    anonymous
      ? Promise.resolve([])
      : db
          .selectFrom('users')
          .select(['handle', 'kind'])
          .where('kind', '!=', 'system')
          .where('deactivated_at', 'is', null)
          .where((eb) =>
            eb.or([
              eb('role', '=', 'admin'),
              eb(
                'id',
                'in',
                eb
                  .selectFrom('project_members')
                  .select('user_id')
                  .where('project_id', '=', project.id)
                  .where('role', 'in', ['editor', 'manager']),
              ),
            ]),
          )
          .orderBy('handle')
          .execute(),
    db
      .selectFrom('custom_fields')
      .selectAll()
      .where('project_id', '=', project.id)
      .where('archived_at', 'is', null)
      .orderBy('position')
      .execute(),
    db
      .selectFrom('custom_field_options as o')
      .innerJoin('custom_fields as f', 'f.id', 'o.field_id')
      .select(['o.field_id', 'o.value', 'o.label'])
      .where('f.project_id', '=', project.id)
      .where('o.archived_at', 'is', null)
      .orderBy('o.position')
      .execute(),
    reposOf(db, [project.id]).then((m) => m.get(project.id) ?? []),
  ]);
  const handles = users.map((u) => u.handle);

  const customFieldProperties: Record<string, Record<string, unknown>> = {};
  for (const f of fields) {
    const values = options.filter((o) => o.field_id === f.id).map((o) => o.value);
    const description = [f.name, f.description].filter(Boolean).join(' — ');
    const typeSchema: Record<string, unknown> = (() => {
      switch (f.type) {
        case 'number':
          return { type: ['number', 'null'] };
        case 'boolean':
          return { type: ['boolean', 'null'] };
        case 'date':
          return { type: ['string', 'null'], format: 'date' };
        case 'url':
          return { type: ['string', 'null'], format: 'uri' };
        case 'select':
          return { enum: [...values, null] };
        case 'multi_select':
          return { type: 'array', items: { enum: values }, uniqueItems: true };
        case 'user':
          return {
            type: ['string', 'null'],
            description: 'User handle or id',
            ...(!anonymous && { examples: handles }),
          };
        default:
          return { type: ['string', 'null'] };
      }
    })();
    customFieldProperties[f.key] = {
      ...typeSchema,
      title: f.name,
      ...(description && { description }),
      'x-field-type': f.type,
      'x-config': fromJson(f.config, {}),
    };
  }

  const enrich = (schema: JsonSchema): JsonSchema => {
    const props = schema.properties ?? {};
    if (props.status) props.status = { ...props.status, enum: statuses.map((s) => s.name) };
    const labelEnum = { type: 'string', enum: labels.map((l) => l.name) };
    for (const key of ['labels', 'addLabels', 'removeLabels']) {
      if (props[key]) props[key] = { ...props[key], items: labelEnum };
    }
    if (props.assignee && !anonymous)
      props.assignee = {
        ...props.assignee,
        anyOf: [{ enum: [...(callerCanWrite ? ['me'] : []), ...handles] }, { type: 'null' }],
      };
    if (props.repo)
      props.repo = {
        ...props.repo,
        anyOf: [{ enum: repos.map((r) => r.fullName) }, { type: 'null' }],
      };
    if (props.customFields)
      props.customFields = {
        type: 'object',
        additionalProperties: false,
        properties: customFieldProperties,
      };
    return schema;
  };

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: `Issue input for project ${project.key}`,
    'x-project': { id: project.id, key: project.key, name: project.name },
    'x-statuses': statuses,
    create: enrich(inputSchema(CreateIssueInputSchema)),
    update: enrich(inputSchema(UpdateIssueInputSchema)),
  };
}
