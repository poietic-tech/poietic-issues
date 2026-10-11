import type { QueryClient } from '@tanstack/svelte-query';
import type { Schemas } from '@poietic-tech/issues-client';
import { api } from './api.ts';
import { navigate } from './nav.ts';

export type SsoConfig = NonNullable<Schemas['AuthConfig']['sso']>;

/** The outcome of an SSO sign-in attempt: signed in, or the server's problem response. */
export type SsoResult =
  | { ok: true }
  | { ok: false; status: number; problem: { code?: string; detail?: string } | undefined };

/**
 * Signs in with the SSO issuer's cookie: renews a lapsed cookie first (its tokens are short-lived; a failure just
 * means "not signed in"), then asks the server. Uses the raw client, not `call()`, so a 401 is an answer here
 * rather than a trigger for the global sign-in redirect. Network errors reject.
 */
export async function attemptSso(sso: SsoConfig): Promise<SsoResult> {
  if (sso.refreshUrl)
    await fetch(sso.refreshUrl, { credentials: 'include' }).catch(() => undefined);
  const { error, response } = await api.POST('/auth/sso');
  if (response.ok) {
    lastSsoSignIn = Date.now();
    remember(SSO_SESSION_KEY, true);
    return { ok: true };
  }
  return {
    ok: false,
    status: response.status,
    problem: error as { code?: string; detail?: string } | undefined,
  };
}

/** When this page last got a session from `POST /auth/sso` (0: not yet). */
let lastSsoSignIn = 0;
const SSO_SESSION_KEY = 'poietic-issues.sso-session';

function remember(key: string, on: boolean) {
  try {
    if (on) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    // storage unavailable: nothing to remember
  }
}

/**
 * Whether the current session came from SSO sign-in, so renewing it through `POST /auth/sso` keeps the same person
 * signed in. A session from a token or dev login is never renewed that way: the browser's SSO cookie could be
 * someone else's.
 */
export function ssoSessionHeld(): boolean {
  try {
    return localStorage.getItem(SSO_SESSION_KEY) !== null;
  } catch {
    return false;
  }
}

/** Records that the current session did not come from SSO (a token or dev login, or a sign-out). */
export function forgetSsoSession(): void {
  remember(SSO_SESSION_KEY, false);
}

/**
 * Keeps a short SSO session (ADR 0025) alive while the app is open: renews it through `attemptSso` once half its
 * lifetime has passed, checking every minute and whenever the tab becomes visible, regains focus or comes back
 * online. Each renewal re-checks the issuer, so a session ended there ends here within one lifetime. `lapsed` runs
 * when a renewal succeeds after the old session had already expired (cached data may have been fetched
 * anonymously); `ended` when the server refuses the renewal (401/403), after which renewals stop. A network error
 * or a 503 is retried at the next check; the session lapses meanwhile (fail closed). Returns a function that stops it.
 */
export function keepSsoSession(
  sso: SsoConfig,
  on: { lapsed: () => void; ended: () => void },
): () => void {
  const lifetime = sso.sessionSeconds * 1000;
  const due = lifetime / 2;
  let stopped = false;
  async function renew() {
    const since = Date.now() - lastSsoSignIn;
    if (stopped || since < due) return;
    renewing ??= attemptSso(sso).finally(() => (renewing = undefined));
    let result: SsoResult;
    try {
      result = await renewing;
    } catch {
      return;
    }
    if (stopped) return;
    if (result.ok) {
      if (lastSsoSignIn && since >= lifetime) on.lapsed();
    } else if (result.status === 401 || result.status === 403) {
      stopped = true;
      forgetSsoSession();
      on.ended();
    }
  }
  const check = () => {
    if (document.visibilityState === 'visible') void renew();
  };
  void renew();
  const timer = setInterval(check, Math.min(due, 60_000));
  document.addEventListener('visibilitychange', check);
  window.addEventListener('focus', check);
  window.addEventListener('online', check);
  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', check);
    window.removeEventListener('focus', check);
    window.removeEventListener('online', check);
  };
}
/** One renewal at a time, shared by every caller. */
let renewing: Promise<SsoResult> | undefined;

const SILENT_SSO_KEY = 'poietic-issues.silent-sso';
/** Fallback when sessionStorage is unavailable: once per page load instead of once per browser session. */
let silentSsoDone = false;

/**
 * Whether this browser session should still try a silent SSO sign-in. It is tried once per session, and never
 * after signing out (the issuer's cookie would sign the visitor straight back in).
 */
export function silentSsoAllowed(): boolean {
  if (silentSsoDone) return false;
  try {
    return sessionStorage.getItem(SILENT_SSO_KEY) === null;
  } catch {
    return true;
  }
}

/** Records that the silent SSO attempt was made (or must not be made) for this browser session. */
export function markSilentSsoDone(): void {
  silentSsoDone = true;
  try {
    sessionStorage.setItem(SILENT_SSO_KEY, '1');
  } catch {
    // remembered for this page load only
  }
}

/** Signs out, forgets everything cached for this user, and lands on the sign-in page. */
export async function signOut(qc: QueryClient): Promise<void> {
  markSilentSsoDone();
  forgetSsoSession();
  await api.POST('/auth/logout');
  qc.clear();
  await navigate('/login?signedout=1');
}
