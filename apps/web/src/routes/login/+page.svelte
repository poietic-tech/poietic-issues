<script lang="ts">
  import { btn } from '$lib/styles.ts';
  import { asset } from '$app/paths';
  import { current, href, navigate, safeNext, shareUrl } from '$lib/nav.ts';

  const DEMO = import.meta.env.POIETIC_ISSUES_DEMO;
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { api, call, errorMessage } from '$lib/api.ts';
  import { fetchers, keys } from '$lib/queries.ts';
  import { attemptSso, forgetSsoSession } from '$lib/session.ts';
  import Avatar from '$components/Avatar.svelte';

  const qc = useQueryClient();
  const config = createQuery(() => ({ queryKey: keys.authConfig, queryFn: fetchers.authConfig }));
  let error = $state('');
  let busy = $state(false);

  /** Where to go afterwards, from `?next=`: an app path on this origin only (anything else is `/`). */
  const next = $derived(safeNext(current().params.get('next')));

  async function finish() {
    // Signed-out browsing may have cached what an anonymous visitor sees (empty lists, not-found projects).
    qc.clear();
    await navigate(next);
  }

  async function devLogin(user: string) {
    busy = true;
    try {
      await call(api.POST('/auth/dev-login', { body: { user } }));
      forgetSsoSession();
      await finish();
    } catch (e) {
      error = errorMessage(e);
    } finally {
      busy = false;
    }
  }
  let pending = $state('');
  let ssoTried = false;

  /** Where the SSO issuer should send the browser back to: this page, keeping `next`. */
  function ssoRedirectTarget(): string {
    return shareUrl(`/login?next=${encodeURIComponent(next)}`);
  }

  async function ssoLogin(interactive: boolean) {
    const sso = config.data?.sso;
    if (!sso) return;
    busy = true;
    error = '';
    try {
      const result = await attemptSso(sso);
      if (result.ok) return await finish();
      const { problem, status } = result;
      if (problem?.code === 'PENDING_APPROVAL') {
        pending = problem.detail ?? 'Your account is waiting for approval.';
      } else if (status === 401) {
        if (interactive) {
          const url = new URL(sso.loginUrl);
          url.searchParams.set('redirect', ssoRedirectTarget());
          location.assign(url.href);
        }
      } else if (interactive) {
        error = problem?.detail ?? `Sign-in failed (${status})`;
      }
    } catch (e) {
      // A network failure on the silent attempt just leaves the button for the user to press.
      if (interactive) error = errorMessage(e);
    } finally {
      busy = false;
    }
  }

  // One silent attempt per visit, so someone already signed in to the SSO issuer goes straight in.
  // Not right after signing out, or the issuer's cookie would sign them straight back in.
  $effect(() => {
    if (config.data?.sso && !ssoTried) {
      if (current().params.has('signedout')) {
        ssoTried = true;
        return;
      }
      ssoTried = true;
      void ssoLogin(false);
    }
  });
</script>

<svelte:head><title>Sign in · Issues</title></svelte:head>

<main class="flex min-h-screen items-center justify-center bg-bg-subtle p-6">
  <div class="w-full max-w-sm rounded-xl border border-border bg-bg p-6 shadow-sm">
    <div class="mb-6 flex items-center gap-2">
      <img src={asset('/favicon.svg')} alt="" class="size-7" />
      <h1 class="text-lg font-semibold">Sign in to Issues</h1>
    </div>

    {#if pending}
      <div class="mb-4 rounded-md border border-border bg-bg-subtle p-3" role="status">
        <p class="text-sm font-medium">Waiting for approval</p>
        <p class="mt-1 text-sm text-fg-muted">{pending}</p>
        <p class="mt-2 text-xs text-fg-subtle">
          An admin can approve you with
          <code class="font-mono">poietic-tech issues user edit &lt;handle&gt; --reactivate</code>.
        </p>
      </div>
    {:else if config.data?.sso}
      <button class="{btn.primary} mb-6 w-full" disabled={busy} onclick={() => ssoLogin(true)}
        >Sign in with {config.data.sso.name}</button
      >
    {/if}

    {#if config.data?.devLogin && config.data.users?.length}
      <p class="mb-1 text-sm font-medium">{DEMO ? 'Explore as…' : 'Continue as…'}</p>
      {#if !DEMO}
        <p class="mb-2 text-xs text-fg-subtle">
          This server runs with <code class="font-mono">POIETIC_ISSUES_AUTH_MODE=dev</code>, so
          anyone can pick a user. Use <code class="font-mono">standard</code> in production.
        </p>
      {/if}
      <ul class="mb-6 space-y-1" data-testid="dev-users">
        {#each config.data.users as u (u.id)}
          <li>
            <button
              class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-bg-hover disabled:opacity-50"
              disabled={busy}
              onclick={() => devLogin(u.handle)}
            >
              <Avatar user={u} size={22} />
              <span class="font-medium">{u.name}</span>
              <span class="text-fg-subtle">@{u.handle}</span>
              {#if u.kind === 'agent'}<span
                  class="ml-auto rounded bg-bg-muted px-1.5 text-xs text-fg-muted">agent</span
                >{/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    {#if DEMO}
      <p class="text-xs text-fg-subtle">
        This demo runs entirely in your browser, including the API and its SQLite database. Changes
        stay on this device. To start over, use Reset data at the bottom right.
      </p>
    {:else if config.data && !config.data.sso && !(config.data.devLogin && config.data.users?.length)}
      <p class="text-sm text-fg-muted">This server has no sign-in configured.</p>
    {/if}
    {#if error}<p class="mt-3 text-sm text-danger" role="alert">{error}</p>{/if}
    <!-- Public projects can be read signed out: a visitor who came here by mistake goes back to where they were. -->
    <p class="mt-6 text-center text-sm">
      <a href={href(next)} class="text-fg-muted hover:text-fg hover:underline"
        >Continue without signing in</a
      >
    </p>
  </div>
</main>
