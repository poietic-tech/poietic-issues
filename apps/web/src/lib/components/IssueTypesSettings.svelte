<script lang="ts">
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { api, call, errorMessage, type IssueType } from '../api.ts';
  import { confirmAction } from '../confirm.svelte.ts';
  import { keys } from '../queries.ts';
  import { btn, input } from '../styles.ts';
  import { toast } from '../toast.svelte.ts';
  import ColorInput from './ColorInput.svelte';
  import SortableList from './SortableList.svelte';

  /** Settings section for a project's issue types (ADR 0035): rename, recolor, reorder, add and delete. */
  let { projectKey, types }: { projectKey: string; types: IssueType[] } = $props();
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.issueTypes(projectKey) });
    void qc.invalidateQueries({ queryKey: keys.issueLists(projectKey) });
    void qc.invalidateQueries({ queryKey: ['issue'] });
  };

  async function run<T>(action: Promise<T>, saved?: string): Promise<T | undefined> {
    try {
      const result = await action;
      refresh();
      if (saved) toast(saved, 'success');
      return result;
    } catch (e) {
      toast(errorMessage(e), 'error');
      return undefined;
    }
  }

  function update(t: IssueType, body: { name?: string; color?: string }) {
    return run(
      call(api.PATCH('/issue-types/{id}', { params: { path: { id: t.id } }, body })),
      `Saved “${body.name ?? t.name}”`,
    );
  }
  function reorder(ids: string[]) {
    return run(
      call(
        api.POST('/projects/{project}/issue-types/reorder', {
          params: { path: { project: projectKey } },
          body: { ids },
        }),
      ),
      'Type order saved',
    );
  }
  async function remove(t: IssueType) {
    const ok = await confirmAction({
      title: `Delete the type “${t.name}”?`,
      body: 'Issues of this type are left with no type. This can’t be undone.',
      confirmLabel: 'Delete type',
      danger: true,
    });
    if (ok)
      await run(
        call(api.DELETE('/issue-types/{id}', { params: { path: { id: t.id }, query: {} } })),
        `Deleted “${t.name}”`,
      );
  }

  let draft = $state({ name: '', color: '#8a8f98' });
  async function add(event: SubmitEvent) {
    event.preventDefault();
    const created = await run(
      call(
        api.POST('/projects/{project}/issue-types', {
          params: { path: { project: projectKey } },
          body: { name: draft.name.trim(), color: draft.color },
        }),
      ),
    );
    if (created) draft = { name: '', color: draft.color };
  }
</script>

<section data-testid="settings-types">
  <h2 class="mb-1 font-medium">Issue types</h2>
  <p class="mb-3 text-sm text-fg-muted">
    The kinds of issue this project tracks, in this order (drag to reorder). An issue can also have
    no type.
  </p>
  {#if types.length}
    <SortableList
      items={types}
      onreorder={reorder}
      label={(t) => `Reorder ${t.name}`}
      class="divide-y divide-border rounded-lg border border-border"
      itemClass="gap-2 bg-bg px-2 py-2 first:rounded-t-lg last:rounded-b-lg"
    >
      {#snippet row(t)}
        <ColorInput
          value={t.color}
          label="Colour of {t.name}"
          onchange={(color) => update(t, { color })}
        />
        <input
          class="{input} min-w-0 flex-1"
          value={t.name}
          aria-label="Type name"
          onchange={(e) => update(t, { name: e.currentTarget.value })}
        />
        <button
          class="rounded p-1.5 text-fg-subtle hover:bg-bg-hover hover:text-danger"
          aria-label="Delete type {t.name}"
          title="Delete type"
          onclick={() => remove(t)}><Trash2 size={14} /></button
        >
      {/snippet}
    </SortableList>
  {/if}
  <form class="mt-3 flex gap-2" onsubmit={add}>
    <ColorInput value={draft.color} label="New type colour" onchange={(c) => (draft.color = c)} />
    <input
      class="{input} flex-1"
      placeholder="New type"
      bind:value={draft.name}
      aria-label="New type name"
    />
    <button class={btn.primary} disabled={!draft.name.trim()}>Add type</button>
  </form>
</section>
