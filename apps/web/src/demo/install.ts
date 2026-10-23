// Boots the in-browser backend and points the web app at it (demo build only). The app itself is unchanged:
// its `fetch` and `EventSource` calls to /api reach the real server code running in this page.
import { type DemoBackend, startDemoBackend } from './backend.ts';

const USER_KEY = 'poietic-issues-demo-user';

function storedUser(): string | null {
  try {
    return localStorage.getItem(USER_KEY);
  } catch {
    return null;
  }
}
function storeUser(handle: string | null) {
  try {
    if (handle) localStorage.setItem(USER_KEY, handle);
    else localStorage.removeItem(USER_KEY);
  } catch {
    // signed-in user just won't survive a reload
  }
}

export async function installDemo(): Promise<void> {
  const backend = await startDemoBackend();
  let user = storedUser();
  const nativeFetch = window.fetch.bind(window);

  const isApi = (url: URL) => url.origin === location.origin && url.pathname.startsWith('/api/');

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/v1/, '');
    if (request.method === 'POST' && path === '/auth/dev-login') {
      const { user: ref } = (await request.json()) as { user: string };
      const me = await backend.fetch(new Request(new URL('/api/v1/me', url)), ref);
      if (me.ok) {
        user = ((await me.clone().json()) as { handle: string }).handle;
        storeUser(user);
      }
      return me;
    }
    if (request.method === 'POST' && path === '/auth/logout') {
      user = null;
      storeUser(null);
      return new Response(null, { status: 204 });
    }
    return backend.fetch(request, user);
  }

  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    return isApi(new URL(request.url)) ? handle(request) : nativeFetch(input, init);
  };

  installEventSource(handle);
  installAssetLoader(handle);
  installBadge(backend);
}

/** EventSource for /api streams: reads the backend's Server-Sent Events response and reconnects like a browser. */
function installEventSource(handle: (r: Request) => Promise<Response>) {
  const Native = window.EventSource;
  class DemoEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly url: string;
    readonly withCredentials = false;
    readyState = 0;
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    #abort = new AbortController();
    #lastId = '';
    #retry = 1000;

    constructor(url: string | URL) {
      super();
      this.url = new URL(url, location.href).href;
      void this.#connect();
    }

    async #connect() {
      if (this.readyState === 2) return;
      try {
        const headers = this.#lastId ? { 'last-event-id': this.#lastId } : undefined;
        const res = await handle(new Request(this.url, { headers, signal: this.#abort.signal }));
        if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
        this.readyState = 1;
        this.#emit(new Event('open'));
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            this.#dispatch(buffer.slice(0, end));
            buffer = buffer.slice(end + 2);
          }
        }
      } catch {
        // fall through to reconnect
      }
      if (this.readyState === 2) return;
      this.readyState = 0;
      this.#emit(new Event('error'));
      setTimeout(() => void this.#connect(), this.#retry);
    }

    #dispatch(block: string) {
      let type = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') type = value;
        else if (field === 'data') data.push(value);
        else if (field === 'id') this.#lastId = value;
        else if (field === 'retry' && /^\d+$/.test(value)) this.#retry = Number(value);
      }
      if (!data.length) return;
      this.#emit(new MessageEvent(type, { data: data.join('\n'), lastEventId: this.#lastId }));
    }

    #emit(event: Event) {
      this.dispatchEvent(event);
      const handler = (this as unknown as Record<string, ((e: Event) => void) | null>)[
        `on${event.type}`
      ];
      if (event.type === 'open' || event.type === 'message' || event.type === 'error')
        handler?.call(this, event);
    }

    close() {
      this.readyState = 2;
      this.#abort.abort();
    }
  }
  window.EventSource = function (url: string | URL, init?: EventSourceInit) {
    const target = new URL(url, location.href);
    return target.origin === location.origin && target.pathname.startsWith('/api/')
      ? new DemoEventSource(target)
      : new Native(url, init);
  } as unknown as typeof EventSource;
}

/** Images and links that point at /api (attachments) are loaded through the backend as blob: URLs. */
function installAssetLoader(handle: (r: Request) => Promise<Response>) {
  const cache = new Map<string, Promise<string>>();
  const blobUrl = (path: string) => {
    let url = cache.get(path);
    if (!url) {
      url = handle(new Request(new URL(path, location.origin))).then(async (res) =>
        URL.createObjectURL(await res.blob()),
      );
      cache.set(path, url);
    }
    return url;
  };
  const rewrite = (el: Element) => {
    for (const [selector, attr] of [
      ['img[src^="/api/"]', 'src'],
      ['a[href^="/api/"]', 'href'],
    ] as const) {
      const nodes = el.matches(selector) ? [el] : [...el.querySelectorAll(selector)];
      for (const node of nodes) {
        const path = node.getAttribute(attr)!;
        node.setAttribute(attr, '');
        void blobUrl(path).then((url) => node.setAttribute(attr, url));
      }
    }
  };
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes' && m.target instanceof Element) rewrite(m.target);
      for (const node of m.addedNodes) if (node instanceof Element) rewrite(node);
    }
  }).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['src', 'href'],
  });
}

/** A small badge that says where the data lives, with a way to start over. */
function installBadge(backend: DemoBackend) {
  const badge = document.createElement('div');
  badge.setAttribute('data-testid', 'demo-badge');
  badge.style.cssText =
    'position:fixed;right:12px;bottom:calc(12px + env(safe-area-inset-bottom, 0px));z-index:60;display:flex;gap:8px;align-items:center;' +
    'padding:6px 8px 6px 12px;border-radius:999px;font:12px/1.2 system-ui,sans-serif;' +
    'background:var(--color-bg, #fff);color:var(--color-fg-muted, #555);border:1px solid var(--color-border, #ddd);' +
    'box-shadow:0 2px 8px rgb(0 0 0 / 0.08)';
  const text = document.createElement('span');
  text.textContent = 'Demo · runs in your browser';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = 'Reset data';
  reset.style.cssText =
    'border:1px solid var(--color-border, #ddd);border-radius:999px;padding:2px 8px;background:transparent;color:inherit;cursor:pointer;font:inherit';
  reset.addEventListener('click', () => {
    backend.reset();
    storeUser(null);
    location.hash = '';
    location.reload();
  });
  badge.append(text, reset);
  const attach = () => document.body.append(badge);
  if (document.body) attach();
  else addEventListener('DOMContentLoaded', attach);
}
