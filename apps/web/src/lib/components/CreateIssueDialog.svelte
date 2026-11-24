<script lang="ts">
  import { btn } from '../styles.ts';
  import { navigate } from '$lib/nav.ts';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { Dialog } from 'bits-ui';
  import GitBranch from '@lucide/svelte/icons/git-branch';
  import X from '@lucide/svelte/icons/x';
  import { PRIORITY_LABELS, PRIORITY_ORDER } from '../format.ts';
  import { createIssue } from '../issues.ts';
  import { useProjectData } from '../project-data.svelte.ts';
  import { toast } from '../toast.svelte.ts';
  import { ui } from '../ui.svelte.ts';
  import Avatar from './Avatar.svelte';
  import LabelChip from './LabelChip.svelte';
  import MarkdownEditor from './MarkdownEditor.svelte';
  import Picker from './Picker.svelte';
  import PriorityIcon from './PriorityIcon.svelte';
  import StatusIcon from './StatusIcon.svelte';
  import TypeBadge from './TypeBadge.svelte';

  const qc = useQueryClient();
  const project = useProjectData(() => ui.createIssue.project);

  let title = $state('');
  let description = $state('');
  let statusId = $state<string | undefined>(undefined);
  let typeId = $state<string | null>(null);
  let priority = $state(0);
  let assigneeId = $state<string | null>(null);
  let repo = $state<string | null>(null);
  let labelIds = $state<string[]>([]);
  let createMore = $state(false);
  let busy = $state(false);
  let titleInput = $state<HTMLInputElement>();

  const status = $derived(
    project.statuses.find((s) => s.id === statusId) ??
      project.statuses.find(
        (s) => s.name === ui.createIssue.status || s.id === ui.createIssue.status,
      ) ??
      project.statuses.find((s) => s.category === 'unstarted') ??
      project.statuses[0],
  );
  const assignee = $derived(project.users.find((u) => u.id === assigneeId) ?? null);
  const issueType = $derived(project.issueTypes.find((t) => t.id === typeId) ?? null);

  $effect(() => {
    titleInput?.focus();
  });

  function close() {
    ui.createIssue.open = false;
  }

  async function submit(event?: Event) {
    event?.preventDefault();
    if (!title.trim() || busy) return;
    busy = true;
    const issue = await createIssue(qc, ui.createIssue.project, {
      title: title.trim(),
      description,
      ...(status && { status: status.id }),
      ...(issueType && { type: issueType.id }),
      priority,
      assignee: assigneeId,
      labels: labelIds,
      ...(repo && { repo }),
      ...(ui.createIssue.parent && { parent: ui.createIssue.parent }),
    });
    busy = false;
    if (!issue) return;
    toast(`Created ${issue.key}`, 'success', {
      label: 'Open',
      run: () => void navigate(`/i/${issue.key}`),
    });
    if (createMore) {
      title = '';
      description = '';
      titleInput?.focus();
    } else close();
  }
</script>

<Dialog.Root open={ui.createIssue.open} onOpenChange={(open) => !open && close()}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-40 bg-black/30" />
    <Dialog.Content
      class="fixed top-[12vh] left-1/2 z-50 w-[min(640px,92vw)] -translate-x-1/2 rounded-xl border border-border bg-bg shadow-2xl"
      data-testid="create-issue-dialog"
    >
      <form onsubmit={submit}>
        <div class="flex items-center gap-2 px-4 pt-3 text-xs text-fg-subtle">
          <span class="rounded bg-bg-muted px-1.5 py-0.5 font-mono">{ui.createIssue.project}</span>
          <span>›</span>
          <Dialog.Title class="font-medium text-fg-muted">
            {ui.createIssue.parent ? `New sub-issue of ${ui.createIssue.parent}` : 'New issue'}
          </Dialog.Title>
          <Dialog.Close class="ml-auto rounded p-1 hover:bg-bg-hover" aria-label="Close"
            ><X size={15} /></Dialog.Close
          >
        </div>
        <div class="px-4 pt-2">
          <input
            bind:this={titleInput}
            bind:value={title}
            placeholder="Issue title"
            aria-label="Title"
            data-testid="create-title"
            class="w-full bg-transparent py-1 text-lg font-medium outline-none placeholder:text-fg-subtle"
          />
          <div class="mt-2">
            <MarkdownEditor
              bind:value={description}
              rows={5}
              placeholder="Add a description… (markdown)"
              onsubmit={submit}
            />
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-1 px-3 py-2 text-sm">
          <Picker
            items={project.statuses.map((s) => ({ value: s.id, label: s.name, s }))}
            selected={status ? [status.id] : []}
            onselect={(v) => (statusId = v)}
            triggerLabel="Status"
            triggerClass="border border-border"
          >
            {#snippet trigger()}
              {#if status}<StatusIcon category={status.category} color={status.color} /><span
                  >{status.name}</span
                >{/if}
            {/snippet}
            {#snippet item(it)}<StatusIcon category={it.s.category} color={it.s.color} /><span
                >{it.label}</span
              >{/snippet}
          </Picker>
          {#if project.issueTypes.length}
            <Picker
              items={[
                { value: '', label: 'No type', color: 'transparent' },
                ...project.issueTypes.map((t) => ({ value: t.id, label: t.name, color: t.color })),
              ]}
              selected={[typeId ?? '']}
              onselect={(v) => (typeId = v || null)}
              triggerLabel="Type"
              triggerClass="border border-border"
              testid="create-type"
            >
              {#snippet trigger()}
                {#if issueType}<TypeBadge
                    name={issueType.name}
                    color={issueType.color}
                  />{:else}<span class="text-fg-muted">Type</span>{/if}
              {/snippet}
              {#snippet item(it)}<TypeBadge name={it.label} color={it.color} />{/snippet}
            </Picker>
          {/if}
          <Picker
            items={PRIORITY_ORDER.map((p) => ({ value: String(p), label: PRIORITY_LABELS[p], p }))}
            selected={[String(priority)]}
            onselect={(v) => (priority = Number(v))}
            triggerLabel="Priority"
            triggerClass="border border-border"
          >
            {#snippet trigger()}<PriorityIcon {priority} /><span>{PRIORITY_LABELS[priority]}</span
              >{/snippet}
            {#snippet item(it)}<PriorityIcon priority={it.p} /><span>{it.label}</span>{/snippet}
          </Picker>
          <Picker
            items={[
              { value: '', label: 'No assignee', u: null },
              ...project.users.map((u) => ({
                value: u.id,
                label: u.name,
                keywords: [u.handle],
                u,
              })),
            ]}
            selected={[assigneeId ?? '']}
            onselect={(v) => (assigneeId = v || null)}
            triggerLabel="Assignee"
            triggerClass="border border-border"
          >
            {#snippet trigger()}<Avatar user={assignee} size={16} /><span
                >{assignee?.name ?? 'Assignee'}</span
              >{/snippet}
            {#snippet item(it)}<Avatar user={it.u} size={16} /><span>{it.label}</span>{/snippet}
          </Picker>
          {#if project.repos.length}
            <Picker
              items={[
                { value: '', label: 'No repository' },
                ...project.repos.map((r) => ({ value: r.fullName, label: r.fullName })),
              ]}
              selected={[repo ?? '']}
              onselect={(v) => (repo = v || null)}
              triggerLabel="Repository"
              triggerClass="border border-border"
            >
              {#snippet trigger()}<GitBranch size={14} /><span class={repo ? '' : 'text-fg-muted'}
                  >{repo ?? 'Repository'}</span
                >{/snippet}
            </Picker>
          {/if}
          <Picker
            items={project.labels.map((l) => ({ value: l.id, label: l.name, l }))}
            selected={labelIds}
            multiple
            onselect={(v) =>
              (labelIds = labelIds.includes(v)
                ? labelIds.filter((x) => x !== v)
                : [...labelIds, v])}
            triggerLabel="Labels"
            triggerClass="border border-border"
          >
            {#snippet trigger()}
              {#if labelIds.length}
                {#each project.labels.filter((l) => labelIds.includes(l.id)) as l (l.id)}<LabelChip
                    label={l}
                  />{/each}
              {:else}<span class="text-fg-muted">Labels</span>{/if}
            {/snippet}
            {#snippet item(it)}<span class="size-2.5 rounded-full" style:background={it.l.color}
              ></span><span>{it.label}</span>{/snippet}
          </Picker>
        </div>
        <div class="flex items-center gap-3 border-t border-border px-4 py-2.5">
          <label class="flex items-center gap-1.5 text-xs text-fg-muted">
            <input type="checkbox" bind:checked={createMore} /> Create more
          </label>
          <button
            type="submit"
            disabled={!title.trim() || busy}
            data-testid="create-submit"
            class="{btn.primary} ml-auto">Create issue</button
          >
        </div>
      </form>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
