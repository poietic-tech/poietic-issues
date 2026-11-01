# AGENTS.md

This file is for AI coding agents (and humans) working **on this repository**. For how agents should _use_ the tracker through its CLI, see [docs/agents.md](docs/agents.md).

## Commands

```sh
pnpm install          # install (pnpm 10; native deps are allowlisted in pnpm-workspace.yaml)
pnpm check            # typecheck + lint + format:check + test — must pass before every commit
pnpm test             # Vitest, all projects (packages, server, CLI, web, deploy), SQLite
pnpm test:pg          # same suites against Postgres (run `pnpm pg start` first)
pnpm format           # apply Prettier
pnpm pg start|stop|reset|status|url   # throwaway local Postgres (local binaries, else Docker)
pnpm e2e              # build the web app, run Playwright (E2E_DATABASE_URL=postgres://… for Postgres)
pnpm build            # web app + dist/server.mjs + dist/poietic-issues-admin.mjs (tsdown bundles)
pnpm --filter @poietic-tech/issues build:module   # the published module bundle: apps/cli/dist/poietic-tech.js (tested by apps/cli/test/bundle.test.ts)
pnpm build:demo       # self-contained browser demo in apps/web/build-demo/ (pnpm e2e:demo tests it)
pnpm --filter @poietic-tech/issues-github-sync build   # the GitHub ↔ tracker sync bundle; deploy/k3s/deploy.sh ships it to K3s
docker compose up -d --build --wait poietic-issues   # production shape: Postgres + S3 storage
pnpm openapi:gen      # regenerate docs/openapi.json + client types after API changes
pnpm vitest run --project cli -u      # refresh CLI golden files + docs/cli-reference.md after CLI changes
pnpm issues-admin …   # run the operator tool (local mode, trusted) from source; remote use is `poietic-tech issues …`
```

Run a single package's tests with `pnpm vitest run --project <name>`, for example `--project db`.

## Architecture rules

- **Business logic lives in `packages/core`.** It does not live in HTTP route handlers, the CLI or the web app. The server, the operator tool's local mode and future integrations all call the same services.
- **`packages/schema` is isomorphic.** It must not import Node-only modules, Hono or database code, because the web app bundles it.
- **Internal links go through `$lib/nav.ts`** (`href`, `navigate`, `current`) in the web app, so they work with both the path router and the demo's hash router.
- **Portable SQL only.** All code must work on both SQLite and Postgres:
  - Use the column-type helpers and row mappers in `packages/db`.
  - Write through `withWriteTx`.
  - Dialect-specific SQL goes behind a helper that branches on the dialect, and needs a test in both dialects.
- **Timestamps come from the injected clock** (`clock.now().toISOString()`), never from database defaults.
- **The API contract is committed.** Changing a route or schema changes `docs/openapi.json`; regenerate it and commit it with the change.
- **Decisions get ADRs.** Anything that constrains future work (a new dependency, pattern or convention) gets a short ADR in `docs/adr/`.

## Conventions

- TypeScript strict, ESM only. Relative imports use explicit `.ts` extensions.
- Internal packages export `src/*.ts` directly. There is no build step inside the monorepo.
- Tests sit next to the code as `*.test.ts`. The web app has its own Vitest project (`apps/web`, `src/**/*.test.ts`) for plain modules under `src/lib`, such as `safe-next.ts`; `pnpm test` and `pnpm check` run it. Components are covered by `pnpm e2e`. Tests that touch the database must pass under both `TEST_DB=sqlite` and `TEST_DB=postgres`.
- Ids are TypeID-style with fixed prefixes (`packages/schema/src/ids.ts`). Never change an existing prefix.
- Keep commits scoped to one concern, and make sure `pnpm check` passes before each one.
