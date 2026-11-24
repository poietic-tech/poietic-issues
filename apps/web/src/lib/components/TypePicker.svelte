<script lang="ts">
  import { useQueryClient } from '@tanstack/svelte-query';
  import type { Issue, IssueType } from '../api.ts';
  import { editIssue } from '../issues.ts';
  import Picker from './Picker.svelte';
  import TypeBadge from './TypeBadge.svelte';

  /** Picks an issue's type from its project's list, or none. Read-only, it is plain text. */
  let {
    issue,
    types,
    readonly = false,
  }: { issue: Issue; types: IssueType[]; readonly?: boolean } = $props();
  const qc = useQueryClient();
  const NONE = '__none__';
  const items = $derived([
    { value: NONE, label: 'No type', color: 'transparent' },
    ...types.map((t) => ({ value: t.id, label: t.name, color: t.color })),
  ]);

  function select(value: string) {
    const type = types.find((t) => t.id === value) ?? null;
    if ((type?.id ?? null) === issue.typeId) return;
    void editIssue(
      qc,
      issue,
      { type: type?.id ?? null },
      {
        typeId: type?.id ?? null,
        type: type ? { id: type.id, name: type.name, color: type.color } : null,
      },
    );
  }
</script>

{#if readonly}
  {#if issue.type}
    <span class="px-1.5"><TypeBadge name={issue.type.name} color={issue.type.color} /></span>
  {:else}
    <span class="px-1.5 text-fg-subtle">No type</span>
  {/if}
{:else}
  <Picker
    {items}
    selected={[issue.typeId ?? NONE]}
    onselect={select}
    triggerLabel="Change type"
    testid="type-picker"
  >
    {#snippet trigger()}
      {#if issue.type}
        <TypeBadge name={issue.type.name} color={issue.type.color} />
      {:else}
        <span class="truncate text-fg-subtle">Set type</span>
      {/if}
    {/snippet}
    {#snippet item(it)}
      <TypeBadge name={it.label} color={it.color} />
    {/snippet}
  </Picker>
{/if}
