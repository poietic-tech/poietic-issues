import type { Issue } from './entities.ts';

/**
 * The field registry — the extensibility spine for anything that shows, filters, sorts or groups issues.
 *
 * List columns, board card properties, filter builders, sort/group menus and the CLI's `--fields` all read
 * descriptors from here, so adding a core field (or a custom field, keyed `cf:<key>`) makes it available
 * everywhere at once. The web app only adds renderers per `type`.
 */

export const FILTER_OPS = [
  'eq',
  'neq',
  'in',
  'nin',
  'gt',
  'gte',
  'lt',
  'lte',
  'isNull',
  'contains',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export type FieldType =
  | 'id'
  | 'text'
  | 'number'
  | 'date'
  | 'datetime'
  | 'boolean'
  | 'url'
  | 'status'
  | 'statusCategory'
  | 'issueType'
  | 'priority'
  | 'user'
  | 'labels'
  | 'issue'
  | 'repo'
  | 'select'
  | 'multiSelect';

export interface FieldDescriptor {
  /** Stable key used in view configs, filters, sorts and `--fields`. Custom fields use `cf:<key>`. */
  key: string;
  label: string;
  type: FieldType;
  /** Can be used in `sort`. */
  sortable: boolean;
  /** Can be used as `groupBy` for list groups / board columns. */
  groupable: boolean;
  /** Operators accepted in filters; empty = not filterable. */
  filterOps: readonly FilterOp[];
  /** Can be shown as a list column / card property. */
  displayable: boolean;
  /** Reads the field's comparable value from an issue snapshot. */
  get(issue: Issue): unknown;
}

const EQUALITY = ['eq', 'neq', 'in', 'nin'] as const;
const NULLABLE_EQUALITY = [...EQUALITY, 'isNull'] as const;
const RANGE = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'isNull'] as const;
const SET = ['eq', 'neq', 'in', 'nin', 'isNull'] as const;

function field(d: FieldDescriptor): FieldDescriptor {
  return d;
}

/** Built-in issue fields. Order here is the default order in pickers. */
export const CORE_FIELDS: readonly FieldDescriptor[] = [
  field({
    key: 'key',
    label: 'ID',
    type: 'id',
    sortable: true,
    groupable: false,
    filterOps: ['eq', 'in'],
    displayable: true,
    get: (i) => i.key,
  }),
  field({
    key: 'title',
    label: 'Title',
    type: 'text',
    sortable: true,
    groupable: false,
    filterOps: ['contains', 'eq'],
    displayable: true,
    get: (i) => i.title,
  }),
  field({
    key: 'status',
    label: 'Status',
    type: 'status',
    sortable: false,
    groupable: true,
    filterOps: EQUALITY,
    displayable: true,
    get: (i) => i.statusId,
  }),
  field({
    key: 'type',
    label: 'Type',
    type: 'issueType',
    sortable: false,
    groupable: true,
    filterOps: NULLABLE_EQUALITY,
    displayable: true,
    get: (i) => i.typeId,
  }),
  field({
    key: 'statusCategory',
    label: 'Status category',
    type: 'statusCategory',
    sortable: false,
    groupable: false,
    filterOps: EQUALITY,
    displayable: false,
    get: (i) => i.status.category,
  }),
  field({
    key: 'priority',
    label: 'Priority',
    type: 'priority',
    sortable: true,
    groupable: true,
    filterOps: ['eq', 'neq', 'in', 'nin', 'gt', 'gte', 'lt', 'lte'],
    displayable: true,
    get: (i) => i.priority,
  }),
  field({
    key: 'assignee',
    label: 'Assignee',
    type: 'user',
    sortable: false,
    groupable: true,
    filterOps: NULLABLE_EQUALITY,
    displayable: true,
    get: (i) => i.assigneeId,
  }),
  field({
    key: 'creator',
    label: 'Creator',
    type: 'user',
    sortable: false,
    groupable: true,
    filterOps: EQUALITY,
    displayable: true,
    get: (i) => i.creatorId,
  }),
  field({
    key: 'labels',
    label: 'Labels',
    type: 'labels',
    sortable: false,
    groupable: false,
    filterOps: SET,
    displayable: true,
    get: (i) => i.labelIds,
  }),
  field({
    key: 'parent',
    label: 'Parent',
    type: 'issue',
    sortable: false,
    groupable: false,
    filterOps: NULLABLE_EQUALITY,
    displayable: true,
    get: (i) => i.parentId,
  }),
  field({
    key: 'repo',
    label: 'Repository',
    type: 'repo',
    sortable: false,
    groupable: true,
    filterOps: NULLABLE_EQUALITY,
    displayable: true,
    get: (i) => i.repo,
  }),
  field({
    key: 'estimate',
    label: 'Estimate',
    type: 'number',
    sortable: true,
    groupable: false,
    filterOps: RANGE,
    displayable: true,
    get: (i) => i.estimate,
  }),
  field({
    key: 'dueDate',
    label: 'Due date',
    type: 'date',
    sortable: true,
    groupable: false,
    filterOps: RANGE,
    displayable: true,
    get: (i) => i.dueDate,
  }),
  field({
    key: 'commentCount',
    label: 'Comments',
    type: 'number',
    sortable: false,
    groupable: false,
    filterOps: [],
    displayable: true,
    get: (i) => i.commentCount,
  }),
  field({
    key: 'childCount',
    label: 'Sub-issues',
    type: 'number',
    sortable: false,
    groupable: false,
    filterOps: [],
    displayable: true,
    get: (i) => i.childCount,
  }),
  field({
    key: 'createdAt',
    label: 'Created',
    type: 'datetime',
    sortable: true,
    groupable: false,
    filterOps: ['gt', 'gte', 'lt', 'lte'],
    displayable: true,
    get: (i) => i.createdAt,
  }),
  field({
    key: 'updatedAt',
    label: 'Updated',
    type: 'datetime',
    sortable: true,
    groupable: false,
    filterOps: ['gt', 'gte', 'lt', 'lte'],
    displayable: true,
    get: (i) => i.updatedAt,
  }),
  field({
    key: 'completedAt',
    label: 'Completed',
    type: 'datetime',
    sortable: false,
    groupable: false,
    filterOps: ['gt', 'gte', 'lt', 'lte', 'isNull'],
    displayable: true,
    get: (i) => i.completedAt,
  }),
  field({
    key: 'rank',
    label: 'Manual order',
    type: 'text',
    sortable: true,
    groupable: false,
    filterOps: [],
    displayable: false,
    get: (i) => i.rank,
  }),
  // Virtual: full-text-ish search over key, title and description.
  field({
    key: 'text',
    label: 'Text',
    type: 'text',
    sortable: false,
    groupable: false,
    filterOps: ['contains'],
    displayable: false,
    get: (i) => `${i.key}\n${i.title}\n${i.description}`,
  }),
];

/** Custom field definition as needed by the registry (subset of the CustomField resource). */
export interface CustomFieldLike {
  key: string;
  name: string;
  type: 'text' | 'number' | 'date' | 'boolean' | 'select' | 'multi_select' | 'user' | 'url';
}

export const CUSTOM_FIELD_PREFIX = 'cf:';

/** Builds the registry descriptor for a project custom field. */
export function customFieldDescriptor(cf: CustomFieldLike): FieldDescriptor {
  const key = `${CUSTOM_FIELD_PREFIX}${cf.key}`;
  const get = (i: Issue) => i.customFields[cf.key] ?? (cf.type === 'multi_select' ? [] : null);
  const base = { key, label: cf.name, displayable: true, get };
  switch (cf.type) {
    case 'text':
    case 'url':
      return {
        ...base,
        type: cf.type === 'url' ? 'url' : 'text',
        sortable: true,
        groupable: false,
        filterOps: ['eq', 'neq', 'contains', 'isNull'],
      };
    case 'number':
      return { ...base, type: 'number', sortable: true, groupable: false, filterOps: RANGE };
    case 'date':
      return { ...base, type: 'date', sortable: true, groupable: false, filterOps: RANGE };
    case 'boolean':
      return {
        ...base,
        type: 'boolean',
        sortable: false,
        groupable: true,
        filterOps: ['eq', 'isNull'],
      };
    case 'select':
      return {
        ...base,
        type: 'select',
        sortable: false,
        groupable: true,
        filterOps: NULLABLE_EQUALITY,
      };
    case 'multi_select':
      return { ...base, type: 'multiSelect', sortable: false, groupable: false, filterOps: SET };
    case 'user':
      return {
        ...base,
        type: 'user',
        sortable: false,
        groupable: true,
        filterOps: NULLABLE_EQUALITY,
      };
  }
}

/** A field registry for one project: core fields plus its custom fields. */
export class FieldRegistry {
  readonly #fields = new Map<string, FieldDescriptor>();

  constructor(customFields: readonly CustomFieldLike[] = []) {
    for (const f of CORE_FIELDS) this.#fields.set(f.key, f);
    for (const cf of customFields) {
      const d = customFieldDescriptor(cf);
      this.#fields.set(d.key, d);
    }
  }

  get(key: string): FieldDescriptor | undefined {
    return this.#fields.get(key);
  }

  all(): FieldDescriptor[] {
    return [...this.#fields.values()];
  }
}

/** Reads a field value from an issue by registry key (used by `--fields` projection and renderers). */
export function readField(issue: Issue, key: string, registry = new FieldRegistry()): unknown {
  return registry.get(key)?.get(issue);
}
