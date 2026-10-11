# The `poietic-issues` CLI

`poietic-issues` (npm: `@poietic-tech/issues`) is the command-line interface to the tracker, built to be driven by AI agents as much as by people. Every command is listed in the generated [CLI reference](cli-reference.md).

```sh
pnpm poietic-issues --help              # inside this repo (or link the bin: apps/cli/src/bin.ts)
poietic-issues issue create -t "Fix login" -p high -l bug --json
poietic-issues issue list --assignee me --status "In Progress"
poietic-issues issue edit ENG-42 --status Done --add-label shipped
poietic-issues comment add ENG-42 --body-file notes.md
poietic-issues link add ENG-42 blocked-by ENG-7
```

## Grammar

`tracker <noun> <verb> [arguments] [options]`, for example `issue list`, `comment add`, `link add`, `status reorder`.

**Issue references.** Issues are referenced as `ENG-42` or by id, everywhere.

**Other references.** Anything with a name can be referenced by it:

- statuses: `--status "In Progress"`
- labels: `--label bug`
- users: `--assignee @ada`, `me` or `none`
- links: `blocks`, `blocked-by`, `relates-to`, `duplicates`, `duplicated-by`

## Connecting: remote and local mode

| Mode       | When                                                               | How it works                                                                                                                              |
| ---------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Remote** | a server URL is configured                                         | HTTPS to `POIETIC_ISSUES_SERVER` with the token `POIETIC_ISSUES_TOKEN`                                                                    |
| **Local**  | only a database URL is configured (default `sqlite:./data/dev.db`) | Runs the same HTTP API in-process against the database file; no server needed. Acts as `POIETIC_ISSUES_ACTOR` (default: the first admin). |

Both modes execute the exact same API code, including validation, permissions, events and error codes ([ADR 0005](adr/0005-api-as-contract.md)).

Configuration precedence (first wins):

1. Flags: `--server`, `--token`, `--database`, `--actor`, `--project`, `--format`, `--fields`
2. Environment: `POIETIC_ISSUES_SERVER`, `POIETIC_ISSUES_TOKEN`, `POIETIC_ISSUES_DATABASE_URL`, `POIETIC_ISSUES_ACTOR`, `POIETIC_ISSUES_PROJECT`, `POIETIC_ISSUES_FORMAT`, `POIETIC_ISSUES_FIELDS`
3. `.poietic-issues.json`, found by walking up from the current directory. Write it with `poietic-issues init`. It holds `server` / `database`, `project` and `actor`, **never tokens**. Commit it to a repository so agents working there pick the right project.
4. User config `$XDG_CONFIG_HOME/poietic-issues/config.json` (mode 0600), which holds tokens per server. Write it with `poietic-issues auth login --server <url> --with-token < token.txt`.

`poietic-issues auth status` shows which mode, user and project are in effect, and where each setting came from.

In remote mode, a set `POIETIC_AGENT_TOKEN` overrides every token source above: the CLI acts as that poietic.tech agent ([agents.md](agents.md#acting-as-a-poietictech-agent), [ADR 0023](adr/0023-agent-identities.md)).

## Output contract

| Format | Flag                        | Output                                                                                     |
| ------ | --------------------------- | ------------------------------------------------------------------------------------------ |
| table  | default                     | Aligned columns for humans. Hints go to stderr.                                            |
| json   | `--json` or `--format json` | Exactly the API resource shape. Lists are `{ "data": [...], "nextCursor": … }`.            |
| ndjson | `--format ndjson`           | One JSON object per line. Good for streaming and `jq -c`.                                  |
| ids    | `-q` / `--quiet`            | Only keys and ids, one per line (e.g. `poietic-issues issue create … -q` prints `ENG-43`). |

- `POIETIC_ISSUES_FORMAT=json` sets the default for a whole agent session.
- The format never switches automatically based on TTY detection.
- `--fields key,title,status,assignee.handle` projects output to those fields, for fewer tokens. Plain names are resource fields or field-registry keys (e.g. `statusCategory`). Dotted paths reach into objects.
- `--all` fetches every page. `--limit` and `--cursor` page manually.
- **stdout carries only results.** Errors and hints go to **stderr**.
- Nothing ever prompts. A missing required input fails immediately with exit code 2.

## Errors and exit codes

With `--json`, errors are written to stderr as a JSON object with a stable `code`, the same codes as the API ([api.md](api.md#errors)):

```json
{ "code": "NOT_FOUND", "detail": "Issue \"ENG-999\" not found" }
```

| Exit | Meaning             | Codes                                              |
| ---- | ------------------- | -------------------------------------------------- |
| 0    | Success             |                                                    |
| 1    | Internal error      | `INTERNAL`                                         |
| 2    | Usage or validation | `VALIDATION_FAILED`, `INVALID_RELATION`, bad flags |
| 3    | Not found           | `NOT_FOUND`                                        |
| 4    | Conflict            | `CONFLICT`, `VERSION_MISMATCH`, `IDEMPOTENCY_*`    |
| 5    | Auth                | `UNAUTHENTICATED`, `FORBIDDEN`                     |
| 6    | Unavailable         | server unreachable, database not migrated          |

## Input

- **Long text:** `--body-file <path>`, or `--body-file -` to read stdin (descriptions, comments).
- **Structured input:** `--input <json | @file | ->` passes a full request payload (`CreateIssueInput` / `UpdateIssueInput`). Flags override its fields.
- **Custom fields:** `--set severity=high --set points=3`. Values are parsed as JSON when possible, so `--set tags='["a","b"]'` works.
- **Metadata:** `--meta github.pr=https://…` merges into the issue's `metadata`, a place for agent and integration bookkeeping.
- **Clearing a field:** `none` clears it, e.g. `--assignee none`, `--parent none`, `--due none`, `--repo none` (an empty `--repo ''` does too).

## Safety for automation

- **Retries are safe.** Every mutation in remote mode carries an `Idempotency-Key`. Network failures are retried twice with the same key, so a retried create never duplicates.
- **Optimistic concurrency.** `--if-version N` (from the issue's `version`) makes `edit`, `move` and `delete` fail with exit 4 instead of overwriting a concurrent change.
- **Deletes are restorable.** `issue delete` moves the issue to the trash, and `issue restore` brings it back. `--permanent` is admin-only.
- **Atomic multi-issue edits.** `issue edit ENG-1 ENG-2 …` updates several issues atomically.

## Project access

Projects are `private` (members and admins) or `public` (anyone can read). Members have a role: `viewer`, `editor` or `manager`. Changing any of this needs `manage` on the project. These commands take the project from `-P`, `POIETIC_ISSUES_PROJECT` or `.poietic-issues.json`, like the rest of the CLI.

```sh
poietic-issues project edit ENG --visibility public
poietic-issues project members add @ada --role editor -P ENG
poietic-issues project members set @ada --role manager -P ENG
poietic-issues project members list -P ENG
poietic-issues project repo add https://github.com/acme/app -P ENG   # or acme/app
poietic-issues issue edit ENG-42 --repo acme/app                      # one of the project's linked repos
```

## Discovery

| Command                                                                 | What it gives                                                                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `poietic-issues commands --json`                                        | Every command, argument, option, exit code, error code and environment variable, in one call                        |
| `poietic-issues project schema`                                         | JSON Schema for issue create/update in the current project, with live enums: statuses, labels, users, custom fields |
| `poietic-issues schema <name>`                                          | JSON Schema of resources and inputs (`issue`, `issue-create`, `issue-filter`, `view-config`, …)                     |
| `poietic-issues api GET /issues/ENG-1`                                  | Any endpoint, raw (like `gh api`)                                                                                   |
| `poietic-issues event list --after <seq>` / `poietic-issues event tail` | What changed since a point in time (NDJSON with `tail`)                                                             |

## Administration (local mode)

```sh
poietic-issues --database sqlite:./data/dev.db db migrate    # apply migrations
poietic-issues db seed                                       # demo data + printed tokens (empty database only)
poietic-issues serve --port 3000                             # run the server on the local database
poietic-issues user create --handle builder-bot --name "Builder Bot" --kind agent
poietic-issues token create --user builder-bot --name ci -q  # prints the secret only
```
