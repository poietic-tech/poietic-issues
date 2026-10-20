# CLI reference

<!-- Generated from `poietic-issues commands --json` by the CLI test suite. Do not edit; run `pnpm vitest run --project cli -u`. -->

See [cli.md](cli.md) for concepts, output formats and configuration.

## Global options

| Option | Description |
| --- | --- |
| `-V, --version` | output the version number |
| `--server <url>` | poietic-issues server URL (remote mode) |
| `--token <token>` | API token (remote mode) |
| `--database <url>` | database URL (local mode), e.g. sqlite:./data/dev.db |
| `--actor <handle>` | local mode: act as this user |
| `-P, --project <key>` | project key (default from POIETIC_ISSUES_PROJECT or .poietic-issues.json) |
| `--format <format>` | output format |
| `--json` | JSON output (same as --format json) |
| `-q, --quiet` | print only ids/keys (same as --format ids) |
| `--fields <fields>` | comma-separated fields to include, e.g. key,title,status |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Internal or unexpected error |
| 2 | Usage or validation error (bad flags, invalid input, invalid relation) |
| 3 | Not found |
| 4 | Conflict (duplicate, version mismatch, idempotency) |
| 5 | Authentication or permission error |
| 6 | Unavailable (server unreachable, database not migrated) |

## Commands

### `tracker issue list`

List issues in a project (filters are ANDed; comma lists mean "any of")

Aliases: `ls`

| Option | Description |
| --- | --- |
| `-s, --status <statuses>` | status names/ids |
| `--category <categories>` | status categories: backlog,unstarted,started,completed,canceled |
| `-a, --assignee <users>` | handles/ids, me, none |
| `--creator <users>` | creator handles/ids |
| `-l, --label <labels>` | has any of these labels |
| `-p, --priority <priorities>` | priorities (names or 0-4) |
| `--parent <issue>` | children of this issue, or none for top-level issues |
| `--search <text>` | text in key, title or description |
| `-w, --where <field.op=value>` | any filter, e.g. priority.gte=2, dueDate.isNull=true, cf.severity=high |
| `--filter-json <json|@file|->` | an IssueFilter JSON object |
| `--sort <fields>` | sort fields, - for descending (e.g. -priority,updatedAt) |
| `--limit <n>` | page size (1-200) |
| `--cursor <cursor>` | continue from a previous page |
| `--all` | fetch every page |
| `--include-deleted` | include issues in the trash (only in projects you can write in; ignored elsewhere) |
| `--all-projects` | search across all projects |

### `tracker issue view <issue>`

Show one issue

Aliases: `show`

| Argument | Description |
| --- | --- |
| `issue` | issue key (ENG-42) or id |

### `tracker issue create`

Create an issue (prints the new issue; -q prints only its key)

Aliases: `new`

| Option | Description |
| --- | --- |
| `-t, --title <title>` | title |
| `-d, --description <markdown>` | description (markdown) |
| `--body-file <path>` | read the description from a file, or - for stdin |
| `-s, --status <status>` | status name or id |
| `-p, --priority <priority>` | none\|urgent\|high\|medium\|low or 0-4 |
| `-a, --assignee <user>` | handle, @handle, me, or none to unassign |
| `--parent <issue>` | parent issue key, or none |
| `-e, --estimate <points>` | estimate, or none |
| `--due <date>` | due date YYYY-MM-DD, or none |
| `--repo <owner/name>` | one of the project's linked GitHub repos (owner/name, URL or id); none, null or '' clears it |
| `--set <field=value>` | custom field (repeatable), e.g. --set severity=high --set points=3 |
| `--meta <key=value>` | metadata entry (repeatable; merged) |
| `--input <json|@file|->` | full JSON payload (CreateIssueInput / UpdateIssueInput); flags override it |
| `-l, --label <labels>` | labels (repeatable or comma-separated) |

### `tracker issue edit <issues...>`

Edit one or more issues (several issues are updated atomically)

Aliases: `update`

| Argument | Description |
| --- | --- |
| `issues` | issue keys or ids |

| Option | Description |
| --- | --- |
| `-t, --title <title>` | title |
| `-d, --description <markdown>` | description (markdown) |
| `--body-file <path>` | read the description from a file, or - for stdin |
| `-s, --status <status>` | status name or id |
| `-p, --priority <priority>` | none\|urgent\|high\|medium\|low or 0-4 |
| `-a, --assignee <user>` | handle, @handle, me, or none to unassign |
| `--parent <issue>` | parent issue key, or none |
| `-e, --estimate <points>` | estimate, or none |
| `--due <date>` | due date YYYY-MM-DD, or none |
| `--repo <owner/name>` | one of the project's linked GitHub repos (owner/name, URL or id); none, null or '' clears it |
| `--set <field=value>` | custom field (repeatable), e.g. --set severity=high --set points=3 |
| `--meta <key=value>` | metadata entry (repeatable; merged) |
| `--input <json|@file|->` | full JSON payload (CreateIssueInput / UpdateIssueInput); flags override it |
| `-l, --label <labels>` | replace all labels (repeatable or comma-separated) |
| `--add-label <labels>` | add labels |
| `--remove-label <labels>` | remove labels |
| `--if-version <n>` | fail with exit 4 unless the issue is at this version |

### `tracker issue move <issue>`

Move an issue on the board: change status and/or position within the column

| Argument | Description |
| --- | --- |
| `issue` | issue key or id |

| Option | Description |
| --- | --- |
| `-s, --status <status>` | target status (name or id) |
| `--after <issue>` | place directly after this issue |
| `--before <issue>` | place directly before this issue |
| `--top` | place at the top of the column (default) |
| `--bottom` | place at the bottom of the column |
| `--if-version <n>` | fail unless the issue is at this version |

### `tracker issue delete <issue>`

Move an issue to the trash (restorable); --permanent deletes for good (admin)

Aliases: `rm`

| Argument | Description |
| --- | --- |
| `issue` | issue key or id |

| Option | Description |
| --- | --- |
| `--permanent` | delete permanently, with comments and links |
| `--if-version <n>` | fail unless the issue is at this version |

### `tracker issue restore <issue>`

Restore an issue from the trash

| Argument | Description |
| --- | --- |
| `issue` | issue key or id |

### `tracker issue children <issue>`

List sub-issues

| Argument | Description |
| --- | --- |
| `issue` | issue key or id |

### `tracker issue activity <issue>`

Show the history of an issue (changes, comments, links)

Aliases: `history`

| Argument | Description |
| --- | --- |
| `issue` | issue key or id |

| Option | Description |
| --- | --- |
| `--after <seq>` | only events after this sequence number |
| `--limit <n>` | page size |

### `tracker comment list <issue>`

List comments on an issue (oldest first)

Aliases: `ls`

| Argument | Description |
| --- | --- |
| `issue` | issue key or id |

### `tracker comment add <issue> [text...]`

Comment on an issue (markdown)

| Argument | Description |
| --- | --- |
| `issue` | issue key or id |
| `text` | comment text (optional) |

| Option | Description |
| --- | --- |
| `-b, --body <markdown>` | comment text |
| `--body-file <path>` | read the text from a file, or - for stdin |

### `tracker comment edit <id> [text...]`

Edit your comment

| Argument | Description |
| --- | --- |
| `id` | comment id |
| `text` | new text (optional) |

| Option | Description |
| --- | --- |
| `-b, --body <markdown>` | new text |
| `--body-file <path>` | read the text from a file, or - for stdin |

### `tracker comment delete <id>`

Delete your comment

Aliases: `rm`

| Argument | Description |
| --- | --- |
| `id` | comment id |

### `tracker link list <issue>`

List an issue's links from its perspective

Aliases: `ls`

| Argument | Description |
| --- | --- |
| `issue` | issue key or id |

### `tracker link add <issue> <relation> <target>`

Link two issues, e.g. `link add ENG-1 blocks ENG-2` or `link add ENG-2 blocked-by ENG-1`

| Argument | Description |
| --- | --- |
| `issue` | issue key or id |
| `relation` | link type key or alias (blocks, blocked-by, is-blocked-by, relates, relates-to, duplicates, duplicated-by, is-duplicated-by) |
| `target` | the other issue |

### `tracker link remove <id>`

Remove a link by id (see `link list`)

Aliases: `rm`

| Argument | Description |
| --- | --- |
| `id` | link id |

### `tracker link types`

List link types

### `tracker attachment add <issue> <files...>`

Upload one or more files to an issue (the media type is detected from the content)

| Argument | Description |
| --- | --- |
| `issue` | issue key or id |
| `files` | paths to upload, or - for stdin (with --name) |

| Option | Description |
| --- | --- |
| `--name <filename>` | filename to store (default: the file’s basename) |
| `--comment <id>` | associate the upload with a comment on the issue |

### `tracker attachment list <issue>`

List the files attached to an issue

Aliases: `ls`

| Argument | Description |
| --- | --- |
| `issue` | issue key or id |

### `tracker attachment view <id>`

Show an attachment’s metadata

| Argument | Description |
| --- | --- |
| `id` | attachment id |

### `tracker attachment download <id>`

Download an attachment’s content to a file (default: its filename) or - for stdout

Aliases: `get`

| Argument | Description |
| --- | --- |
| `id` | attachment id |

| Option | Description |
| --- | --- |
| `-o, --output <path>` | where to write it; - writes the bytes to stdout |

### `tracker attachment remove <id>`

Delete an attachment (uploader or admin)

Aliases: `rm`

| Argument | Description |
| --- | --- |
| `id` | attachment id |

### `tracker project list`

List projects

Aliases: `ls`

| Option | Description |
| --- | --- |
| `--include-archived` | include archived projects |

### `tracker project view [project]`

Show a project

Aliases: `show`

| Argument | Description |
| --- | --- |
| `project` | project key or id (default: configured project) (optional) |

### `tracker project create`

Create a project with the default workflow (admin)

| Option | Description |
| --- | --- |
| `-k, --key <KEY>` | issue key prefix, e.g. ENG (immutable) **(required)** |
| `-n, --name <name>` | name **(required)** |
| `--description <text>` | description |
| `--visibility <visibility>` | public: anyone can read; private (default): members and admins |

### `tracker project edit [project]`

Edit a project

| Argument | Description |
| --- | --- |
| `project` | project key or id (optional) |

| Option | Description |
| --- | --- |
| `-n, --name <name>` | name |
| `--description <text>` | description |
| `--visibility <visibility>` | public: anyone can read; private: members and admins |
| `--archive` | archive the project (admin) |
| `--unarchive` | unarchive the project (admin) |

### `tracker project schema [project]`

JSON Schema for issue create/update in this project, with live enums (statuses, labels, repos, assignable users, custom fields)

| Argument | Description |
| --- | --- |
| `project` | project key or id (optional) |

### `tracker project members list`

List the project members

Aliases: `ls`

### `tracker project members add <user>`

Give a user a role on the project (needs manage)

| Argument | Description |
| --- | --- |
| `user` | handle, @handle or user id |

| Option | Description |
| --- | --- |
| `--role <role>` | viewer reads, editor also writes, manager also manages the project **(required)** |

### `tracker project members set <user>`

Change a member's role (needs manage)

| Argument | Description |
| --- | --- |
| `user` | handle, @handle or user id |

| Option | Description |
| --- | --- |
| `--role <role>` | the new role **(required)** |

### `tracker project members remove <user>`

Remove a user's role on the project (needs manage)

Aliases: `rm`

| Argument | Description |
| --- | --- |
| `user` | handle, @handle or user id |

### `tracker project repo list`

List the linked repositories

Aliases: `ls`

### `tracker project repo add <repo>`

Link a GitHub repository to the project (needs manage)

| Argument | Description |
| --- | --- |
| `repo` | owner/name or a github.com URL |

### `tracker project repo remove <repo>`

Unlink a repository (needs manage); issues that named it are cleared. Takes owner/name, a URL or an rpo_ id

Aliases: `rm`

| Argument | Description |
| --- | --- |
| `repo` | owner/name, github.com URL or repo id |

### `tracker status list`

List statuses in board order

Aliases: `ls`

### `tracker status create`

Create a status

| Option | Description |
| --- | --- |
| `-n, --name <name>` | name **(required)** |
| `-c, --category <category>` | backlog\|unstarted\|started\|completed\|canceled **(required)** |
| `--color <hex>` | color like #5e6ad2 |
| `--position <n>` | column position (0 = first) |

### `tracker status edit <status>`

Edit a status

| Argument | Description |
| --- | --- |
| `status` | status name or id |

| Option | Description |
| --- | --- |
| `-n, --name <name>` | new name |
| `-c, --category <category>` | category |
| `--color <hex>` | color |

### `tracker status delete <status>`

Delete a status (use --move-to if issues use it)

Aliases: `rm`

| Argument | Description |
| --- | --- |
| `status` | status name or id |

| Option | Description |
| --- | --- |
| `--move-to <status>` | move its issues to this status first |

### `tracker status reorder <statuses...>`

Set the column order: list every status, in order

| Argument | Description |
| --- | --- |
| `statuses` | status names or ids |

### `tracker label list`

List labels

Aliases: `ls`

### `tracker label create <name>`

Create a label

| Argument | Description |
| --- | --- |
| `name` | label name |

| Option | Description |
| --- | --- |
| `--color <hex>` | color |
| `--description <text>` | description |

### `tracker label edit <label>`

Edit a label

| Argument | Description |
| --- | --- |
| `label` | label name or id |

| Option | Description |
| --- | --- |
| `-n, --name <name>` | new name |
| `--color <hex>` | color |
| `--description <text>` | description |

### `tracker label delete <label>`

Delete a label (removes it from issues)

Aliases: `rm`

| Argument | Description |
| --- | --- |
| `label` | label name or id |

### `tracker field list`

List custom fields

Aliases: `ls`

| Option | Description |
| --- | --- |
| `--include-archived` | include archived fields |

### `tracker field create <key>`

Create a custom field, e.g. `field create severity --type select --option low,high`

| Argument | Description |
| --- | --- |
| `key` | immutable key (lowercase, digits, _) |

| Option | Description |
| --- | --- |
| `--type <type>` | text\|number\|date\|boolean\|select\|multi_select\|user\|url **(required)** |
| `-n, --name <name>` | display name (default: the key) |
| `--description <text>` | description |
| `--option <values>` | options for select types (repeatable or comma-separated) |
| `--config <json|@file|->` | display hints JSON, e.g. {"unit":"pts"} |

### `tracker field edit <field>`

Rename, describe, reorder or (un)archive a field

| Argument | Description |
| --- | --- |
| `field` | field key or id |

| Option | Description |
| --- | --- |
| `-n, --name <name>` | display name |
| `--description <text>` | description |
| `--position <n>` | display position |
| `--archive` | hide the field (values are kept) |
| `--unarchive` | show the field again |

### `tracker field delete <field>`

Delete a field and all its values permanently (admin; prefer `field edit --archive`)

| Argument | Description |
| --- | --- |
| `field` | field key or id |

### `tracker field option-add <field> <values...>`

Add options to a select / multi_select field

| Argument | Description |
| --- | --- |
| `field` | field key or id |
| `values` | option values |

| Option | Description |
| --- | --- |
| `--color <hex>` | color for the new options |

### `tracker field option-edit <field> <value>`

Relabel, recolor or (un)archive an option

| Argument | Description |
| --- | --- |
| `field` | field key or id |
| `value` | option value |

| Option | Description |
| --- | --- |
| `--label <label>` | display label |
| `--color <hex>` | color |
| `--archive` | archive (cannot be chosen anymore; existing values stay) |
| `--unarchive` | unarchive |

### `tracker view list`

List views (shared + yours)

Aliases: `ls`

### `tracker view show <view>`

Show a view including its config

| Argument | Description |
| --- | --- |
| `view` | view name or id |

### `tracker view create`

Save a view

| Option | Description |
| --- | --- |
| `-n, --name <name>` | name **(required)** |
| `--layout <layout>` | list\|board **(required)** |
| `--shared` | share with the project (default: personal) |
| `--config <json|@file|->` | ViewConfig JSON |

### `tracker view edit <view>`

Rename a view or replace its config

| Argument | Description |
| --- | --- |
| `view` | view name or id |

| Option | Description |
| --- | --- |
| `-n, --name <name>` | new name |
| `--config <json|@file|->` | ViewConfig JSON |

### `tracker view delete <view>`

Delete a view

Aliases: `rm`

| Argument | Description |
| --- | --- |
| `view` | view name or id |

### `tracker event list`

List events after a sequence number (use the last seq you saw as --after)

Aliases: `ls`

| Option | Description |
| --- | --- |
| `--after <seq>` | exclusive cursor |
| `--limit <n>` | max events (1-1000) |
| `--issue <issue>` | only this issue (use the global --project to filter by project) |
| `--types <types>` | comma-separated event types, e.g. issue.created,issue.updated |

### `tracker event tail`

Follow new events as NDJSON (one event per line) until interrupted

| Option | Description |
| --- | --- |
| `--after <seq>` | start after this seq (default: now) |
| `--interval <ms>` | poll interval (default: `1000`) |
| `--max <n>` | exit after this many events |
| `--issue <issue>` | only this issue (use the global --project to filter by project) |
| `--types <types>` | comma-separated event types, e.g. issue.created,issue.updated |

### `tracker webhook list`

List webhooks

Aliases: `ls`

### `tracker webhook create <url>`

Register a webhook; prints its signing secret (shown only now)

| Argument | Description |
| --- | --- |
| `url` | receiver URL (https) |

| Option | Description |
| --- | --- |
| `-e, --events <types>` | comma-separated event types, `<noun>.*` or `*` (default: `*`) |
| `--scope <project>` | only events from this project |
| `--description <text>` | what the webhook is for |
| `--inactive` | create it disabled |

### `tracker webhook view <id>`

Show a webhook

| Argument | Description |
| --- | --- |
| `id` | webhook id |

### `tracker webhook edit <id>`

Change a webhook; --enable re-activates an automatically disabled one

| Argument | Description |
| --- | --- |
| `id` | webhook id |

| Option | Description |
| --- | --- |
| `--url <url>` | receiver URL |
| `-e, --events <types>` | comma-separated event types, `<noun>.*` or `*` |
| `--scope <project>` | only events from this project; `all` removes the scope |
| `--description <text>` | description |
| `--enable` | activate |
| `--disable` | deactivate |

### `tracker webhook delete <id>`

Delete a webhook and its delivery log

Aliases: `rm`

| Argument | Description |
| --- | --- |
| `id` | webhook id |

### `tracker webhook rotate-secret <id>`

Replace the signing secret; prints the new one

| Argument | Description |
| --- | --- |
| `id` | webhook id |

### `tracker webhook test <id>`

Send a signed webhook.ping now and show the answer (exit 6 unless it was 2xx)

| Argument | Description |
| --- | --- |
| `id` | webhook id |

### `tracker webhook deliveries <id>`

Show recent deliveries, newest first

| Argument | Description |
| --- | --- |
| `id` | webhook id |

| Option | Description |
| --- | --- |
| `--status <status>` | pending \| succeeded \| failed \| dead |
| `--limit <n>` | page size (1-200) |

### `tracker webhook redeliver <delivery>`

Send a delivery again (with a fresh set of retries)

| Argument | Description |
| --- | --- |
| `delivery` | delivery id (whd_…) |

### `tracker user list`

List users

Aliases: `ls`

| Option | Description |
| --- | --- |
| `--include-deactivated` | include deactivated users |

### `tracker user view <user>`

Show a user

Aliases: `show`

| Argument | Description |
| --- | --- |
| `user` | handle, @handle, me or id |

### `tracker user create`

Create a user (admin). Give every agent its own user so its work is attributed.

| Option | Description |
| --- | --- |
| `--handle <handle>` | unique handle **(required)** |
| `-n, --name <name>` | display name **(required)** |
| `--email <email>` | email |
| `--kind <kind>` | human\|agent (default: `human`) |
| `--role <role>` | admin\|member (default: `member`) |

### `tracker user edit <user>`

Edit a user

| Argument | Description |
| --- | --- |
| `user` | handle or id |

| Option | Description |
| --- | --- |
| `-n, --name <name>` | display name |
| `--email <email>` | email |
| `--role <role>` | admin\|member (admin only) |
| `--deactivate` | deactivate (admin only) |
| `--reactivate` | reactivate (admin only) |

### `tracker auth login`

Store an API token for a server (verifies it first): auth login --server <url> --token <t> | --with-token

| Option | Description |
| --- | --- |
| `--with-token` | read the token from stdin |

### `tracker auth logout`

Forget the stored token for the server (--server or the current default)

### `tracker auth status`

Show how the CLI connects and who it acts as

### `tracker whoami`

Show the user the CLI acts as

### `tracker init`

Write .poietic-issues.json here from the global --server/--database, --project and --actor (never tokens)

| Option | Description |
| --- | --- |
| `--force` | overwrite an existing file |

### `tracker db migrate`

Apply pending migrations

| Option | Description |
| --- | --- |
| `--down` | revert the newest applied migration instead (one step; drops its tables and columns, so back up first; never reverts the first migration) |

### `tracker db status`

Show applied and pending migrations

### `tracker db bootstrap`

Create the first admin of a fresh installation (migrating if needed)

| Option | Description |
| --- | --- |
| `--handle <handle>` | admin handle, e.g. ada **(required)** |
| `--name <name>` | display name **(required)** |
| `--email <email>` | email address |

### `tracker db seed`

Create demo users (ada admin, grace, margaret, claude agent), public ENG with a linked repo, private OPS and sample issues

### `tracker serve`

Run the tracker server (API + web app if built) on the local database

| Option | Description |
| --- | --- |
| `--port <port>` | port (default: `3000`) |
| `--host <host>` | host (default: `127.0.0.1`) |

### `tracker schema [name]`

Print a JSON Schema: resources and inputs (use `project schema` for live per-project enums)

| Argument | Description |
| --- | --- |
| `name` | one of: issue, issue-create, issue-update, issue-move, issue-filter, comment, comment-create, link, link-create, project, project-create, view-create, view-config, event, problem (optional) |

### `tracker api <method> <path>`

Call any API endpoint directly and print the JSON response (like `gh api`)

| Argument | Description |
| --- | --- |
| `method` | GET, POST, PATCH, DELETE |
| `path` | path under /api/v1, e.g. /issues/ENG-1 |

| Option | Description |
| --- | --- |
| `--input <json|@file|->` | request body (JSON) |
| `-f, --field <key=value>` | body field (repeatable; values parsed as JSON when possible) |
| `--query <key=value>` | query parameter (repeatable) |

### `tracker commands`

Describe every command, option, exit code and error code (use --json for agents)

