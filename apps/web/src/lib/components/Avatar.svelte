<script lang="ts">
  import Bot from '@lucide/svelte/icons/bot';
  import CircleDashed from '@lucide/svelte/icons/circle-dashed';
  import { formatActor } from '@poietic-tech/issues-schema';

  let {
    user,
    size = 18,
  }: {
    user: {
      name: string;
      handle: string;
      kind: string;
      avatarUrl?: string | null;
      owner?: { handle: string } | null;
    } | null;
    size?: number;
  } = $props();

  const palette = [
    '#5e6ad2',
    '#26b5ce',
    '#4cb782',
    '#f2994a',
    '#eb5757',
    '#bb87fc',
    '#e5a50a',
    '#0f9d8a',
  ];
  const color = $derived(
    user
      ? palette[
          [...user.handle].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % palette.length
        ]
      : '',
  );
  /** `Opal bot (@opal-bot) · agent · owned by @opal`. */
  const title = $derived(
    user ? formatActor({ ...user, name: `${user.name} (@${user.handle})` }) : 'Unassigned',
  );
  const initials = $derived(
    user
      ? user.name
          .split(/\s+/)
          .map((p) => p[0])
          .join('')
          .slice(0, 2)
          .toUpperCase()
      : '',
  );
</script>

{#if !user}
  <span class="inline-flex shrink-0 text-fg-subtle" title="Unassigned"><CircleDashed {size} /></span
  >
{:else if user.avatarUrl}
  <img
    src={user.avatarUrl}
    alt={user.name}
    {title}
    class="shrink-0 rounded-full object-cover"
    style:width="{size}px"
    style:height="{size}px"
  />
{:else}
  <span
    class="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
    style:width="{size}px"
    style:height="{size}px"
    style:background={color}
    style:font-size="{Math.round(size * 0.45)}px"
    {title}
  >
    {#if user.kind === 'agent'}<Bot size={Math.round(size * 0.65)} />{:else}{initials}{/if}
  </span>
{/if}
