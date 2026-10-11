<script lang="ts">
  import { useQueryClient } from '@tanstack/svelte-query';
  import { compareIssues } from '@poietic-tech/issues-schema';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import ChevronsLeftRight from '@lucide/svelte/icons/chevrons-left-right';
  import Minimize2 from '@lucide/svelte/icons/minimize-2';
  import Plus from '@lucide/svelte/icons/plus';
  import { generateKeyBetween } from 'fractional-indexing';
  import { flip } from 'svelte/animate';
  import { dndzone, type DndEvent, TRIGGERS } from 'svelte-dnd-action';
  import type { Issue } from '../api.ts';
  import { type GroupHeaderSpec, groupIssues, NONE } from '../grouping.ts';
  import { moveIssue, updateIssue } from '../issues.ts';
  import type { ProjectData } from '../project-data.svelte.ts';
  import { openCreateIssue } from '../ui.svelte.ts';
  import { isSelected, selection, setOrder, toggleSelected } from '../selection.svelte.ts';
  import type { ViewConfig } from '../views.ts';
  import GroupHeader from './GroupHeader.svelte';
  import IssueCard from './IssueCard.svelte';

  /**
   * Kanban board. Columns come from `board.groupBy` (status by default). Dropping a card:
   * - status columns: `move` (status + position between its new neighbours; the server computes the rank),
   * - other groupings (priority, assignee, select custom fields): a PATCH of that field.
   * Both are optimistic and roll back on failure.
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

  const qc = useQueryClient();
  const FLIP_MS = 150;
  type Column = { id: string; label: string; header: GroupHeaderSpec; items: Issue[] };

  const groupBy = $derived(config.board.groupBy || 'status');
  const manualOrder = $derived(config.sort[0]?.field === 'rank');
  const sorted = $derived([...issues].sort(compareIssues(config.sort)));
  const derivedColumns = $derived<Column[]>(
    groupIssues(sorted, groupBy, project, config.board.showEmptyGroups).map((g) => ({
      id: g.id,
      label: g.label,
      header: g.header,
      items: g.issues,
    })),
  );

  // Column arrays are replaced wholesale (never mutated) as svelte-dnd-action expects; while a drag is in
  // progress they are owned by the drag, otherwise re-derived from the (optimistically updated) query data.
  let columns = $state.raw<Column[]>([]);
  let dragging = $state(false);
  $effect(() => {
    const next = derivedColumns;
    if (!dragging) columns = next;
  });

  function replaceItems(index: number, items: Issue[]) {
    columns = columns.map((c, i) => (i === index ? { ...c, items } : c));
  }

  function onconsider(index: number, event: CustomEvent<DndEvent<Issue>>) {
    // Keyboard drags send one last `consider` (dragStopped) after `finalize`.
    dragging = event.detail.info.trigger !== TRIGGERS.DRAG_STOPPED;
    replaceItems(index, event.detail.items);
  }

  function onfinalize(index: number, event: CustomEvent<DndEvent<Issue>>) {
    const { items, info } = event.detail;
    replaceItems(index, items);
    const position = items.findIndex((i) => i.id === info.id);
    if (position < 0) return; // the source column of a cross-column move; the target handles it
    dragging = false;
    const issue = issues.find((i) => i.id === info.id);
    const column = columns[index];
    if (!issue || !column) return;
    if (info.trigger === TRIGGERS.DROPPED_OUTSIDE_OF_ANY) return;
    void drop(issue, column, items, position);
  }

  async function drop(issue: Issue, column: Column, items: Issue[], position: number) {
    const prev = items[position - 1];
    const next = items[position + 1];
    if (groupBy === 'status') {
      const status = project.statuses.find((s) => s.id === column.id);
      if (!status) return;
      const original = derivedColumns.find((c) => c.id === issue.statusId)?.items ?? [];
      const oldIndex = original.findIndex((i) => i.id === issue.id);
      const unchanged =
        status.id === issue.statusId &&
        original[oldIndex - 1]?.id === prev?.id &&
        original[oldIndex + 1]?.id === next?.id;
      if (unchanged || (status.id === issue.statusId && !manualOrder)) return;
      let rank = issue.rank;
      if (manualOrder) {
        try {
          rank = generateKeyBetween(prev?.rank ?? null, next?.rank ?? null);
        } catch {
          // neighbours share a rank; the server rebalances and its answer replaces this guess
        }
      }
      await moveIssue(
        qc,
        issue,
        {
          status: status.id,
          ...(manualOrder
            ? prev
              ? { afterId: prev.id }
              : next
                ? { beforeId: next.id }
                : { position: 'top' as const }
            : {}),
        },
        {
          statusId: status.id,
          status: {
            id: status.id,
            name: status.name,
            category: status.category,
            color: status.color,
          },
          rank,
        },
      );
      return;
    }
    const value = column.id === NONE ? null : column.id;
    if (groupBy === 'priority') {
      if (Number(value) !== issue.priority)
        await updateIssue(qc, issue, { priority: Number(value) }, { priority: Number(value) });
    } else if (groupBy === 'assignee') {
      if (value === issue.assigneeId) return;
      const user = project.users.find((u) => u.id === value) ?? null;
      await updateIssue(
        qc,
        issue,
        { assignee: value },
        {
          assigneeId: value,
          assignee: user
            ? {
                id: user.id,
                handle: user.handle,
                name: user.name,
                kind: user.kind,
                avatarUrl: user.avatarUrl,
                owner: user.owner ?? null,
              }
            : null,
        },
      );
    } else if (groupBy.startsWith('cf:')) {
      const key = groupBy.slice(3);
      const field = project.customFields.find((f) => f.key === key);
      // Boolean columns are keyed "true"/"false"; other types use the stored value itself.
      const next = field?.type === 'boolean' && value !== null ? value === 'true' : value;
      if ((issue.customFields[key] ?? null) === next) return;
      const customFields = { ...issue.customFields };
      if (next === null) delete customFields[key];
      else customFields[key] = next;
      await updateIssue(qc, issue, { customFields: { [key]: next } }, { customFields });
    }
  }

  // j/k follow the cards on screen, column by column (collapsed columns excluded).
  $effect(() => {
    setOrder(columns.filter((c) => !collapsed[c.id]).flatMap((c) => c.items.map((i) => i.key)));
  });

  // Collapsed columns, remembered per project and grouping in this browser (a viewer convenience).
  const collapseKey = $derived(`tracker.board.collapsed.${project.key}.${groupBy}`);
  let collapsed = $state<Record<string, boolean>>({});
  $effect(() => {
    try {
      collapsed = JSON.parse(localStorage.getItem(collapseKey) ?? '{}') as Record<string, boolean>;
    } catch {
      collapsed = {};
    }
  });
  function toggleCollapsed(id: string) {
    collapsed = { ...collapsed, [id]: !collapsed[id] };
    try {
      localStorage.setItem(collapseKey, JSON.stringify(collapsed));
    } catch {
      // not persisted; still works for this visit
    }
  }

  // Scroll affordances: arrows appear when columns are hidden off either edge.
  let scroller = $state<HTMLElement>();
  let canLeft = $state(false);
  let canRight = $state(false);
  function measure() {
    if (!scroller) return;
    canLeft = scroller.scrollLeft > 4;
    canRight = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 4;
  }
  $effect(() => {
    void columns;
    void collapsed;
    if (!scroller) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  });
  function scrollBy(direction: 1 | -1) {
    if (!scroller) return;
    // Most of a screen at a time, keeping a sliver of the previous columns for context.
    scroller.scrollBy({ left: direction * scroller.clientWidth * 0.8, behavior: 'smooth' });
  }

  // Dragging a card changes the issue, so it needs write access.
  const draggable = $derived(
    project.canWrite &&
      (['status', 'priority', 'assignee'].includes(groupBy) || groupBy.startsWith('cf:')),
  );
</script>

<div class="relative flex min-h-0 min-w-0 flex-1">
  <div
    bind:this={scroller}
    onscroll={measure}
    class="flex min-h-0 min-w-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto bg-bg-subtle p-3 sm:snap-none"
    data-testid="board"
  >
    {#each columns as column, index (column.id)}
      {#if collapsed[column.id]}
        <button
          class="flex w-10 shrink-0 flex-col items-center gap-2 rounded-xl bg-bg-muted/70 py-3 text-sm hover:bg-bg-muted"
          onclick={() => toggleCollapsed(column.id)}
          aria-label="Expand {column.label}"
          title="Expand {column.label}"
          data-testid="board-column-collapsed"
          data-column={column.label}
        >
          <ChevronsLeftRight size={14} class="text-fg-subtle" />
          <span class="text-xs text-fg-subtle">{column.items.length}</span>
          <span class="font-medium [writing-mode:vertical-rl]"
            ><GroupHeader spec={column.header} /></span
          >
        </button>
      {:else}
        <section
          class="flex w-[85vw] shrink-0 snap-start flex-col rounded-xl bg-bg-muted/60 sm:w-72"
          data-testid="board-column"
          data-column={column.label}
        >
          <header class="group/col flex items-center gap-2 px-3 pt-2.5 pb-2 text-sm">
            <GroupHeader spec={column.header} />
            <span class="text-xs text-fg-subtle" data-testid="column-count"
              >{column.items.length}</span
            >
            <span class="ml-auto flex items-center gap-0.5">
              <button
                class="rounded p-0.5 text-fg-subtle opacity-0 group-hover/col:opacity-100 hover:bg-bg-hover hover:text-fg focus:opacity-100"
                aria-label="Collapse {column.label}"
                title="Collapse column"
                onclick={() => toggleCollapsed(column.id)}><Minimize2 size={13} /></button
              >
              {#if groupBy === 'status' && project.canWrite}
                <button
                  class="rounded p-0.5 text-fg-subtle hover:bg-bg-hover hover:text-fg"
                  aria-label="New issue in {column.label}"
                  onclick={() => openCreateIssue(project.key, { status: column.id })}
                  ><Plus size={14} /></button
                >
              {/if}
            </span>
          </header>
          <div class="relative flex min-h-0 flex-1 flex-col">
            {#if column.items.length === 0}
              <p
                class="pointer-events-none absolute inset-x-2 top-0 rounded-lg border border-dashed border-border py-6 text-center text-xs text-fg-subtle"
              >
                No issues
              </p>
            {/if}
            <div
              class="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto rounded-lg px-2 pb-8"
              use:dndzone={{
                items: column.items,
                type: 'issues',
                flipDurationMs: FLIP_MS,
                dragDisabled: !draggable,
                dropTargetStyle: {
                  outline: '2px dashed var(--color-border-strong)',
                  'outline-offset': '-2px',
                },
              }}
              onconsider={(e) => onconsider(index, e)}
              onfinalize={(e) => onfinalize(index, e)}
            >
              {#each column.items as issue (issue.id)}
                <div animate:flip={{ duration: FLIP_MS }}>
                  <IssueCard
                    {issue}
                    fields={config.board.cardFields}
                    {project}
                    density={config.density}
                    active={active === issue.key}
                    focused={selection.focused === issue.key}
                    selected={isSelected(issue.key)}
                    onopen={(key) => {
                      selection.focused = key;
                      onopen(key);
                    }}
                    onselect={toggleSelected}
                  />
                </div>
              {/each}
            </div>
          </div>
        </section>
      {/if}
    {/each}
  </div>
  {#if canLeft}
    <button
      class="absolute top-1/2 left-2 z-10 hidden -translate-y-1/2 rounded-full border border-border bg-bg p-1.5 text-fg-muted shadow-md hover:text-fg sm:block"
      aria-label="Scroll columns left"
      onclick={() => scrollBy(-1)}><ChevronLeft size={16} /></button
    >
  {/if}
  {#if canRight}
    <div
      class="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-bg-subtle to-transparent"
    ></div>
    <button
      class="absolute top-1/2 right-2 z-10 hidden -translate-y-1/2 rounded-full border border-border bg-bg p-1.5 text-fg-muted shadow-md hover:text-fg sm:block"
      aria-label="Scroll columns right"
      data-testid="board-scroll-right"
      onclick={() => scrollBy(1)}><ChevronRight size={16} /></button
    >
  {/if}
</div>
