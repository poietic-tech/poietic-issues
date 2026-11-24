<script lang="ts">
  /** An issue type: a colored dot and its name. */
  let {
    name,
    color,
    showLabel = true,
  }: { name: string; color: string; showLabel?: boolean } = $props();
</script>

<span class="inline-flex min-w-0 items-center gap-1.5" title={showLabel ? undefined : name}>
  <span class="size-2 shrink-0 rounded-full" style:background-color={color} aria-hidden="true"
  ></span>
  {#if showLabel}<span class="truncate">{name}</span>{/if}
</span>
