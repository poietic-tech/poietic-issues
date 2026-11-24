<script lang="ts">
  import { FieldRegistry } from '@poietic-tech/issues-schema';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Plus from '@lucide/svelte/icons/plus';
  import { MediaQuery } from 'svelte/reactivity';
  import type { Issue } from '../api.ts';
  import { groupIssues } from '../grouping.ts';
  import type { ProjectData } from '../project-data.svelte.ts';
  import { openCreateIssue } from '../ui.svelte.ts';
  import { isSelected, selection, setOrder, toggleSelected } from '../selection.svelte.ts';
  import type { ViewConfig } from '../views.ts';
  import FieldValue from './FieldValue.svelte';
  import GroupHeader from './GroupHeader.svelte';
  import StatusPicker from './StatusPicker.svelte';

  /**
   * Issue list with configurable columns (field registry keys) and optional grouping. Every row and the
   * header share one CSS grid template, so columns line up regardless of their content.
   */
  let {
    issues,
    config,
    project,
    onopen,
    active,
  }: {
    issues: Issue[];
    config: ViewConfig;
    project: ProjectData;
    onopen: (key: string) => void;
    active?: string;
  } = $props();

  /** Column widths per field; anything unlisted (custom fields) gets the default. */
  const WIDTH: Record<string, string> = {
    key: '4.5rem',
    status: '8.5rem',
    type: '6rem',
    priority: '2rem',
    assignee: '2rem',
    creator: '2rem',
    labels: '11rem',
    estimate: '3rem',
    dueDate: '5.5rem',
    commentCount: '3rem',
    childCount: '3rem',
    parent: '5rem',
    createdAt: '5.5rem',
    updatedAt: '5.5rem',
    completedAt: '5.5rem',
  };
  /** On phones only these columns stay (status moves in front of the title as an icon). */
  const PHONE = new Set(['priority', 'assignee']);
  /** Icon-only columns: their header label is for screen readers. */
  const ICON = new Set(['priority', 'assignee', 'creator']);

  const narrow = new MediaQuery('max-width: 639px');
  const registry = $derived(new FieldRegistry(project.customFields));
  const groups = $derived(groupIssues(issues, config.list.groupBy, project, false));
  const showKey = $derived(config.list.columns.some((c) => c.field === 'key'));
  const allColumns = $derived(
    config.list.columns
      .map((c) => c.field)
      .filter((f) => f !== 'title' && f !== 'key')
      // Grouped by status, every group heading already says it.
      .filter((f) => !(f === 'status' && config.list.groupBy === 'status')),
  );
  const columns = $derived(narrow.current ? allColumns.filter((f) => PHONE.has(f)) : allColumns);
  const template = $derived(
    [
      narrow.current ? null : '1rem',
      narrow.current ? '1.5rem' : showKey ? WIDTH.key : null,
      'minmax(0, 1fr)',
      ...columns.map((f) => WIDTH[f] ?? '7rem'),
    ]
      .filter(Boolean)
      .join(' '),
  );
  let collapsed = $state<Record<string, boolean>>({});
  const dense = $derived(config.density === 'compact');

  // j/k and shift-click ranges follow the rows on screen (collapsed groups excluded).
  $effect(() => {
    setOrder(groups.filter((g) => !collapsed[g.id]).flatMap((g) => g.issues.map((i) => i.key)));
  });
  const selecting = $derived(selection.selected.length > 0);

  /**
   * A click anywhere on a row opens it, unless it landed on one of the row's own controls.
   * ⌘/Ctrl-click toggles selection, shift-click selects a range.
   */
  function onrowclick(event: MouseEvent, key: string) {
    if ((event.target as HTMLElement).closest('button, a, input, [role="combobox"]')) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || selecting) {
      toggleSelected(key, event.shiftKey);
      return;
    }
    selection.focused = key;
    onopen(key);
  }
</script>

<div class="min-h-0 flex-1 overflow-y-auto" data-testid="issue-list">
  <div
    class="sticky top-0 z-20 grid items-center gap-3 border-b border-border bg-bg px-4 py-1.5 text-xs text-fg-subtle max-sm:hidden"
    style:grid-template-columns={template}
    data-testid="list-header"
  >
    <span></span>
    {#if showKey}<span>ID</span>{/if}
    <span>Title</span>
    {#each columns as field (field)}
      {@const label = registry.get(field)?.label ?? field}
      {#if ICON.has(field)}<span class="sr-only">{label}</span>{:else}<span class="truncate"
          >{label}</span
        >{/if}
    {/each}
  </div>

  {#each groups as group (group.id)}
    {#if config.list.groupBy}
      <div
        class="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-bg-subtle px-4 py-1.5 text-sm sm:top-[29px]"
        data-testid="list-group"
        data-group={group.label}
      >
        <button
          class="flex items-center gap-2"
          aria-expanded={!collapsed[group.id]}
          onclick={() => (collapsed[group.id] = !collapsed[group.id])}
        >
          <ChevronDown
            size={14}
            class="text-fg-subtle transition-transform {collapsed[group.id] ? '-rotate-90' : ''}"
          />
          <GroupHeader spec={group.header} />
          <span class="text-xs text-fg-subtle">{group.issues.length}</span>
        </button>
        {#if config.list.groupBy === 'status' && project.canWrite}
          <button
            class="ml-auto rounded p-0.5 text-fg-subtle hover:bg-bg-hover hover:text-fg"
            aria-label="New issue in {group.label}"
            onclick={() => openCreateIssue(project.key, { status: group.id })}
            ><Plus size={14} /></button
          >
        {/if}
      </div>
    {/if}
    {#if !collapsed[group.id]}
      <ul>
        {#each group.issues as issue (issue.id)}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
          <li
            class="group grid cursor-pointer items-center gap-3 border-b border-border px-4 hover:bg-bg-subtle {dense
              ? 'py-1'
              : 'py-2'} {active === issue.key || isSelected(issue.key)
              ? 'bg-accent-subtle hover:bg-accent-subtle'
              : ''} {selection.focused === issue.key ? 'ring-1 ring-accent/60 ring-inset' : ''}"
            style:grid-template-columns={template}
            data-testid="issue-row"
            data-key={issue.key}
            data-focused={selection.focused === issue.key}
            data-selected={isSelected(issue.key)}
            onclick={(e) => onrowclick(e, issue.key)}
          >
            {#if !narrow.current}
              <input
                type="checkbox"
                class="size-3.5 accent-accent {selecting || isSelected(issue.key)
                  ? ''
                  : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}"
                checked={isSelected(issue.key)}
                aria-label="Select {issue.key}"
                data-testid="row-select"
                onclick={(e) => {
                  e.preventDefault();
                  toggleSelected(issue.key, e.shiftKey);
                }}
              />
            {/if}
            {#if narrow.current}
              <span class="flex items-center"
                ><StatusPicker
                  {issue}
                  statuses={project.statuses}
                  showLabel={false}
                  readonly={!project.canWrite}
                /></span
              >
            {:else if showKey}
              <FieldValue {issue} field="key" {project} />
            {/if}
            <button
              class="min-w-0 truncate text-left {narrow.current ? '' : 'font-medium'}"
              onclick={() => onopen(issue.key)}>{issue.title}</button
            >
            {#each columns as field (field)}
              <span
                class="flex min-w-0 items-center overflow-hidden {(field === 'assignee' &&
                  !issue.assigneeId) ||
                (field === 'priority' && issue.priority === 0)
                  ? 'opacity-40 transition-opacity group-hover:opacity-100 focus-within:opacity-100'
                  : ''}"
                data-field={field}
              >
                <FieldValue {issue} {field} {project} compact={field !== 'status'} nowrap />
              </span>
            {/each}
          </li>
        {/each}
      </ul>
    {/if}
  {/each}
</div>
