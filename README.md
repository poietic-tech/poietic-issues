# poietic-issues

A custom issue tracker built for teams where **humans and AI agents work side by side**.

- **An extensible domain model.** Projects, issues, comments, typed links, sub-issues, labels, custom fields, attachments and saved views sit on top of an append-only event log.
- **A typesafe, documented API.** Zod schemas are the single source of truth, and the committed OpenAPI 3.1 contract is generated from them.
- **An agent-grade CLI (`poietic-issues`).** It has stable JSON output, documented exit codes and never prompts, and it can describe its own commands (`poietic-issues commands --json`).
- **A Svelte web UI** with a list view, a kanban board with customizable cards, and live updates over SSE.
- **Integrations and storage:** signed webhooks, and file attachments on local disk or any S3-compatible store.
- **SQLite for development, Postgres for production**, from one codebase. Every test suite runs against both. Production is a single Docker image.

## Quickstart

You need **Node 22** (the version in `.nvmrc`; with nvm, run `nvm install && nvm use`) and **pnpm 10** (`corepack enable`). Newer Node majors may have no prebuilt `better-sqlite3` binary, and the install then fails unless it can compile one.

```sh
pnpm install
pnpm dev
```

- The web UI is at http://127.0.0.1:5943. Vite moves to the next free port if 5943 is taken and prints the URL it chose.
- The API is on `:3000`, with its reference at http://127.0.0.1:3000/api/docs.
- On first start the database (`data/dev.db`) is created, migrated and seeded with demo users (`ada` is an admin, `grace` and `margaret` are members, `claude` is an agent), a public `ENG` project with a linked repo and a private `OPS` project.
- Dev auth mode lets you sign in as any demo user with one click.
- To start over, stop the server and delete `data/`.
- Settings come from the environment, or from a `.env` file at the repo root (copy `.env.example`), which `pnpm dev` loads.

To develop against Postgres instead (it uses local binaries if you have them, or else Docker):

```sh
pnpm pg start
POIETIC_ISSUES_DATABASE_URL=$(pnpm --silent pg url) pnpm dev
```

## Use the CLI

Local mode needs no server. It runs the API in-process on the same `data/dev.db` that `pnpm dev` uses:

```sh
pnpm poietic-issues db migrate && pnpm poietic-issues db seed      # not needed if `pnpm dev` has already run
pnpm poietic-issues issue list -P ENG
pnpm poietic-issues commands --json                         # the full command surface, for agents
```

The CLI can also talk to a running server; see [cli.md](docs/cli.md).

## Other ways to run it

This runs the **production-shaped stack** (Postgres, S3-compatible storage and the tracker image built from this checkout) on http://localhost:3000:

```sh
docker compose up -d --build --wait poietic-issues
docker compose exec poietic-issues poietic-issues db bootstrap --handle you --name "Your Name"
```

Production auth has no demo users: people sign in through SSO (see [deployment.md](docs/deployment.md)). Stop the stack with `docker compose down`, or add `-v` to delete its data too. [deployment.md](docs/deployment.md) covers configuration and hardening.

The **browser demo** runs the web app, the API and SQLite all in the page, so any static host can serve it:

```sh
pnpm build:demo      # writes apps/web/build-demo/
```

## Contributing

```sh
pnpm check           # typecheck + lint + format check + tests on SQLite; must pass before every commit
```

CI also runs the tests on Postgres, the Playwright end-to-end suite on both databases, and a Docker smoke test. [development.md](docs/development.md) shows how to run all of it locally. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and [AGENTS.md](AGENTS.md) for the architecture rules and conventions, which apply to humans and coding agents alike. Report security issues as described in [SECURITY.md](SECURITY.md), not in public issues.

## Documentation

| Topic                          | Guide                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How the pieces fit             | [architecture.md](docs/architecture.md), [data-model.md](docs/data-model.md), [decision records](docs/adr/)                                                         |
| HTTP API                       | [api.md](docs/api.md), with the full contract in [openapi.json](docs/openapi.json) (browsable at `/api/docs`)                                                       |
| CLI                            | [cli.md](docs/cli.md), [cli-reference.md](docs/cli-reference.md)                                                                                                    |
| Agents                         | [agents.md](docs/agents.md)                                                                                                                                         |
| Events, live updates, webhooks | [events.md](docs/events.md)                                                                                                                                         |
| Running it                     | [deployment.md](docs/deployment.md), [security.md](docs/security.md), [releases.md](docs/releases.md)                                                               |
| Working on it                  | [CONTRIBUTING.md](CONTRIBUTING.md), [development.md](docs/development.md), [testing.md](docs/testing.md), [extending.md](docs/extending.md), [AGENTS.md](AGENTS.md) |

## Repository layout

| Path              | Purpose                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/schema` | Isomorphic Zod schemas and types shared by server, CLI and web                                                         |
| `packages/db`     | Kysely database layer: dialect factory (SQLite/Postgres), migrations, write transactions                               |
| `packages/core`   | Transport-agnostic domain services; all business rules live here                                                       |
| `packages/client` | Typed API client generated from the OpenAPI document                                                                   |
| `apps/server`     | Hono HTTP API (`/api/v1`), SSE, OpenAPI docs; serves the web app in production                                         |
| `apps/cli`        | The `poietic-issues` CLI (`@poietic-tech/issues`), which talks to a server or runs in-process against a local database |
| `apps/web`        | SvelteKit single-page app (served by the API server in production)                                                     |
| `docs/`           | Architecture, API/CLI guides, and [architecture decision records](docs/adr/)                                           |

## License

[MIT](LICENSE)
