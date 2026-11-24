<script lang="ts">
  import { btn, input } from '$lib/styles.ts';
  import { href, navigate, signInPath } from '$lib/nav.ts';
  import Lock from '@lucide/svelte/icons/lock';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import EmptyState from '$components/EmptyState.svelte';
  import { page } from '$app/state';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import { api, call, errorMessage, type Label, type Status } from '$lib/api.ts';
  import { useProjectData } from '$lib/project-data.svelte.ts';
  import { fetchers, isSignedIn, keys } from '$lib/queries.ts';
  import { toast } from '$lib/toast.svelte.ts';
  import { confirmAction } from '$lib/confirm.svelte.ts';
  import CustomFieldsSettings from '$components/CustomFieldsSettings.svelte';
  import IssueTypesSettings from '$components/IssueTypesSettings.svelte';
  import ProjectAccessSettings from '$components/ProjectAccessSettings.svelte';
  import ProjectGeneralSettings from '$components/ProjectGeneralSettings.svelte';
  import ProjectReposSettings from '$components/ProjectReposSettings.svelte';
  import ColorInput from '$components/ColorInput.svelte';
  import Select from '$components/Select.svelte';
  import SortableList from '$components/SortableList.svelte';
  import StatusIcon from '$components/StatusIcon.svelte';
  import { AlertDialog } from 'bits-ui';

  const key = $derived(page.params.key!.toUpperCase());
  const project = useProjectData(() => key);
  const qc = useQueryClient();
  const me = createQuery(() => ({ queryKey: keys.me, queryFn: fetchers.me, staleTime: 300_000 }));
  /**
   * Editors change the workflow, issue types, labels and custom fields; managers also change access, repos and the project's
   * details. Signed-in viewers see the members read-only; signed-out visitors get a dead end.
   */
  const readerOnly = $derived(
    project.access !== undefined && !project.canWrite && me.isSuccess && isSignedIn(me.data),
  );
  const CATEGORY_ITEMS = [
    { value: 'backlog', label: 'Backlog', hint: 'not planned yet' },
    { value: 'unstarted', label: 'Unstarted', hint: 'planned' },
    { value: 'started', label: 'Started', hint: 'in progress' },
    { value: 'completed', label: 'Completed', hint: 'done' },
    { value: 'canceled', label: 'Canceled', hint: 'won’t do' },
  ];

  async function run<T>(
    action: Promise<T>,
    refresh: ReadonlyArray<readonly unknown[]>,
    saved?: string,
  ): Promise<T | undefined> {
    try {
      const result = await action;
      for (const k of refresh) void qc.invalidateQueries({ queryKey: k });
      if (saved) toast(saved, 'success');
      return result;
    } catch (e) {
      toast(errorMessage(e), 'error');
      return undefined;
    }
  }
  const statusKeys = $derived([keys.statuses(key), keys.issueLists(key)]);
  const labelKeys = $derived([keys.labels(key), keys.issueLists(key)]);

  let newStatus = $state({ name: '', category: 'unstarted' as Status['category'] });
  let newLabel = $state({ name: '', color: '#5e6ad2' });

  function updateStatus(
    s: Status,
    body: { name?: string; category?: Status['category']; color?: string },
  ) {
    return run(
      call(api.PATCH('/statuses/{id}', { params: { path: { id: s.id } }, body })),
      statusKeys,
      `Saved “${body.name ?? s.name}”`,
    );
  }
  function reorderStatuses(ids: string[]) {
    return run(
      call(
        api.POST('/projects/{project}/statuses/reorder', {
          params: { path: { project: key } },
          body: { ids },
        }),
      ),
      statusKeys,
      'Workflow order saved',
    );
  }

  /** Status being deleted, and where its issues go. */
  let deleting = $state<Status | null>(null);
  let moveTo = $state('');
  function askRemoveStatus(s: Status) {
    moveTo = project.statuses.find((x) => x.id !== s.id)?.id ?? '';
    deleting = s;
  }
  async function removeStatus() {
    const s = deleting;
    if (!s) return;
    deleting = null;
    await run(
      call(
        api.DELETE('/statuses/{id}', {
          params: { path: { id: s.id }, query: moveTo ? { moveIssuesTo: moveTo } : {} },
        }),
      ),
      statusKeys,
      `Deleted “${s.name}”`,
    );
  }
  async function addStatus(event: SubmitEvent) {
    event.preventDefault();
    const created = await run(
      call(
        api.POST('/projects/{project}/statuses', {
          params: { path: { project: key } },
          body: newStatus,
        }),
      ),
      statusKeys,
    );
    if (created) newStatus = { name: '', category: newStatus.category };
  }
  function updateLabel(l: Label, body: { name?: string; color?: string; description?: string }) {
    return run(
      call(api.PATCH('/labels/{id}', { params: { path: { id: l.id } }, body })),
      labelKeys,
      `Saved “${body.name ?? l.name}”`,
    );
  }
  async function removeLabel(l: Label) {
    const ok = await confirmAction({
      title: `Delete the label “${l.name}”?`,
      body: 'It is removed from every issue that has it. This can’t be undone.',
      confirmLabel: 'Delete label',
      danger: true,
    });
    if (ok)
      await run(call(api.DELETE('/labels/{id}', { params: { path: { id: l.id } } })), labelKeys);
  }
  async function addLabel(event: SubmitEvent) {
    event.preventDefault();
    const created = await run(
      call(
        api.POST('/projects/{project}/labels', {
          params: { path: { project: key } },
          body: newLabel,
        }),
      ),
      labelKeys,
    );
    if (created) newLabel = { name: '', color: newLabel.color };
  }
</script>

<svelte:head><title>{key} · Settings</title></svelte:head>

{#if project.notFound || (project.access !== undefined && !project.canWrite && me.isSuccess && !readerOnly)}
  <!-- The settings link is shown to editors and managers only; this covers typed or shared URLs of signed-out visitors. -->
  <EmptyState
    icon={Lock}
    title={project.notFound ? `Project ${key} not found` : 'Sign in to see this project’s settings'}
    testid="settings-forbidden"
  >
    {project.notFound
      ? 'It may not exist, or it may be private to its members.'
      : 'Project settings are for members. Signed in, you can see who can work in this project.'}
    {#snippet actions()}
      {#if !project.notFound}
        <button class={btn.primary} onclick={() => navigate(signInPath())}>Sign in</button>
        <a href={href(`/p/${key}`)} class={btn.secondary}>Back to {key} issues</a>
      {/if}
    {/snippet}
  </EmptyState>
{:else if project.error}
  <EmptyState
    icon={TriangleAlert}
    tone="danger"
    title="Couldn’t load {key} settings"
    testid="project-error"
  >
    {project.error.message}
    {#snippet actions()}
      <button class={btn.secondary} onclick={() => project.retry()}>Try again</button>
    {/snippet}
  </EmptyState>
{:else if readerOnly}
  <div class="overflow-y-auto">
    <div class="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6 sm:py-8">
      <h1 class="text-lg font-semibold">Project settings</h1>
      <p class="text-sm text-fg-muted" data-testid="settings-readonly">
        Only project editors and managers can change these settings.
      </p>
      <ProjectAccessSettings projectKey={key} readonly />
    </div>
  </div>
{:else if project.canWrite}
  <div class="overflow-y-auto">
    <div class="mx-auto max-w-3xl space-y-10 px-4 py-6 sm:px-6 sm:py-8">
      <h1 class="text-lg font-semibold">Project settings</h1>

      {#if project.canManage}
        <ProjectAccessSettings projectKey={key} />

        <ProjectReposSettings projectKey={key} />

        <ProjectGeneralSettings projectKey={key} />
      {:else}
        <p class="text-sm text-fg-muted" data-testid="settings-editor-note">
          You can change the workflow, issue types, labels and custom fields. Only project managers
          can change access, repositories and the project's details.
        </p>
        <ProjectAccessSettings projectKey={key} readonly />
      {/if}

      <section data-testid="settings-statuses">
        <h2 class="mb-1 font-medium">Workflow</h2>
        <p class="mb-3 text-sm text-fg-muted">
          Statuses are the board columns, in this order (drag to reorder). The category drives
          started/completed dates and default views.
        </p>
        <SortableList
          items={project.statuses}
          onreorder={reorderStatuses}
          label={(s) => `Reorder ${s.name}`}
          class="divide-y divide-border rounded-lg border border-border"
          itemClass="gap-2 bg-bg px-2 py-2 first:rounded-t-lg last:rounded-b-lg"
        >
          {#snippet row(s)}
            <ColorInput
              value={s.color}
              label="Colour of {s.name}"
              onchange={(color) => updateStatus(s, { color })}
            />
            <StatusIcon category={s.category} color={s.color} />
            <input
              class="{input} min-w-0 flex-1"
              value={s.name}
              aria-label="Status name"
              onchange={(e) => updateStatus(s, { name: e.currentTarget.value })}
            />
            <Select
              class="w-32"
              label="Category of {s.name}"
              value={s.category}
              items={CATEGORY_ITEMS}
              onchange={(v) => updateStatus(s, { category: v as Status['category'] })}
            />
            <button
              class="rounded p-1.5 text-fg-subtle hover:bg-bg-hover hover:text-danger disabled:opacity-30"
              aria-label="Delete status {s.name}"
              title="Delete status"
              disabled={project.statuses.length <= 1}
              onclick={() => askRemoveStatus(s)}><Trash2 size={14} /></button
            >
          {/snippet}
        </SortableList>
        <form class="mt-3 flex gap-2" onsubmit={addStatus}>
          <input
            class="{input} flex-1"
            placeholder="New status"
            bind:value={newStatus.name}
            aria-label="New status name"
          />
          <Select
            class="w-32"
            label="New status category"
            value={newStatus.category}
            items={CATEGORY_ITEMS}
            onchange={(v) => (newStatus.category = v as Status['category'])}
          />
          <button class={btn.primary} disabled={!newStatus.name.trim()}>Add status</button>
        </form>
      </section>

      <IssueTypesSettings projectKey={key} types={project.issueTypes} />

      <section data-testid="settings-labels">
        <h2 class="mb-3 font-medium">Labels</h2>
        <ul class="divide-y divide-border rounded-lg border border-border">
          {#each project.labels as l (l.id)}
            <li class="flex items-center gap-2 px-3 py-2" data-label={l.name}>
              <ColorInput
                value={l.color}
                label="Colour of {l.name}"
                onchange={(color) => updateLabel(l, { color })}
              />
              <input
                class="{input} w-40"
                value={l.name}
                aria-label="Label name"
                onchange={(e) => updateLabel(l, { name: e.currentTarget.value })}
              />
              <input
                class="{input} flex-1"
                value={l.description}
                placeholder="Description"
                aria-label="Description"
                onchange={(e) => updateLabel(l, { description: e.currentTarget.value })}
              />
              <button
                class="rounded p-1 text-fg-subtle hover:bg-bg-hover hover:text-danger"
                aria-label="Delete label"
                onclick={() => removeLabel(l)}><Trash2 size={14} /></button
              >
            </li>
          {:else}
            <li class="px-3 py-3 text-sm text-fg-subtle">No labels yet.</li>
          {/each}
        </ul>
        <form class="mt-3 flex gap-2" onsubmit={addLabel}>
          <ColorInput
            value={newLabel.color}
            label="New label colour"
            onchange={(color) => (newLabel.color = color)}
          />
          <input
            class="{input} flex-1"
            placeholder="New label"
            bind:value={newLabel.name}
            aria-label="New label name"
          />
          <button class={btn.primary} disabled={!newLabel.name.trim()}>Add label</button>
        </form>
      </section>

      <CustomFieldsSettings projectKey={key} />
    </div>
  </div>
{/if}

<AlertDialog.Root open={!!deleting} onOpenChange={(open) => !open && (deleting = null)}>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="fixed inset-0 z-50 bg-black/30" />
    <AlertDialog.Content
      class="fixed top-[20vh] left-1/2 z-50 w-[min(420px,92vw)] -translate-x-1/2 rounded-xl border border-border bg-bg p-5 shadow-2xl"
      data-testid="delete-status-dialog"
    >
      {#if deleting}
        <AlertDialog.Title class="text-base font-semibold"
          >Delete the status “{deleting.name}”?</AlertDialog.Title
        >
        <AlertDialog.Description class="mt-1.5 text-sm text-fg-muted">
          Issues in it move to another status first.
        </AlertDialog.Description>
        <div class="mt-4 flex items-center gap-3 text-sm">
          <span class="text-fg-muted">Move issues to</span>
          <Select
            class="flex-1"
            label="Move issues to"
            value={moveTo}
            items={project.statuses
              .filter((x) => x.id !== deleting?.id)
              .map((x) => ({ value: x.id, label: x.name }))}
            onchange={(v) => (moveTo = v)}
          />
        </div>
        <div class="mt-5 flex justify-end gap-2">
          <AlertDialog.Cancel class={btn.secondary}>Cancel</AlertDialog.Cancel>
          <AlertDialog.Action class={btn.danger} onclick={removeStatus} data-testid="confirm-ok"
            >Delete status</AlertDialog.Action
          >
        </div>
      {/if}
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>
