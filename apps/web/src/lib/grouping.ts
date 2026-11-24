import type { Issue } from './api.ts';
import { PRIORITY_LABELS, PRIORITY_ORDER, unknownUserLabel } from './format.ts';
import type { ProjectData } from './project-data.svelte.ts';

export type GroupHeaderSpec =
  | { kind: 'status'; label: string; category: string; color: string }
  | { kind: 'priority'; label: string; priority: number }
  | { kind: 'user'; label: string; user: Issue['creator'] | null }
  | { kind: 'option'; label: string; color: string }
  | { kind: 'plain'; label: string };

export interface IssueGroup {
  /** Group value: status id, priority number, user id, option value, `true`/`false`, or `__none__`. */
  id: string;
  label: string;
  issues: Issue[];
  header: GroupHeaderSpec;
}

export const NONE = '__none__';

type GroupSpec = Omit<IssueGroup, 'issues'> & { match: (i: Issue) => boolean };

function group(id: string, header: GroupHeaderSpec, match: (i: Issue) => boolean): GroupSpec {
  return { id, label: header.label, header, match };
}

/**
 * One group per user: the project's users, plus anyone the issues mention that the directory lacks. Signed-out
 * visitors cannot list users, so they know people only from the issues themselves (`user` reads the embedded
 * summary); a value no one describes (a user-type custom field, a deactivated user) still gets its own group,
 * so no issue ever drops out of the list or board.
 */
function userGroups(
  project: ProjectData,
  issues: Issue[],
  value: (i: Issue) => unknown,
  user?: (i: Issue) => Issue['creator'] | null,
): GroupSpec[] {
  const users = new Map<string, Issue['creator']>(project.users.map((u) => [u.id, u]));
  if (user)
    for (const issue of issues) {
      const u = user(issue);
      if (u && !users.has(u.id)) users.set(u.id, u);
    }
  const known = [...users.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((u) => group(u.id, { kind: 'user', label: u.name, user: u }, (i) => value(i) === u.id));
  const unknown = [
    ...new Set(
      issues
        .map(value)
        .filter((v): v is string => typeof v === 'string' && v !== '' && !users.has(v)),
    ),
  ]
    .sort()
    .map((id) =>
      group(id, { kind: 'user', label: unknownUserLabel(id), user: null }, (i) => value(i) === id),
    );
  return [...known, ...unknown];
}

function customFieldGroups(issues: Issue[], key: string, project: ProjectData): GroupSpec[] {
  const field = project.customFields.find((f) => f.key === key);
  const value = (i: Issue) => i.customFields[key];
  const isNone = (i: Issue) => value(i) === null || value(i) === undefined;
  const none = group(NONE, { kind: 'plain', label: `No ${field?.name ?? key}` }, isNone);
  switch (field?.type) {
    case 'select':
      return [
        none,
        ...field.options
          // Archived options stay as columns only while issues still use them.
          .filter((o) => !o.archivedAt || issues.some((i) => value(i) === o.value))
          .map((o) =>
            group(
              o.value,
              { kind: 'option', label: o.label, color: o.color },
              (i) => value(i) === o.value,
            ),
          ),
      ];
    case 'boolean':
      return [
        none,
        group('true', { kind: 'plain', label: `${field.name}: yes` }, (i) => value(i) === true),
        group('false', { kind: 'plain', label: `${field.name}: no` }, (i) => value(i) === false),
      ];
    case 'user':
      return [none, ...userGroups(project, issues, value)];
    default: {
      const values = [
        ...new Set(issues.filter((i) => !isNone(i)).map((i) => String(value(i)))),
      ].sort();
      return [
        none,
        ...values.map((v) => group(v, { kind: 'plain', label: v }, (i) => String(value(i)) === v)),
      ];
    }
  }
}

/**
 * Splits issues into groups for a groupable field (list groups / board columns). Group order follows the
 * domain: statuses and issue types by position (no type first), priorities urgent→none, users alphabetically with "No assignee" first,
 * select options in their configured order.
 */
export function groupIssues(
  issues: Issue[],
  groupBy: string | null,
  project: ProjectData,
  includeEmpty: boolean,
): IssueGroup[] {
  const all: IssueGroup[] = [
    { id: 'all', label: 'All', issues, header: { kind: 'plain', label: 'All' } },
  ];
  if (!groupBy) return all;

  let groups: GroupSpec[];
  if (groupBy === 'status') {
    groups = project.statuses.map((s) =>
      group(
        s.id,
        { kind: 'status', label: s.name, category: s.category, color: s.color },
        (i) => i.statusId === s.id,
      ),
    );
  } else if (groupBy === 'type') {
    const types = project.issueTypes.map((t) => ({ id: t.id, name: t.name, color: t.color }));
    // A type the list no longer has can still appear on a stale snapshot; keep those issues visible.
    for (const issue of issues)
      if (issue.type && !types.some((t) => t.id === issue.type!.id)) types.push(issue.type);
    groups = [
      group(NONE, { kind: 'plain', label: 'No type' }, (i) => i.typeId === null),
      ...types.map((t) =>
        group(t.id, { kind: 'option', label: t.name, color: t.color }, (i) => i.typeId === t.id),
      ),
    ];
  } else if (groupBy === 'priority') {
    groups = PRIORITY_ORDER.map((p) =>
      group(
        String(p),
        { kind: 'priority', label: PRIORITY_LABELS[p], priority: p },
        (i) => i.priority === p,
      ),
    );
  } else if (groupBy === 'assignee') {
    groups = [
      group(NONE, { kind: 'user', label: 'No assignee', user: null }, (i) => i.assigneeId === null),
      ...userGroups(
        project,
        issues,
        (i) => i.assigneeId,
        (i) => i.assignee,
      ),
    ];
  } else if (groupBy === 'creator') {
    groups = userGroups(
      project,
      issues,
      (i) => i.creatorId,
      (i) => i.creator,
    );
  } else if (groupBy === 'repo') {
    const names = new Set(project.repos.map((r) => r.fullName));
    // Repos the project no longer links can still appear on a stale snapshot; keep those issues visible.
    for (const issue of issues) if (issue.repo) names.add(issue.repo);
    groups = [
      group(NONE, { kind: 'plain', label: 'No repository' }, (i) => i.repo === null),
      ...[...names]
        .sort((a, b) => a.localeCompare(b))
        .map((n) => group(n, { kind: 'plain', label: n }, (i) => i.repo === n)),
    ];
  } else if (groupBy.startsWith('cf:')) {
    groups = customFieldGroups(issues, groupBy.slice(3), project);
  } else {
    return all;
  }
  return groups
    .map(({ match, ...g }) => ({ ...g, issues: issues.filter(match) }))
    .filter((g) => includeEmpty || g.issues.length > 0);
}
