import { SYSTEM_ACTOR, type ServiceContext, withActor } from '../context.ts';
import { createComment } from './comments.ts';
import { createCustomField } from './custom-fields.ts';
import { createIssue, moveIssue, updateIssue } from './issues.ts';
import { createLabel } from './labels.ts';
import { createLink } from './links.ts';
import { addMember } from './members.ts';
import { createProject } from './projects.ts';
import { addRepo } from './repos.ts';
import { createUserUnchecked, toActor } from './users.ts';

/**
 * Creates demo data for development: an admin (`ada`), members (`grace`, `margaret`), an agent (`claude`),
 * a public `ENG` project (one linked repo; labels, issues in every column, sub-issues, links and comments)
 * and a private `OPS` project where margaret manages, grace edits and claude only views.
 * Not idempotent — run it on an empty database. Returns the handles of the users it created; it mints no credentials.
 */
export async function seedDemoData(ctx: ServiceContext): Promise<{ users: string[] }> {
  const sys = withActor(ctx, SYSTEM_ACTOR);
  const ada = await createUserUnchecked(sys, {
    handle: 'ada',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    role: 'admin',
  });
  const grace = await createUserUnchecked(sys, {
    handle: 'grace',
    name: 'Grace Hopper',
    email: 'grace@example.com',
  });
  const claude = await createUserUnchecked(sys, {
    handle: 'claude',
    name: 'Claude',
    kind: 'agent',
  });
  const margaret = await createUserUnchecked(sys, {
    handle: 'margaret',
    name: 'Margaret Hamilton',
    email: 'margaret@example.com',
  });
  const asAda = withActor(ctx, toActor(ada));
  const asClaude = withActor(ctx, toActor(claude));

  await createProject(asAda, {
    key: 'ENG',
    name: 'Engineering',
    description: 'Product engineering: the web app, API and CLI.',
    visibility: 'public',
  });
  // ENG is public: anyone can read it. The non-admin demo users edit it (as migration 0004's backfill
  // would make them).
  await addMember(asAda, 'ENG', { user: 'grace', role: 'editor' });
  await addMember(asAda, 'ENG', { user: 'claude', role: 'editor' });
  await addRepo(asAda, 'ENG', { repo: 'poietic-tech/poietic-issues' });
  for (const [name, color] of [
    ['bug', '#eb5757'],
    ['feature', '#5e6ad2'],
    ['chore', '#95a2b3'],
    ['docs', '#4cb782'],
  ] as const) {
    await createLabel(asAda, 'ENG', { name, color });
  }

  await createCustomField(asAda, 'ENG', {
    key: 'severity',
    name: 'Severity',
    type: 'select',
    description: 'Customer impact of a bug',
    options: [
      { value: 'low', label: 'Low', color: '#95a2b3' },
      { value: 'medium', label: 'Medium', color: '#f2c94c' },
      { value: 'high', label: 'High', color: '#f2994a' },
      { value: 'critical', label: 'Critical', color: '#eb5757' },
    ],
  });

  const epic = await createIssue(asAda, 'ENG', {
    title: 'Ship the v1 issue tracker',
    description:
      'Umbrella issue for the first release.\n\n- [x] Data model\n- [ ] Web UI\n- [ ] CLI',
    priority: 2,
    status: 'In Progress',
    assignee: 'ada',
    labels: ['feature'],
    repo: 'poietic-tech/poietic-issues',
  });
  const kanban = await createIssue(asAda, 'ENG', {
    title: 'Kanban board with customizable cards',
    priority: 2,
    status: 'Todo',
    parent: epic.key,
    assignee: 'grace',
    labels: ['feature'],
    estimate: 5,
  });
  const cli = await createIssue(asClaude, 'ENG', {
    title: 'Agent-friendly CLI with JSON output',
    description: 'Every command supports `--json`; errors carry stable codes.',
    priority: 1,
    status: 'In Review',
    parent: epic.key,
    assignee: 'claude',
    labels: ['feature'],
    estimate: 3,
    repo: 'poietic-tech/poietic-issues',
  });
  const bug = await createIssue(asAda, 'ENG', {
    title: 'Dragging a card to an empty column loses its position',
    priority: 1,
    status: 'Todo',
    labels: ['bug'],
    dueDate: '2026-10-15',
    customFields: { severity: 'high' },
    repo: 'poietic-tech/poietic-issues',
  });
  await createIssue(asAda, 'ENG', {
    title: 'Write the API guide',
    status: 'Backlog',
    labels: ['docs'],
    priority: 4,
  });
  await createIssue(asAda, 'ENG', {
    title: 'Set up CI for Postgres',
    status: 'Done',
    labels: ['chore'],
    priority: 3,
  });
  await createIssue(asAda, 'ENG', { title: 'Evaluate GraphQL', status: 'Canceled', priority: 0 });

  await createLink(asAda, bug.key, { type: 'blocks', target: kanban.key });
  await createLink(asAda, cli.key, { type: 'relates', target: kanban.key });
  await createComment(asClaude, cli.key, {
    body: 'Opened a draft. Exit codes are documented in `docs/cli.md`.',
  });
  await createComment(asAda, cli.key, {
    body: 'Looks great — can we add `--fields` projection too?',
  });
  await updateIssue(asClaude, cli.key, { addLabels: ['docs'] });
  await moveIssue(asAda, bug.key, { position: 'top' });

  // OPS is private: only members (and admins) can see it, at three different roles.
  await createProject(asAda, {
    key: 'OPS',
    name: 'Operations',
    description: 'Private: infrastructure, on-call and incident follow-ups.',
    visibility: 'private',
  });
  await addMember(asAda, 'OPS', { user: 'margaret', role: 'manager' });
  await addMember(asAda, 'OPS', { user: 'grace', role: 'editor' });
  await addMember(asAda, 'OPS', { user: 'claude', role: 'viewer' });
  const asMargaret = withActor(ctx, toActor(margaret));
  await createIssue(asMargaret, 'OPS', {
    title: 'Rotate the production database credentials',
    priority: 1,
    status: 'Todo',
  });
  await createIssue(asMargaret, 'OPS', {
    title: 'Write the on-call runbook',
    description: 'Only members of this project can see this issue.',
    priority: 2,
    status: 'In Progress',
  });

  return { users: [ada, grace, margaret, claude].map((u) => u.handle) };
}
