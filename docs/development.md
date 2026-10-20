# Development

To set up and run the project, start with the [Quickstart](../README.md#quickstart) in the README. This page covers how the pieces work.

## Toolchain

- **Node 22.12+** (see `.nvmrc`) and **pnpm 10** (`corepack enable` picks up the version pinned in `package.json`). Use the `.nvmrc` major (`nvm use`): on newer majors `better-sqlite3` may have no prebuilt binary and falls back to compiling with node-gyp.
- **TypeScript is pinned to 6.0.x.** TypeScript 7 exists, but SvelteKit and typescript-eslint don't support it yet.
- pnpm 10 blocks dependency install scripts by default. Native modules that need a build step (`better-sqlite3`, `esbuild`) are allowlisted in `pnpm-workspace.yaml` under `onlyBuiltDependencies`.

## Quality gates

`pnpm check` runs, in order:

1. `pnpm typecheck`: `tsc` per package
2. `pnpm lint`: ESLint flat config, zero warnings allowed
3. `pnpm format:check`: Prettier
4. `pnpm test`: Vitest across all workspace projects

CI (`.github/workflows/ci.yml`) runs the same gates and runs the tests twice, with `TEST_DB=sqlite` and with `TEST_DB=postgres` (a `postgres:16` service container).

To run everything CI runs, locally:

```sh
pnpm check                                                   # gates + tests on SQLite
pnpm pg start && pnpm test:pg                                # tests on Postgres
pnpm --filter @poietic-tech/issues-web exec playwright install chromium  # once, for the browser tests
pnpm e2e                                                     # Playwright against the real server (SQLite)
E2E_DATABASE_URL=$(pnpm --silent pg url) pnpm e2e                  # ...and on Postgres
pnpm e2e:demo                                                # the static browser demo
pnpm pg stop
```

CI also runs the S3 attachment tests on its Postgres leg (set the `TEST_S3_*` variables from `ci.yml` to run them locally), plus the Docker Compose smoke test.

## Databases

Development uses SQLite; production uses Postgres. The `POIETIC_ISSUES_DATABASE_URL` scheme selects the dialect (see `.env.example`).

### Local Postgres

`scripts/pg.sh` (also available as `pnpm pg …`) manages a throwaway cluster, using local server binaries when installed and a Docker container otherwise (for example on macOS):

```sh
pnpm pg start    # initdb on first run, start, create database `tracker`, print the URL
pnpm pg status
pnpm pg reset    # wipe and recreate
pnpm pg stop
```

Details:

- Data lives in `/var/tmp/tracker-pg` and the cluster listens on `127.0.0.1:54329`. Override these with `POIETIC_ISSUES_PG_DIR` and `POIETIC_ISSUES_PG_PORT`.
- Auth is `trust` for the `tracker` user, and `fsync` is off. It's fast and **not durable**; it's for tests only.
- When run as root, the script uses `runuser -u postgres`, because `initdb` refuses to run as root.
- It finds the server binaries on `PATH` or under `/usr/lib/postgresql/*/bin`.
- Without them, it runs a `postgres:16` container named `tracker-pg` with the same user, database, port and settings. Its data lives in the container, and `reset` recreates it. Set `POIETIC_ISSUES_PG_BACKEND=native` or `docker` to choose explicitly.

To run the suites against it (the URL is also the default for `TEST_DATABASE_URL`):

```sh
pnpm test:pg
```

## Web app

`apps/web` is a SvelteKit single-page app (Svelte 5 runes, Tailwind 4, bits-ui, TanStack Query).

- **Development.** `pnpm dev` runs the API (`:3000`) and Vite (`127.0.0.1:5943`, or the next free port). Vite proxies `/api` to the API, so the browser sees one origin and the session cookie works. Set `POIETIC_ISSUES_API_URL` to point Vite at another server.
  - `pnpm dev` loads a repo-root `.env` if there is one.
  - It resolves a relative SQLite path and the blob directory against the repo root, so the server and the operator tool (`pnpm issues-admin`) share `data/dev.db` and `data/blobs`.
- **Production.** `pnpm build:web` writes `apps/web/build/`. The API server serves it when `POIETIC_ISSUES_WEB_DIR` points there, with an SPA fallback for deep links.
- **Data layer.**
  - The web app only talks to the API through `@poietic-tech/issues-client`.
  - `src/lib/queries.ts` holds the query keys and fetchers.
  - `src/lib/issues.ts` holds mutations with optimistic cache updates and rollback.
  - A view's configuration (filters, sort, columns, card fields) lives in `?v=` while unsaved, so any view state can be shared by URL.
- **Checks.** `pnpm typecheck` runs `svelte-check --fail-on-warnings` for the web package.
- **End-to-end tests** (`apps/web/e2e`):
  - They run the built app against the real server on a fresh seeded SQLite database (`pnpm e2e`). Set `E2E_DATABASE_URL` to run against Postgres.
  - They use the preinstalled Chromium at `/opt/pw-browsers/chromium` when present, and otherwise Playwright's own. Install that once with `pnpm --filter @poietic-tech/issues-web exec playwright install chromium`. Override the browser with `PLAYWRIGHT_CHROMIUM_PATH`.

## Browser demo

`pnpm build:demo` builds a self-contained demo into `apps/web/build-demo/`: the web app, the real API server code and SQLite (sql.js, compiled to JavaScript) all run in the page. Any static host can serve it, including a claude.ai artifact, and no server is involved.

How it differs from the normal build ([ADR 0015](adr/0015-browser-demo.md)):

- **Routing.** It uses SvelteKit's hash router (`index.html#/p/ENG`), because a static host may serve the page from any path. Internal links therefore go through `$lib/nav.ts` everywhere.
- **Startup.** `src/hooks.client.ts` boots `src/demo/` before the app starts.
- **Requests.** The demo layer answers `fetch` and `EventSource` calls to `/api` with `createApp(…)`. Each signed-in user gets the app's trusted mode, because pages can't set cookies on in-page requests.
- **Node-only modules.** `node:crypto`, `better-sqlite3`, `pg`, `pino` and the rest are aliased to small browser stand-ins in `src/demo/shims/` (see `vite.config.ts`).
- **Storage.** Data is saved to the viewer's `localStorage` after writes and when the page is hidden. The badge's **Reset data** button starts over.
- **What's missing.** Webhooks are delivered to a pretend receiver that always answers 200. Attachments live in memory and in the saved snapshot.

`pnpm e2e:demo` builds it and runs `apps/web/e2e-demo/` against the static files served from a sub-path.
