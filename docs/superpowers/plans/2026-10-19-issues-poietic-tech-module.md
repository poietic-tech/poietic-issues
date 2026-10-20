# poietic-issues as a poietic-tech module: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Retire `trk_` tokens. Publish the remote CLI as the `poietic-tech issues` module
(`@poietic-tech/issues`), keep local mode only in an unpublished operator tool (`poietic-issues-admin`), and
release the module from `issues-v*` tags.

**Architecture:** The command definitions become one tree. It registers onto any commander `Command` through
`parent.command(...)` and `cmd.createOption(...)`, so the tree never imports commander at run time. It talks to
a small runtime interface. Two hosts provide that interface:
- the module, over `ModuleContext` and `caller.fetch`;
- the admin tool, over the in-process app in trusted mode.

On the server side, `trk_` is deleted down to the table.

**Tech stack:** TypeScript (ESM, `.ts` imports), pnpm 10 workspace, commander 14, Hono, Kysely
(SQLite + Postgres), Vitest, tsdown, Svelte (web), GitHub Actions with npm trusted publishing.

**Spec:** `docs/superpowers/specs/2026-10-19-issues-poietic-tech-module-design.md`. Read it. The spec is binding
and this plan argues from it.

## Global constraints

- `pnpm check` passes before every commit. DB-touching code passes under `TEST_DB=sqlite` and
  `TEST_DB=postgres`. `pnpm openapi:check` passes.
- Business logic stays in `packages/core`. SQL stays portable through the `packages/db` helpers. Relative imports
  use `.ts`.
- Published package: `@poietic-tech/issues`, version `0.1.0`.
  - `"files": ["dist", "README.md", "LICENSE"]`
  - `"engines": {"node": ">=22.12"}`
  - `"peerDependencies": {"@poietic-tech/cli": "^0.1.1"}`
  - `"poietic-tech": {"command": "issues", "entry": "./dist/poietic-tech.js", "api": 1, "summary": "Issue tracker at issues.poietic.tech"}`
  - no `bin`
  - no `workspace:` or `file:` in `dependencies` or `peerDependencies`
- The module never imports commander or `defineModule` at run time. Type-only imports from `commander` (dev
  dependency `^14`) and `@poietic-tech/cli/module` (dev dependency `^0.1.1`) are allowed.
- The module's server defaults to `https://issues.poietic.tech`. It is overridden by `POIETIC_ISSUES_SERVER`, then
  by `.poietic-issues.json` `server`. It must be `https:` on a `*.poietic.tech` host, otherwise `bad_usage`.
- The error mapping table in the spec section "Errors" is verbatim law.
- No `pat_`, `pcl_` or identity token is ever printed.
- After the last task, `git grep -n 'trk_'` outside `docs/adr/` and `docs/superpowers/` is empty.

## Review focus

1. **No login, or an expired one.** `poietic-tech issues issue list` exits 3 with the host's `not_logged_in`
   message. It is never wrapped as `internal`. Test in Task 5.
2. **A local server URL.** `POIETIC_ISSUES_SERVER=http://localhost:3000` is `bad_usage` (exit 2) before any
   network or credential access. Test in Task 5.
3. **Offline commands.** `issues --help`, `issues commands --json` and `issues schema` work with no login and
   never call `ctx.caller()`. Test in Task 5.
4. **An old `trk_…` bearer.** Sent to the server after the change, it is a 401 with problem JSON, never a 500.
   Test in Task 2.
5. **A network failure on create.** It retries with the same `Idempotency-Key` through `caller.fetch`, so there
   is no duplicate. Test in Task 5.

---

### Task 1: Server tests authenticate with identity tokens, not `trk_`

**Files:**
- Create: `apps/server/src/testing.ts`
- Modify: `apps/server/src/api.test.ts`, `access.test.ts`, `attachments.test.ts`, `stream.test.ts`,
  `webhooks.test.ts`, `deploy/cloudflare/src/forward.test.ts`

**Interfaces:**
- Produces:
  ```ts
  testSso(t: TestContext): {
    options: SsoOptions;
    bearer(handle: string): Promise<string>;
  }
  ```
  - `options` is a fake verifier in the style of `sso.test.ts`: the token is the subject. Liveness and the
    directory are stubbed so they always succeed.
  - `bearer` links the existing test user `handle` to a subject (insert into `user_identities`, through a core
    or db helper if one exists) and returns the bearer value.

- [ ] **Step 1:** In each listed test, replace `createToken(...)` and `Bearer ${token}` with
  `createApp({ ..., sso: options })` and `Bearer ${await bearer('admin')}` (or `'member'`). Assertions stay as they
  are.
- [ ] **Step 2:** Run `pnpm vitest run --project server` and `TEST_DB=postgres pnpm vitest run --project server`.
  Expected: PASS with no assertion changes. `trk_` is not yet removed.
- [ ] **Step 3:** Commit `test(server): authenticate API tests with identity tokens`.

### Task 2: Retire `trk_` in db, core, server, client and web

**Files:**
- Create: `packages/db/src/migrations/0007_drop_api_tokens.ts`. Register it wherever migrations are listed.
- Modify:
  - `packages/db/src/types.ts`
  - `packages/core/src/services/auth.ts`, `bootstrap.ts`, `seed.ts`, `index.ts`, `mappers.ts`
  - `packages/schema/src/entities.ts`
  - `apps/server/src/middleware/auth.ts`, `routes/auth.ts`, `routes/users.ts`, `app.ts`, `env.ts`
  - `packages/client/src/index.ts`
  - `docs/openapi.json` and `packages/client/src/generated/openapi.d.ts`, regenerated with `pnpm openapi:gen`
  - `apps/web/src/routes/login/+page.svelte`, `apps/web/src/demo/install.ts`
  - `apps/cli/src/commands/admin.ts` (delete `tokenCommand`) and `commands/index.ts`
  - `apps/cli/src/commands/system.ts` (`db bootstrap` and `db seed` print no tokens)
  - the tests that cover these: `packages/core/src/services.test.ts`, `visibility.test.ts`, `legacy-env.test.ts`,
    `apps/server/src/sso.test.ts`, `apps/cli/src/cli.test.ts`, `config.test.ts`
- Test: `packages/db` migration test (follow the existing migration-test pattern), and `apps/server/src/sso.test.ts`

**Interfaces:**
- Produces:
  - `bootstrapAdmin(db, input): Promise<{ user: User }>`, with no `token`.
  - `seedDemoData(ctx): Promise<void>`, or `{ users }` if callers need it, with no tokens.
  - Middleware: any bearer goes to the identity verifier when SSO is configured, else 401 `UNAUTHENTICATED`.

- [ ] **Step 1: failing tests.**
  - **Middleware:**
    - A bearer `trk_abc` against an app with SSO is 401 problem JSON whose `code` is `UNAUTHENTICATED`.
    - A bearer against an app without SSO is the same 401.
    - Neither falls back to a valid cookie sent alongside.
  - **Migration:** after migrating to latest, the `api_tokens` table does not exist, in both dialects.
  - **Routes:** `POST /users/admin/tokens`, `GET /users/admin/tokens`, `DELETE /tokens/x` and
    `POST /auth/token-login` all return 404.
- [ ] **Step 2:** Run `pnpm vitest run --project server --project db`. Expected: FAIL on the new tests.
- [ ] **Step 3:** Implement.
  - Delete `createToken`, `authenticateToken`, the token list/revoke services, their routes and schemas, and the
    `trk_` branch and its docstring in the middleware.
  - Write migration 0007: `dropTable('api_tokens')`, plus its indexes if the dialect needs that.
  - In the web, remove the token form, `tokenLogin` and the "token create" hint. "`poietic-issues user edit …
    --reactivate`" becomes "`poietic-tech issues user edit … --reactivate`".
  - In the demo, remove the `/auth/token-login` handler.
- [ ] **Step 4:** Run `pnpm openapi:gen`, then `pnpm check`, `pnpm test:pg` (with `pnpm pg start`) and `pnpm e2e`.
  Expected: all pass. `git grep -n 'createToken\|authenticateToken\|token-login\|api_tokens'` outside migrations
  0001 and 0007 and `docs/adr` returns nothing.
- [ ] **Step 5:** Commit `feat!: retire trk_ API tokens`.

### Task 3: One command tree with no runtime commander import

The behaviour stays the same. The current CLI keeps passing its tests unchanged.

**Files:**
- Create: `apps/cli/src/tree/runtime.ts` (the interfaces) and `apps/cli/src/tree/index.ts`
  (`registerTree`)
- Move or modify: `apps/cli/src/commands/*.ts`, so each exports `register<Name>(parent, tree)` in place of
  `<name>Command(io): Command`
- Modify: `apps/cli/src/runtime.ts` (`Runtime implements CommandRuntime`), `apps/cli/src/main.ts`
- Test: `apps/cli/src/tree/imports.test.ts`

**Interfaces:**
- Produces, in `tree/runtime.ts`:
  ```ts
  export interface Sink {
    readonly format: OutputFormat;
    item(kind: Kind, value: unknown, human?: (row: Row) => string): void;
    list(kind: Kind, value: unknown[] | { data: unknown[]; nextCursor?: string | null }): void;
    note(text: string): void;
    raw(text: string): void;
    rawBytes(bytes: Uint8Array): void;
  }
  export interface CommandRuntime {
    api(): Promise<ApiClient>;
    call<T>(request: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T>;
    project(explicit?: string): string;
    readonly out: Sink;
    readonly io: Pick<CliIO, 'env' | 'cwd' | 'readStdin' | 'stderr'>;
  }
  export interface Tree {
    act(handler: (rt: CommandRuntime, args: unknown[], opts: Record<string, unknown>) => Promise<void>): (...all: unknown[]) => Promise<void>;
    /** Names the tree uses in messages, e.g. "poietic-tech issues" or "poietic-issues-admin". */
    readonly commandName: string;
  }
  export function registerTree(parent: Command, tree: Tree, only?: readonly string[]): void;
  ```
- `registerTree` registers the record commands: issue, comment, link, attachment, project (with members),
  status, label, field, view, event, webhook, user, schema, api, init and whoami. It registers `commands` only
  when the root needs it.
- Every user-facing string that names the binary (for example "run `poietic-issues init`") uses
  `tree.commandName`.
- Direct `io.stdout` and `stdoutBytes` calls in commands become `rt.out.raw` and `rt.out.rawBytes`.

- [ ] **Step 1: failing test** `imports.test.ts`. For every file under `apps/cli/src/tree/` and
  `apps/cli/src/commands/`:
  - no line matches `/^import (?!type)[^;]*from 'commander'/`;
  - no file imports `@poietic-tech/issues-core`, `-db` or `-server`.

  Expected: FAIL today.
- [ ] **Step 2:** Convert each command file.
  - `new Command('x')` becomes `parent.command('x')`.
  - `new Option(...)` becomes `cmd.createOption(...)`.
  - `makeAction(io, fn)` becomes `tree.act(fn)`.

  `main.ts` builds the root `Command` as today and calls `registerTree(program, adminTree)`, where `adminTree.act`
  constructs today's `Runtime`.
- [ ] **Step 3:** Run `pnpm vitest run --project cli`. Expected: PASS, with `cli.test.ts` and the golden file
  unchanged. Run `pnpm check`.
- [ ] **Step 4:** Commit `refactor(cli): register commands onto any commander root through a runtime interface`.

### Task 4: The operator tool `poietic-issues-admin`, local mode only

**Files:**
- Create: `apps/cli/src/admin.ts` (root program and `run`) and `apps/cli/src/admin-bin.ts`
- Delete or shrink: the remote parts of `apps/cli/src/config.ts` and `transport.ts` (keep the `retryingFetch`
  export for Task 5), `bin.ts`, and the `auth` command in `system.ts`
- Modify:
  - `tsdown.config.ts`: entry `'poietic-issues-admin': 'apps/cli/src/admin-bin.ts'` replaces `poietic-issues`
  - `Dockerfile`: install `/usr/local/bin/poietic-issues-admin` running `dist/poietic-issues-admin.mjs`; no
    `poietic-issues`
  - the root `package.json` script `issues-admin` replaces `poietic-issues`
  - `docker-compose.yml` comment, `apps/server/src/server.ts` messages, `scripts/dev.ts` if it calls the CLI
  - `.github/workflows/ci.yml` container smoke
  - `deploy/cloudflare/test/restore.sh`
- Test: `apps/cli/src/cli.test.ts` (now drives `admin.ts` `run`), `config.test.ts`

**Interfaces:**
- Consumes: `registerTree` and `Tree` from Task 3.
- Produces:
  - `run(argv: string[], io: CliIO): Promise<number>` in `admin.ts`.
  - Options: `--database <url>` (or `POIETIC_ISSUES_DATABASE_URL`), `--actor <handle>`, `-P`, `--format`,
    `--json`, `-q` and `--fields`.
  - Commands: the tree, plus `db migrate|status|bootstrap|seed` and `serve`. There is no `--server`, no `--token`
    and no `auth`, and `POIETIC_ISSUES_TOKEN` is not read.

- [ ] **Step 1: failing tests.**
  - `run(['--server','https://x','issue','list'])` is exit 2 with "unknown option".
  - `run(['auth','status'])` is exit 2 with "unknown command".
  - `run(['issue','create','-t','x','--json'])` still works through the injected fetch.
  - `--help` output starts with `Usage: poietic-issues-admin`.
- [ ] **Step 2:** Implement, then update the infrastructure files.
  - **ci.yml container smoke.** Bring the container up and wait as before, then:
    ```sh
    docker compose exec -T poietic-issues poietic-issues-admin db bootstrap --handle ci --name CI --json
    docker compose exec -T poietic-issues sh -c 'poietic-issues-admin --actor ci project create -k CI --name CI -q && poietic-issues-admin --actor ci issue create -t "From CI" --project CI -q && poietic-issues-admin --actor ci issue view CI-1 --json'
    ```
    `jq` asserts the title is "From CI". The graceful-stop check is unchanged.
  - **restore.sh.** Write with `poietic-issues-admin --actor ada` inside `tr-a` after `db bootstrap --handle ada`.
    Read back with `poietic-issues-admin --actor ada project view <KEY> --json` inside `tr-b`. Keep every
    fail-closed case it has.
- [ ] **Step 3:** Run `pnpm check` and `pnpm build` (expect `dist/poietic-issues-admin.mjs` and no
  `dist/poietic-issues.mjs`), then `docker compose up -d --build --wait poietic-issues` and the smoke commands
  above. Expected: pass. Run `bash deploy/cloudflare/test/restore.sh` if Docker allows; otherwise say so in the
  report.
- [ ] **Step 4:** Commit `feat(cli)!: local mode moves to the poietic-issues-admin operator tool`.

### Task 5: The `poietic-tech issues` module

**Files:**
- Create in `apps/cli/src/module/`:
  - `index.ts` (the default export `{ api: 1, setup }`)
  - `runtime.ts` (`ModuleRuntime implements CommandRuntime`)
  - `sink.ts` (`ModuleSink implements Sink` over `ctx.output`)
  - `errors.ts` (`toHostError`)
  - `server.ts` (`resolveServer`)
  - `module.test.ts`
- Create: `apps/cli/tsdown.config.ts`
- Create: `apps/cli/test/bundle.test.ts`
- Modify: `apps/cli/package.json` (the global constraints' fields; workspace packages, `zod` and `openapi-fetch` to
  `devDependencies`; `commander` `^14` to `devDependencies`; `@poietic-tech/cli` `^0.1.1` as a dev and peer
  dependency; script `build:module`)
- Modify: `reference.ts` (headings `poietic-tech issues …`), `apps/cli/test/commands.golden.json`,
  `docs/cli-reference.md`, `system.ts` (`commands` describes the module root)

**Interfaces:**
- Consumes: `registerTree`, `Tree`, `CommandRuntime`, `Sink`, the existing `COLUMNS`, `identifier` and `project`
  from `output.ts`, `retryingFetch`, and `toCliError`.
- Produces:
  - `resolveServer(env, cwd): string`. It throws a `bad_usage` failure for a non-https or non-`*.poietic.tech`
    URL.
  - `toHostError(e: CliError): { code: string; message: string; status?: number }`, mapping exactly as the spec's
    table:
    - field errors are appended as `\n  path: message`;
    - CliError codes from the network path map to `network`.
  - `ModuleSink`:
    - `list` calls `ctx.output.list(rows, { columns, id })`. The columns come from `COLUMNS[kind]`, or from
      `--fields`; for json and ndjson, rows are projected with `--fields`.
    - `item` calls `ctx.output.item(projected, columns)`.
    - `note` calls `ctx.output.message`.
    - `raw` and `rawBytes` call `process.stdout.write`, which is injectable for tests.
    - `format` is not knowable from the module. Callers that branched on `rt.out.format` must stop branching.
  - The `issues` command has the options `-P, --project <key>` and `--fields <list>`.
  - `act` runs the handler, catches anything, and turns a `CliError` into `ctx.fail(...)` through `toHostError`.
    Anything already thrown by the host (the caller's errors) is rethrown untouched.

- [ ] **Step 1: failing tests in `module.test.ts`.** Each runs `setup(fakeCtx)` on
  `new Command('poietic-tech').command('issues')`.
  - `fakeCtx.caller()` returns `{ fetch }`, routed to the in-process app in trusted mode (as `cli.test.ts`
    builds it). It counts calls. `fakeCtx.output` records calls. `fakeCtx.fail` throws `{ code, message, status }`.
  - **Cases:**
    - `issues issue create -t T` records `item` with `key` `CLI-1`.
    - `issues -P CLI issue list --fields key,title` records `list` with columns `KEY` and `TITLE`, and an `id` that
      returns the issue key.
    - **Every row of the spec's error table:**
      - `issues issue view CLI-999` fails with `not_found`.
      - Bad input fails with `bad_request`.
      - A stale version fails with `version_mismatch`, status 409.
      - A forbidden action fails with `not_allowed`.
      - A 401 fails with `not_logged_in`.
      - A 503 fails with `server_error`.
      - A thrown fetch `TypeError('fetch failed')` fails with `network`.
    - `caller()` rejecting with a host-shaped error (`{ code: 'not_logged_in' }`) propagates that same object
      (Review focus 1).
    - `POIETIC_ISSUES_SERVER=http://localhost:3000` fails with `bad_usage`, and `caller` is never called
      (Review focus 2).
    - `issues commands --json` and `issues schema issue` write through `raw`, and `caller` is never called
      (Review focus 3).
    - A first fetch that throws a network error, then succeeds, creates exactly one issue, with the same
      `idempotency-key` on both attempts (Review focus 5).
    - The `issues` command's options are exactly `-P, --project` and `--fields`.
- [ ] **Step 2: failing test `bundle.test.ts`.** It runs after `pnpm --filter @poietic-tech/issues build:module`
  and reads `apps/cli/dist/poietic-tech.js`.
  - The file has no `from"commander"` or `from "commander"`, no `new CommanderError`, and no `better-sqlite3`,
    `kysely` or `hono` strings.
  - `import()` of the file gives a default with `api === 1` and a `setup` function.
  - `package.json` passes the global constraints' checks. Reading it in the test is enough.
- [ ] **Step 3:** Implement the module and `apps/cli/tsdown.config.ts`:
  - entry `poietic-tech: src/module/index.ts`;
  - `outDir: dist`, `format: esm`, `platform: node`, `target: node22`;
  - bundle everything except `commander` and `@poietic-tech/cli`.
- [ ] **Step 4:** Regenerate the golden file and the reference with `pnpm vitest run --project cli -u`. Check by
  reading that every heading is `poietic-tech issues …` and that the exit-code section lists the host's codes
  (0, 1, 2, 3, 4, 5, 8) as the module maps them.
- [ ] **Step 5:** Run `pnpm check` and `pnpm --filter @poietic-tech/issues build:module`, then the bundle test.
  Expected: PASS.
- [ ] **Step 6:** Commit `feat(cli): publish the CLI as the poietic-tech issues module`.

### Task 6: Release workflow and host smoke test

**Files:**
- Create: `apps/cli/scripts/smoke.sh`, `.github/workflows/release-issues.yml`
- Modify: `.github/workflows/ci.yml` (job `module-smoke` runs `build:module` then `smoke.sh`), `docs/releases.md`

**Interfaces:**
- `smoke.sh` takes no arguments and exits non-zero on any failure. It:
  1. sets up a temp prefix and a temp HOME;
  2. runs `npm pack` in `apps/cli`;
  3. runs `npm i -g --prefix "$T/p" @poietic-tech/cli@^0.1.1 ./poietic-tech-issues-*.tgz`;
  4. checks that `"$T/p/bin/poietic-tech" issues --help` exits 0 and prints `issue`;
  5. checks that `"$T/p/bin/poietic-tech" modules list --json` has `@poietic-tech/issues` with `"command":"issues"`
     and the state `"loaded on demand"`;
  6. checks that `"$T/p/bin/poietic-tech" issues issue list` exits 3 (not logged in);
  7. removes the tarball.

- [ ] **Step 1:** Write `smoke.sh` and run it locally. Expected: all checks pass.
- [ ] **Step 2:** Write `release-issues.yml`:
  - `on: push: tags: ['issues-v*']`;
  - job `publish`, `environment: npm`, `permissions: { contents: read, id-token: write }`;
  - actions pinned exactly as in `ci.yml`;
  - checkout with `fetch-depth: 0`, pnpm, then setup-node with `node-version-file: .nvmrc` and
    `registry-url: https://registry.npmjs.org`;
  - `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm vitest run --project cli`;
  - **guards, each its own step:**
    - `git merge-base --is-ancestor "$GITHUB_SHA" origin/main`;
    - `test "issues-v$(node -p 'require("./apps/cli/package.json").version')" = "$GITHUB_REF_NAME"`;
    - a node one-liner that fails if `dependencies` or `peerDependencies` contain `workspace:` or `file:`;
  - `pnpm --filter @poietic-tech/issues build:module`, then the bundle test, then `bash apps/cli/scripts/smoke.sh`;
  - `npm publish --access public --provenance`, with `working-directory: apps/cli`.
- [ ] **Step 3:** Add the `module-smoke` job to `ci.yml`, then run `actionlint` if it is available (otherwise
  say so). Update `docs/releases.md` with the steps (bump the version, merge, tag `issues-vX.Y.Z`, watch the run)
  and the owner one-time steps from the spec.
- [ ] **Step 4:** Commit `ci: release @poietic-tech/issues from issues-v* tags`.

### Task 7: Docs, ADR 0028 and the README

**Files:**
- Create: `docs/adr/0028-sso-only-and-the-poietic-tech-module.md` (in the format of ADR 0023), `apps/cli/README.md`
- Modify:
  - `docs/adr/0023-agent-identities.md`: one "Superseded in part by 0028" line, with nothing rewritten
  - `docs/adr/README.md` index
  - `docs/agents.md` (rewritten as in the spec), `docs/cli.md`, `docs/api.md`, `docs/security.md`,
    `docs/data-model.md`, `docs/deployment.md`
  - `README.md`, `AGENTS.md`
- Test: `apps/cli/test/no-trk.test.ts`

- [ ] **Step 1: failing test `no-trk.test.ts`.** It runs `git grep -n -e 'trk_' -e 'POIETIC_ISSUES_TOKEN' -e
  'poietic-issues token'` (through `execFile`) excluding `docs/adr`, `docs/superpowers` and this test file, and
  expects no output.
- [ ] **Step 2:** Write the docs. `apps/cli/README.md` covers exactly what the spec's README bullet lists.
  `AGENTS.md` swaps `pnpm poietic-issues …` for `pnpm issues-admin …` and mentions `build:module`.
- [ ] **Step 3:** Run `pnpm check`. Expected: PASS, including `no-trk.test.ts`.
- [ ] **Step 4:** Commit `docs: SSO-only access and the poietic-tech issues module (ADR 0028)`.
