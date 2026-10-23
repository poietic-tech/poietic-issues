<script lang="ts">
  import Select from '$components/Select.svelte';
  import { btn, input } from '$lib/styles.ts';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Copy from '@lucide/svelte/icons/copy';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import RotateCw from '@lucide/svelte/icons/rotate-cw';
  import Send from '@lucide/svelte/icons/send';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import { api, call, errorMessage, type Webhook } from '$lib/api.ts';
  import { relativeTime } from '$lib/format.ts';
  import { fetchers, keys } from '$lib/queries.ts';
  import { toast } from '$lib/toast.svelte.ts';
  import { confirmAction } from '$lib/confirm.svelte.ts';

  /** Admin page: register webhooks, see their delivery log, test, rotate secrets, redeliver. */
  const qc = useQueryClient();
  const hooks = createQuery(() => ({
    queryKey: keys.webhooks,
    queryFn: async () => (await call(api.GET('/webhooks'))).data,
  }));
  const projects = createQuery(() => ({ queryKey: keys.projects, queryFn: fetchers.projects }));

  let draft = $state({ url: '', events: '*', project: '', description: '' });
  /** The secret just created or rotated, shown once. */
  let secret = $state<{ id: string; value: string } | null>(null);
  let expanded = $state<string | null>(null);

  const deliveries = createQuery(() => ({
    queryKey: keys.deliveries(expanded ?? ''),
    enabled: expanded !== null,
    refetchInterval: 5000,
    queryFn: async () =>
      (
        await call(
          api.GET('/webhooks/{id}/deliveries', {
            params: { path: { id: expanded! }, query: { limit: 25 } },
          }),
        )
      ).data,
  }));

  async function run<T>(action: Promise<T>, done?: string): Promise<T | undefined> {
    try {
      const result = await action;
      void qc.invalidateQueries({ queryKey: keys.webhooks });
      if (done) toast(done);
      return result;
    } catch (e) {
      toast(errorMessage(e), 'error');
      return undefined;
    }
  }

  async function create(event: SubmitEvent) {
    event.preventDefault();
    const created = await run(
      call(
        api.POST('/webhooks', {
          body: {
            url: draft.url.trim(),
            eventTypes: draft.events
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
            description: draft.description.trim(),
            ...(draft.project && { project: draft.project }),
          },
        }),
      ),
    );
    if (created) {
      secret = { id: created.id, value: created.secret };
      draft = { url: '', events: '*', project: '', description: '' };
    }
  }

  async function test(hook: Webhook) {
    const result = await run(
      call(api.POST('/webhooks/{id}/test', { params: { path: { id: hook.id } } })),
    );
    if (!result) return;
    if (result.ok) toast(`Ping delivered: HTTP ${result.statusCode} in ${result.durationMs} ms`);
    else toast(`Ping failed: ${result.error ?? `HTTP ${result.statusCode}`}`, 'error');
  }

  async function rotate(hook: Webhook) {
    const rotated = await run(
      call(api.POST('/webhooks/{id}/rotate-secret', { params: { path: { id: hook.id } } })),
    );
    if (rotated) secret = { id: rotated.id, value: rotated.secret };
  }

  function setActive(hook: Webhook, active: boolean) {
    return run(
      call(api.PATCH('/webhooks/{id}', { params: { path: { id: hook.id } }, body: { active } })),
    );
  }

  async function remove(hook: Webhook) {
    const ok = await confirmAction({
      title: 'Delete this webhook?',
      body: `Events stop going to ${hook.url}, and its delivery log is deleted.`,
      confirmLabel: 'Delete webhook',
      danger: true,
    });
    if (!ok) return;
    await run(call(api.DELETE('/webhooks/{id}', { params: { path: { id: hook.id } } })));
    if (expanded === hook.id) expanded = null;
  }

  async function redeliver(id: string) {
    await run(
      call(api.POST('/webhook-deliveries/{id}/redeliver', { params: { path: { id } } })),
      'Queued for redelivery',
    );
    void qc.invalidateQueries({ queryKey: keys.deliveries(expanded ?? '') });
  }

  const projectKey = (id: string | null) =>
    id ? (projects.data?.find((p) => p.id === id)?.key ?? id) : 'All projects';
  const STATUS_CLASS: Record<string, string> = {
    succeeded: 'text-success',
    failed: 'text-warning',
    dead: 'text-danger',
    pending: 'text-fg-subtle',
  };
</script>

<svelte:head><title>Webhooks · Issues</title></svelte:head>

<div class="overflow-y-auto">
  <div class="mx-auto max-w-4xl space-y-6 px-6 py-6">
    <header>
      <h1 class="text-lg font-semibold">Webhooks</h1>
      <p class="mt-1 text-sm text-fg-muted">
        Issues POSTs each matching event as JSON, signed per
        <a class="underline" href="https://www.standardwebhooks.com" target="_blank" rel="noopener"
          >Standard Webhooks</a
        >. Failed deliveries are retried after 1m, 5m, 30m, 2h and 12h. A webhook is disabled after
        5 deliveries in a row give up.
      </p>
    </header>

    {#if secret}
      <div
        class="rounded-lg border border-accent bg-bg-subtle p-3 text-sm"
        data-testid="webhook-secret"
      >
        <p class="mb-2 font-medium">Signing secret — copy it now, it won’t be shown again.</p>
        <div class="flex items-center gap-2">
          <code class="flex-1 truncate rounded bg-bg px-2 py-1 font-mono text-xs"
            >{secret.value}</code
          >
          <button
            class="inline-flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-bg-hover"
            onclick={() => void navigator.clipboard?.writeText(secret!.value)}
            ><Copy size={12} /> Copy</button
          >
          <button
            class="rounded px-2 py-1 text-xs hover:bg-bg-hover"
            onclick={() => (secret = null)}>Done</button
          >
        </div>
      </div>
    {/if}

    <form
      class="grid grid-cols-1 gap-2 rounded-lg border border-border p-3 sm:grid-cols-[2fr_1fr_1fr]"
      onsubmit={create}
      data-testid="new-webhook"
    >
      <input
        class={input}
        type="url"
        required
        placeholder="https://example.com/hooks/tracker"
        aria-label="Webhook URL"
        bind:value={draft.url}
      />
      <input
        class={input}
        placeholder="Events: *, issue.*, comment.created"
        aria-label="Event types"
        bind:value={draft.events}
      />
      <Select
        label="Project"
        value={draft.project}
        items={[
          { value: '', label: 'All projects' },
          ...(projects.data ?? []).map((p) => ({ value: p.key, label: p.name, hint: p.key })),
        ]}
        onchange={(v) => (draft.project = v)}
      />
      <input
        class="{input} sm:col-span-2"
        placeholder="Description (optional)"
        aria-label="Description"
        bind:value={draft.description}
      />
      <button class={btn.primary} disabled={!draft.url.trim()}>Add webhook</button>
    </form>

    <ul class="space-y-2">
      {#each hooks.data ?? [] as hook (hook.id)}
        <li class="rounded-lg border border-border" data-testid="webhook" data-url={hook.url}>
          <div class="flex items-center gap-2 px-3 py-2">
            <button
              class="rounded p-0.5 text-fg-subtle hover:bg-bg-hover"
              aria-label="Show deliveries"
              aria-expanded={expanded === hook.id}
              onclick={() => (expanded = expanded === hook.id ? null : hook.id)}
              ><ChevronRight
                size={14}
                class="transition-transform {expanded === hook.id ? 'rotate-90' : ''}"
              /></button
            >
            <span
              class="size-2 shrink-0 rounded-full {hook.active ? 'bg-success' : 'bg-border-strong'}"
              title={hook.active
                ? 'Active'
                : hook.disabledAt
                  ? 'Disabled after failures'
                  : 'Inactive'}
            ></span>
            <div class="min-w-0 flex-1">
              <p class="truncate font-mono text-xs">{hook.url}</p>
              <p class="truncate text-xs text-fg-subtle">
                {hook.eventTypes.join(', ')} · {projectKey(hook.projectId)}
                {#if hook.description}· {hook.description}{/if}
                {#if hook.disabledAt}<span class="text-danger">
                    · disabled {relativeTime(hook.disabledAt)} after repeated failures</span
                  >{/if}
              </p>
            </div>
            <button
              class="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-fg-muted hover:bg-bg-hover"
              onclick={() => test(hook)}
              data-testid="webhook-test"><Send size={12} /> Test</button
            >
            <button
              class="rounded px-2 py-1 text-xs text-fg-muted hover:bg-bg-hover"
              onclick={() => setActive(hook, !hook.active)}
              >{hook.active ? 'Disable' : 'Enable'}</button
            >
            <button
              class="rounded p-1 text-fg-subtle hover:bg-bg-hover hover:text-fg"
              aria-label="Rotate secret"
              title="Rotate secret"
              onclick={() => rotate(hook)}><KeyRound size={13} /></button
            >
            <button
              class="rounded p-1 text-fg-subtle hover:bg-bg-hover hover:text-danger"
              aria-label="Delete webhook"
              onclick={() => remove(hook)}><Trash2 size={13} /></button
            >
          </div>
          {#if expanded === hook.id}
            <div class="border-t border-border px-3 py-2" data-testid="deliveries">
              {#if (deliveries.data ?? []).length === 0}
                <p class="py-2 text-xs text-fg-subtle">
                  No deliveries yet. Events that happen from now on will show up here.
                </p>
              {:else}
                <table class="w-full text-xs">
                  <thead class="text-left text-fg-subtle">
                    <tr>
                      <th class="py-1 font-normal">Event</th>
                      <th class="font-normal">Status</th>
                      <th class="font-normal">HTTP</th>
                      <th class="font-normal">Attempts</th>
                      <th class="font-normal">When</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each deliveries.data ?? [] as d (d.id)}
                      <tr
                        class="border-t border-border"
                        data-testid="delivery"
                        data-status={d.status}
                      >
                        <td class="py-1 font-mono">{d.eventType ?? '—'} #{d.eventSeq}</td>
                        <td class={STATUS_CLASS[d.status]}>
                          {d.status}{#if d.status === 'failed'}
                            · retry {relativeTime(d.nextAttemptAt)}{/if}
                        </td>
                        <td title={d.lastError ?? d.lastResponse ?? ''}
                          >{d.lastStatusCode ?? (d.lastError ? 'error' : '—')}</td
                        >
                        <td>{d.attempts}</td>
                        <td>{relativeTime(d.lastAttemptAt ?? d.createdAt)}</td>
                        <td class="text-right">
                          {#if d.status !== 'pending'}
                            <button
                              class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-bg-hover"
                              onclick={() => redeliver(d.id)}
                              ><RotateCw size={11} /> Redeliver</button
                            >
                          {/if}
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              {/if}
            </div>
          {/if}
        </li>
      {:else}
        <li class="rounded-lg border border-dashed border-border px-3 py-3 text-sm text-fg-subtle">
          No webhooks yet. Or register one from a terminal with
          <code class="font-mono text-xs"
            >poietic-tech issues webhook create URL --events 'issue.*'</code
          >.
        </li>
      {/each}
    </ul>
  </div>
</div>
