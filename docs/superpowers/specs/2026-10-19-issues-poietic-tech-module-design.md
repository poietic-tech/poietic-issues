# poietic-issues joins poietic-tech: one login, one command

- **Date:** 2026-10-19
- **Status:** Approved in conversation; written for the plan

## Why

poietic.tech is becoming one toolkit. The `poietic-tech` command (`@poietic-tech/cli`, published from
poietic-dot-tech) is the host. People sign in once with `poietic-tech login`. Agents act as themselves through
`POIETIC_IDENTITY`, or through `POIETIC_AGENT_TOKEN` in harnesses and CI. Tools join as modules that the host
finds automatically.

poietic-issues still has its own command (`poietic-issues`), its own credential (`trk_` API tokens), its own
config file and its own output and exit-code conventions. The CLI is unpublished, so nobody outside the repo can
install it.

The owner's direction:

- Remove the `trk_` concept entirely and put everything behind SSO.
- Publish the CLI.
- Align it with the `poietic-tech` style.
- Release it with a workflow.

issues.poietic.tech is the only deployment that matters. A self-hosted deployment without auth.poietic.tech is
no longer a goal.

## Goals

1. `npm i -g @poietic-tech/cli @poietic-tech/issues` gives `poietic-tech issues …`, signed in with the shared
   login. There is nothing to configure: the host discovers the module from the global prefix.
2. The issues commands follow the host's conventions:
   - **Formats:** `--json`, `--format table|json|ndjson|ids`, `-q`, and `POIETIC_TECH_FORMAT`.
   - **Exit codes:** the host's table.
   - **Errors:** the host's error rendering.
   - **Prompts:** never.
   - **Identity:** the host's login and identity rules.
3. `trk_` tokens are gone from the server, database, web app, CLI, docs and tests. The only way to call the
   API from outside the server process is an auth.poietic.tech identity, as a human or an agent.
4. A tag `issues-v<semver>` publishes `@poietic-tech/issues` to npm through trusted publishing.

## Non-goals

- Self-hosted or non-SSO deployments. Trusted mode and dev-login remain only for development, tests and the
  operator tool. They are never for remote callers in production.
- Changing the `poietic-tech` host or its module contract. The host lives in another repo; any wish for the host
  is a follow-up there.
- Removing the agent-token environment variables from the owner's harness settings. That comes after this ships.
- Merging the old hand-made `claude` and `ci` users into their new SSO agents. Their history stays as it is.
- Migrating other repositories' workflows. A code search found no consumer of `POIETIC_ISSUES_TOKEN` outside
  this repo.

## Anti-goals (failure even if it works)

- A second credential path that is "temporary" and survives, such as `trk_` kept for CI.
- A bare `poietic-issues` command on anyone's PATH after `npm i -g`.
- The module importing its own copy of `commander` at run time and handing those objects to the host's
  `commander`. Version skew between the two would break parsing in ways the tests cannot see.
- An identity token sent anywhere other than https://*.poietic.tech.

## What changes

### 1. Server, core, database: retire `trk_`

- **Migration `0007_drop_api_tokens`** drops `api_tokens`. It must be portable across SQLite and Postgres, written
  with the existing helpers. Existing tokens stop working when the deploy runs migrations.
- **Core** removes `createToken`, `authenticateToken`, list and revoke. It also removes the token half of
  `bootstrapAdmin`: bootstrap still creates the first admin user, for local and dev use, but mints nothing.
  `seedDemoData` no longer returns tokens.
- **Routes** remove `POST /users/{user}/tokens`, `GET /users/{user}/tokens`, `DELETE /tokens/{id}` and
  `POST /auth/token-login`.
- **Auth middleware.** A bearer value is always an identity token: it is verified when SSO is configured, and is
  a 401 otherwise. Nothing falls back to the cookie. Cookie sessions (`/auth/sso`, and `/auth/dev-login` in dev)
  and trusted mode are unchanged.
- **OpenAPI.** The `trk_` security scheme and its descriptions go. `docs/openapi.json` and the generated client
  are regenerated (`pnpm openapi:gen`) and committed.
- **Web.** The login page loses the paste-a-token form and the "run `poietic-issues token create`" hint, and
  shows SSO, plus dev login in dev. Any wording that tells people to run `poietic-issues user edit …` points at
  `poietic-tech issues user edit …`. The demo backend drops its `/auth/token-login` handler.
- **ADR 0028** records the decision: `trk_` is retired, the CLI is a `poietic-tech` module, and local mode
  remains only in the operator tool. ADR 0023's sentence keeping `trk_` for non-SSO deployments and CI is marked
  superseded by 0028. Do not rewrite it.

### 2. The CLI splits in two, sharing one command tree

The command definitions (issue, comment, link, attachment, project, status, label, field, view, event, webhook,
user, schema, api, commands, init, whoami) are written once, against a small runtime interface:

- the typed API client;
- an output sink;
- the project resolver;
- a way to fail with a code.

Two hosts use the tree.

**a) The published module: `@poietic-tech/issues` (`apps/cli`), remote only.**

- **package.json:**
  - Not private. Version `0.1.0`. `"files": ["dist", "README.md", "LICENSE"]`.
  - `"engines": {"node": ">=22.12"}`, the repo's floor. The bundle targets node22 and the release smoke runs on `.nvmrc`. _(Builder's call: the host allows Node 20, but nothing in this repo is tested on 20.)_
  - `"peerDependencies": {"@poietic-tech/cli": "^0.1.1"}`.
  - The manifest:
    `"poietic-tech": {"command": "issues", "entry": "./dist/poietic-tech.js", "api": 1, "summary": "Issue tracker at issues.poietic.tech"}`.
  - **No `bin`.**
  - Workspace packages and pure-JS libraries (`zod`, `openapi-fetch`) are bundled into the entry, so they are
    build-time dependencies only. The published `dependencies` contain no `workspace:` or `file:` specifier.
- **Entry.** (The host README's example imports `defineModule` at run time. This design deliberately does not.)
  `dist/poietic-tech.js` is built by tsdown and default-exports `{ api: 1, setup }`, typed with a
  type-only import from `@poietic-tech/cli/module`.
  - _Builder's call:_ importing `defineModule` at run time would load a second copy of the host package beside
    the one already running.
- **No commander at run time.**
  - Every command, subcommand and option is created from the host's objects: `ctx.program.command(...)`,
    `cmd.createCommand(...)`, `cmd.createOption(...)`, `cmd.addOption(...)`.
  - The built bundle must contain no commander code and no `import … "commander"`. A test checks the built file.
  - `commander` moves from a runtime dependency at `^15` to a dev dependency at `^14`, matching the host's
    `^14.0.3`, for types and tests. Code that relies on v15-only behaviour is adjusted.
- **Server.**
  - `https://issues.poietic.tech` unless `POIETIC_ISSUES_SERVER` or `.poietic-issues.json` `server` says
    otherwise.
  - The URL must be https on a `*.poietic.tech` host, because that is where `caller.fetch` may send an identity
    token. Anything else is `bad_usage` with a message that says so.
  - A project config containing a token is still refused.
- **Transport.**
  - `createClient({ baseUrl, fetch })`, whose `fetch` is the existing `retryingFetch` around
    `(await ctx.caller()).fetch`. Idempotency keys and network retries are unchanged.
  - The caller is resolved on first API use, so `issues --help`, `issues commands` and `issues schema` (if it is
    offline) never read the credential file.
- **Options on the `issues` command itself,** inherited by its subcommands:
  - `-P, --project <key>` (also `POIETIC_ISSUES_PROJECT`, then `.poietic-issues.json`).
  - `--fields <list>`.
  - The old `--server`, `--token`, `--database`, `--actor`, `--format`, `--json` and `-q` are not module options:
    the host owns the formats, and the module has no local mode.
- **Output** goes only through `ctx.output`:
  - Lists use `ctx.output.list(rows, { columns, id })`, with the existing per-kind columns and identifier.
  - Single objects use `ctx.output.item(obj, columns)`.
  - Webhook signing secrets use `ctx.output.secret(...)`.
  - Notices use `ctx.output.message`/`warn`.
  - `--fields` narrows table columns, and projects the objects for json and ndjson.
  - **Raw commands write to stdout directly** (`process.stdout`, behind the runtime's sink so tests can capture
    it), and print the same bytes whatever the format:
    - `event tail` (NDJSON, one line per event);
    - `attachment download -o -` (bytes);
    - `schema` (JSON Schema);
    - `api` (the response body);
    - `commands` (its JSON reference, which keeps its existing shape and golden file);
    - `fields describe` (text).

    `ModuleOutput` has no raw or streaming channel, and the module cannot see the chosen format. _(Builder's call.
    A `ctx.output.raw` in the host is a follow-up.)_

  - JSON shapes follow the host (`{"data": [...]}` for lists). This changes the CLI's old JSON shape, and is
    accepted because the CLI was never published.
  - **Known limitation:** the host's table rendering puts each value on one line, so `issues issue view` shows an
    inlined description. A text block in table format needs the host contract to grow. That is a follow-up in
    poietic-dot-tech and does not block this work.
- **Errors** go through `ctx.fail(code, message, { status })`, mapped by meaning onto the host's table:

  | Issues code                                                                            | Host code                           | Exit |
  | -------------------------------------------------------------------------------------- | ----------------------------------- | ---- |
  | `VALIDATION_FAILED`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `INVALID_RELATION` | `bad_request`                       | 2    |
  | `UNAUTHENTICATED`                                                                      | `not_logged_in`                     | 3    |
  | `NOT_FOUND`                                                                            | `not_found`                         | 4    |
  | `FORBIDDEN`, `PENDING_APPROVAL`                                                        | `not_allowed`                       | 5    |
  | `CONFLICT`, `VERSION_MISMATCH`, `IDEMPOTENCY_IN_PROGRESS`, `IDEMPOTENCY_KEY_REUSED`    | its own lowercased code, status 409 | 2    |
  | `UNAVAILABLE`, any other 429 or 5xx                                                    | `server_error`                      | 8    |
  | `INTERNAL`                                                                             | `internal`                          | 1    |
  | Network failure                                                                        | `network`                           | 8    |
  | Module usage errors (no project, bad server)                                           | `bad_usage`                         | 2    |
  - The conflict row keeps a distinct machine code (`conflict`, `version_mismatch`, …), so agents can still tell
    a conflict from a usage error. _Builder's call:_ the host has no conflict row, and adding one is a host
    change.
  - Field-level errors are appended to the message, one `path: message` per line.
  - Every row has a test, using codes the server actually sends. `RATE_LIMITED` exists in the schema, but no
    code emits it, so it falls under "any other 429".

- **Dropped from the module:**
  - `token`, `auth` and `db` (the module has no database). `serve` moves to the operator tool.
  - The user config file `~/.config/poietic-issues/config.json`: it is ignored, and the docs say to delete it.
  - `POIETIC_ISSUES_TOKEN` and `POIETIC_ISSUES_FORMAT`.
  - `issues whoami` stays and shows the tracker account (handle, role, kind, owner, project access), because the
    host's `whoami` shows only the auth identity.
- **`issues commands --json`** stays as the machine-readable reference for agents, generated from the tree.
  - The golden file and `docs/cli-reference.md` are regenerated, with every command spelled
    `poietic-tech issues …`.
- **The README for npm** covers:
  - install (`npm i -g @poietic-tech/cli @poietic-tech/issues`);
  - `poietic-tech login`;
  - project setup (`poietic-tech issues init --project KEY`);
  - acting as an agent (`POIETIC_IDENTITY`, or `POIETIC_AGENT_TOKEN` in CI);
  - a pointer to the exit-code table (`poietic-tech help exit-codes`).

**b) The operator tool: `poietic-issues-admin`. Local mode only, never published.**

- It is the same tree over the in-process app in trusted mode, plus `db migrate|status|bootstrap|seed` and
  `serve`, with the existing `--database` and `--actor` flags and its existing `Output`.
- It runs as `pnpm issues-admin …` in the repo and as `poietic-issues-admin` in the Docker image, built by
  tsdown as `dist/poietic-issues-admin.mjs`.
- It replaces every current local-mode use: dev scripts, the docker-compose comment, CI's container smoke test,
  `deploy/cloudflare/test/restore.sh`, and server messages that say "run `poietic-issues db migrate`".
- The image no longer installs a `poietic-issues` binary.

### 3. CI and the release workflow

- **The container smoke test** in `ci.yml` no longer mints a token. It brings up the container, waits for
  `/readyz`, then runs `poietic-issues-admin` inside the container against its database: create a project, create
  an issue, read it back.
  - `restore.sh` writes with `poietic-issues-admin` inside `tr-a`, which uses SQLite WAL beside the running server,
    so Litestream replicates the write. It reads back with `poietic-issues-admin` inside the restored `tr-b`. The
    restore check stays a byte-level check on the restored database through the services. HTTP auth is not part of
    it.
  - The point of these tests is the container, storage and restore, not HTTP auth, which the server's tests
    cover.
- **New workflow `.github/workflows/release-issues.yml`.** It runs on tags `issues-v*`. The `publish` job has
  `environment: npm` and `permissions: id-token: write, contents: read`. It copies the shape of poietic-dot-tech's
  `cli.yml`:
  1. checkout, pnpm, then node with `registry-url: https://registry.npmjs.org`;
  2. `pnpm install --frozen-lockfile`;
  3. typecheck, then the CLI test project;
  4. **guards:**
     - the tag is on main (`git merge-base --is-ancestor`);
     - the tag equals `issues-v` plus the package version;
     - the published package.json has no `workspace:` or `file:` in `dependencies` or `peerDependencies`;
  5. build the module bundle, then check that it has no commander code;
  6. **smoke:**
     - `npm pack`;
     - install `@poietic-tech/cli` and the tarball into a temp prefix with a temp HOME;
     - `poietic-tech issues --help` exits 0;
     - `poietic-tech modules list --json` shows `@poietic-tech/issues` with command `issues`, available (the host
       reports `"loaded on demand"`, `packages/cli/src/discovery.ts`);
  7. `npm publish --access public` from `apps/cli`, with provenance through OIDC and no npm token.
  - Pin third-party actions the way `ci.yml` does.
- `docs/releases.md` describes cutting a release: bump the version, merge, tag, and watch the run.

### 4. Docs

- `docs/agents.md` is rewritten. Agents run `poietic-tech issues …`.
  - A human's session acts as an agent with `POIETIC_IDENTITY=<agent>`.
  - Harnesses and CI use `POIETIC_AGENT_TOKEN`.
  - `github-ci` becomes an auth.poietic.tech agent, made with `poietic-tech agents create`. Its token goes in an
    org secret named `POIETIC_AGENT_TOKEN`, replacing `POIETIC_ISSUES_TOKEN`.
- `docs/cli.md`, `docs/api.md`, `docs/security.md`, `docs/data-model.md`, `docs/deployment.md`, `README.md` and
  `AGENTS.md` are updated so that no `trk_`, `poietic-issues token` or `POIETIC_ISSUES_TOKEN` remains, except in
  ADRs and history.
- `git grep -n 'trk_'` outside `docs/adr/` and `docs/superpowers/` returns nothing.

## Owner steps (outside this PR; listed in the PR body)

1. Claim the npm name with a manual placeholder publish of `@poietic-tech/issues@0.0.1-stage`, with 2FA and
   `--tag stage`. A version that has been used once can never be published again.
2. On npmjs.com, add a trusted publisher: `poietic-tech` / `poietic-issues` / `release-issues.yml` / environment
   `npm`.
3. In the GitHub repo poietic-tech/poietic-issues, create the environment `npm` with the tag rule `issues-v*`.
4. Create the `github-ci` agent, set the org secret `POIETIC_AGENT_TOKEN`, and delete `POIETIC_ISSUES_TOKEN`.
5. Delete `~/.config/poietic-issues/config.json`. Install the module, and use `poietic-tech login` with
   `POIETIC_IDENTITY=Claude` for local Claude sessions.

## Constraints

- These must pass: `pnpm check` (typecheck, lint, format, tests), both `TEST_DB=sqlite` and `TEST_DB=postgres`
  for anything touching the database, `pnpm openapi:check`, and `pnpm e2e` for the login page.
- The repo's rules hold:
  - business logic in `packages/core`;
  - portable SQL;
  - ADRs for decisions;
  - the OpenAPI contract committed;
  - `.ts` relative imports;
  - no build step inside the monorepo, except the tsdown bundles.
- Module tests run the module's `setup` against a real commander `Command` (the dev dependency at `^14`) and a
  fake `ModuleContext`. The fake's `caller().fetch` routes to the in-process app in trusted mode. One test loads
  the built bundle through the real `@poietic-tech/cli` host (dev dependency `^0.1.1`), to prove that discovery,
  the manifest and the default export fit.
- No identity token or `pat_` is ever printed, and none appears in error output.

## Left to the builder

- The exact names of the runtime interface and the file layout inside `apps/cli/src` (for example,
  `module.ts`, `admin.ts` and `tree/`).
- How the per-kind columns are expressed as host `Column`s.
- Whether `schema` and `commands` need the network: if a command can answer offline, it should.
- Commit granularity. Each commit must pass `pnpm check`.
