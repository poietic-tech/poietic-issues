<script lang="ts">
  import Search from '@lucide/svelte/icons/search';
  import X from '@lucide/svelte/icons/x';
  import GitBranch from '@lucide/svelte/icons/git-branch';
  import { FieldRegistry, type IssueFilter } from '@poietic-tech/issues-schema';
  import type { Issue } from '../api.ts';
  import { PRIORITY_LABELS, PRIORITY_ORDER, unknownUserLabel } from '../format.ts';
  import type { ProjectData } from '../project-data.svelte.ts';
  import Avatar from './Avatar.svelte';
  import FilterChip from './FilterChip.svelte';
  import PriorityIcon from './PriorityIcon.svelte';
  import StatusIcon from './StatusIcon.svelte';
  import TypeBadge from './TypeBadge.svelte';

  /**
   * Quick filters over the view's IssueFilter: text, then status, type, assignee, labels, priority and repository (each
   * "is any of" or "is not any of"). Other conditions (from saved views, URLs or the CLI) show as removable pills.
   */
  let {
    filter,
    project,
    issues = [],
    onchange,
  }: {
    filter: IssueFilter;
    project: ProjectData;
    /** The issues in view: signed out, they are the only source of people for the assignee filter. */
    issues?: Issue[];
    onchange: (f: IssueFilter) => void;
  } = $props();

  type Value = string | number | null;
  const QUICK = ['status', 'type', 'assignee', 'labels', 'priority', 'repo'];
  const quickOf = (field: string) =>
    filter.conditions.find((c) => c.field === field && (c.op === 'in' || c.op === 'nin'));
  const valuesOf = (field: string): Value[] => (quickOf(field)?.value as Value[] | undefined) ?? [];
  const negatedOf = (field: string) => quickOf(field)?.op === 'nin';
  const text = $derived(
    (filter.conditions.find((c) => c.field === 'text')?.value as string | undefined) ?? '',
  );
  const others = $derived(
    filter.conditions.filter(
      (c) => !(QUICK.includes(c.field) && (c.op === 'in' || c.op === 'nin')) && c.field !== 'text',
    ),
  );

  function setIn(field: string, values: Value[], negated = negatedOf(field)) {
    const rest = filter.conditions.filter((c) => c !== quickOf(field));
    onchange({
      conditions: values.length
        ? [...rest, { field, op: negated ? 'nin' : 'in', value: values }]
        : rest,
    });
  }
  function toggle(field: string, value: Value) {
    const current = valuesOf(field);
    setIn(
      field,
      current.includes(value) ? current.filter((v) => v !== value) : [...current, value],
    );
  }
  /**
   * Picker values are strings; the filter stores null for "no type", "no assignee" and "no repository" (`in [null]`, which
   * the server and the live matcher both read as "is unset"), and numbers for priority.
   */
  const NONE = '__none__';
  const toKey = (v: Value) => (v === null ? NONE : String(v));
  function fromKey(field: string, key: string): Value {
    if (key === NONE) return null;
    return field === 'priority' ? Number(key) : key;
  }

  type Person = Issue['creator'];
  /**
   * People the assignee filter offers: the user directory, plus the assignees embedded in the issues (all a
   * signed-out visitor gets). Assignees once seen are kept, so narrowing the list doesn't drop them from the menu.
   */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a memo filled while deriving `people`, never read reactively
  const seen = new Map<string, Person>();
  const people = $derived.by(() => {
    for (const i of issues) if (i.assignee) seen.set(i.assignee.id, i.assignee);
    const directory = new Set(project.users.map((u) => u.id));
    const extra = [...seen.values()]
      .filter((p) => !directory.has(p.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    return [...project.users, ...extra] as Person[];
  });
  /** Chosen assignees nobody describes (from a saved view, or a removed user) still get an item. */
  const unknownAssignees = $derived(
    valuesOf('assignee').filter(
      (v): v is string => typeof v === 'string' && v !== 'me' && !people.some((p) => p.id === v),
    ),
  );

  const registry = $derived(new FieldRegistry(project.customFields));
  const OPS: Record<string, string> = {
    eq: 'is',
    neq: 'is not',
    in: 'is any of',
    nin: 'is none of',
    gt: '>',
    gte: '≥',
    lt: '<',
    lte: '≤',
    contains: 'contains',
  };
  /** Human wording for conditions the chips don't cover (from saved views, URLs or the CLI). */
  function describe(c: IssueFilter['conditions'][number]): string {
    const label = registry.get(c.field)?.label ?? c.field;
    if (c.op === 'isNull') return `${label} ${c.value === false ? 'is set' : 'is empty'}`;
    const value = Array.isArray(c.value) ? c.value.join(', ') : String(c.value);
    return `${label} ${OPS[c.op] ?? c.op} ${value}`;
  }

  /** State and handlers shared by every quick-filter chip. */
  function chipProps(field: string) {
    return {
      values: valuesOf(field).map(toKey),
      negated: negatedOf(field),
      ontoggle: (v: string) => toggle(field, fromKey(field, v)),
      onnegate: () => setIn(field, valuesOf(field), !negatedOf(field)),
      onclear: () => setIn(field, []),
    };
  }

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  function onsearch(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const rest = filter.conditions.filter((c) => c.field !== 'text');
      onchange({
        conditions: value.trim()
          ? [...rest, { field: 'text', op: 'contains', value: value.trim() }]
          : rest,
      });
    }, 250);
  }
</script>

<div class="flex items-center gap-1.5 sm:flex-wrap" data-testid="filter-bar">
  <label
    class="flex items-center gap-1.5 rounded-md border border-border bg-bg px-2 py-1 text-sm focus-within:border-border-strong"
  >
    <Search size={13} class="text-fg-subtle" />
    <input
      value={text}
      oninput={onsearch}
      placeholder="Search…"
      aria-label="Search issues"
      data-testid="search"
      class="w-40 bg-transparent outline-none placeholder:text-fg-subtle"
    />
  </label>

  <FilterChip
    label="Status"
    plural="statuses"
    items={project.statuses.map((s) => ({ value: s.id, label: s.name, s }))}
    {...chipProps('status')}
    testid="filter-status"
  >
    {#snippet item(it)}<StatusIcon category={it.s.category} color={it.s.color} /><span
        >{it.label}</span
      >{/snippet}
  </FilterChip>

  {#if project.issueTypes.length || valuesOf('type').length}
    <FilterChip
      label="Type"
      plural="types"
      items={[
        { value: NONE, label: 'No type', color: 'transparent' },
        ...project.issueTypes.map((t) => ({ value: t.id, label: t.name, color: t.color })),
      ]}
      {...chipProps('type')}
      testid="filter-type"
    >
      {#snippet item(it)}<TypeBadge name={it.label} color={it.color} />{/snippet}
    </FilterChip>
  {/if}

  <FilterChip
    label="Assignee"
    plural="people"
    items={[
      { value: NONE, label: 'No assignee', u: null },
      ...people.map((u) => ({ value: u.id, label: u.name, keywords: [u.handle], u })),
      ...unknownAssignees.map((id) => ({ value: id, label: unknownUserLabel(id), u: null })),
    ]}
    {...chipProps('assignee')}
    testid="filter-assignee"
  >
    {#snippet item(it)}<Avatar user={it.u} size={16} /><span>{it.label}</span>{/snippet}
  </FilterChip>

  <FilterChip
    label="Labels"
    plural="labels"
    items={project.labels.map((l) => ({ value: l.id, label: l.name, l }))}
    {...chipProps('labels')}
    testid="filter-labels"
  >
    {#snippet item(it)}<span class="size-2.5 rounded-full" style:background={it.l.color}
      ></span><span>{it.label}</span>{/snippet}
  </FilterChip>

  <FilterChip
    label="Priority"
    plural="priorities"
    items={PRIORITY_ORDER.map((p) => ({ value: String(p), label: PRIORITY_LABELS[p], p }))}
    {...chipProps('priority')}
    testid="filter-priority"
  >
    {#snippet item(it)}<PriorityIcon priority={it.p} /><span>{it.label}</span>{/snippet}
  </FilterChip>

  <!--
    Chosen values are `owner/name` as the project spells them, which is what `Issue.repo` holds (the live matcher
    compares them exactly). A saved view or the CLI may hold other spellings (a URL, an id, another case) or a repo
    the project no longer links: those show as their own items, so the chip still states the filter.
  -->
  {#if project.repos.length || valuesOf('repo').length}
    <FilterChip
      label="Repository"
      plural="repositories"
      items={[
        { value: NONE, label: 'No repository' },
        ...project.repos.map((r) => ({ value: r.fullName, label: r.fullName })),
        ...valuesOf('repo')
          .filter((v): v is string | number => v !== null)
          .map(String)
          .filter((v) => !project.repos.some((r) => r.fullName === v))
          .map((v) => ({ value: v, label: v })),
      ]}
      {...chipProps('repo')}
      testid="filter-repo"
    >
      {#snippet item(it)}<GitBranch size={14} class="text-fg-subtle" /><span class="truncate"
          >{it.label}</span
        >{/snippet}
    </FilterChip>
  {/if}

  {#each others as c, i (i)}
    <span
      class="inline-flex items-center gap-1 rounded-md bg-bg-muted px-2 py-1 text-xs text-fg-muted"
    >
      {describe(c)}
      <button
        aria-label="Remove filter {describe(c)}"
        onclick={() => onchange({ conditions: filter.conditions.filter((x) => x !== c) })}
        class="hover:text-fg"><X size={12} /></button
      >
    </span>
  {/each}

  {#if filter.conditions.length}
    <button
      class="text-xs text-fg-subtle hover:text-fg"
      onclick={() => onchange({ conditions: [] })}>Clear</button
    >
  {/if}
</div>
