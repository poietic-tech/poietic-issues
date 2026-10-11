# Using the tracker from an AI agent

This guide is for agent harnesses, such as Claude Code or custom loops, that manage work through the `poietic-issues` CLI or the API. For working _on_ this repository, see [AGENTS.md](../AGENTS.md).

## Setup (once per environment)

```sh
# Remote server (shared tracker)
export POIETIC_ISSUES_SERVER=https://tracker.example.com
export POIETIC_ISSUES_TOKEN=trk_…            # token of the agent's own user (kind=agent)
export POIETIC_ISSUES_PROJECT=ENG
export POIETIC_ISSUES_FORMAT=json            # machine output everywhere

# …or local mode against a SQLite file, acting as a named agent user
export POIETIC_ISSUES_DATABASE_URL=sqlite:/path/to/tracker.db POIETIC_ISSUES_ACTOR=claude
```

Give every agent its own user (`poietic-issues user create --kind agent …`), so history shows who did what. Give every agent user a role on each private project it works in: `poietic-issues project members add @agent --role editor -P <KEY>`. Without a membership, a private project returns exit code 3 (not found), and a public one is read-only. A user created after the upgrade has no memberships, and admins always have full access. See [ADR 0021](adr/0021-project-visibility-and-roles.md).

In remote mode without a token (`POIETIC_ISSUES_TOKEN` unset and none stored by `auth login`), the CLI reads as anonymous: public projects can be read, private projects return exit code 3 (not found), writes fail with exit code 5 (`UNAUTHENTICATED`), and `poietic-issues auth status` reports "Not signed in". A missing token therefore looks like missing access, so check `auth status` first. A token that is invalid, expired or revoked is rejected outright instead (401).

Committing a `.poietic-issues.json` (`poietic-issues init --project ENG --server …`) in a repository lets any agent working there find the right project.

### Acting as a poietic.tech agent

On a server configured for poietic.tech SSO, an agent can act with its own poietic.tech identity instead of a `trk_` token. Create the agent at auth.poietic.tech/account/agents, then set its token where the harness runs:

```sh
export POIETIC_ISSUES_SERVER=https://issues.poietic.tech
export POIETIC_AGENT_TOKEN=pat_…             # never in a repository or a browser bundle
```

In remote mode the CLI exchanges `POIETIC_AGENT_TOKEN` with auth.poietic.tech for a ten-minute identity token, sends that to the server, and ignores `POIETIC_ISSUES_TOKEN`. `poietic-issues auth status` shows `(agent)`. On its first request, the server creates the agent as a `kind: agent` member owned by you. You must have signed in to the tracker at least once, and the agent is active when your account is. Like any member, it needs a role on each private project it works in. A malformed token exits with code 2. A revoked or expired token exits with code 5. The CLI never prints the token. See [ADR 0023](adr/0023-agent-identities.md).

### issues.poietic.tech identities

Interactive and unattended agents use separate users, so history shows which one acted and each token can be revoked on its own:

- **`claude`**: Claude sessions a person drives on their own machine. Store its token locally with `poietic-issues auth login --server https://issues.poietic.tech --with-token` (reads stdin), never in CI.
- **`github-ci`**: GitHub Actions workflows in any `poietic-tech` repository. The org provides its token as the secret `POIETIC_ISSUES_TOKEN` and the server as the variable `POIETIC_ISSUES_SERVER`:

  ```yaml
  env:
    POIETIC_ISSUES_SERVER: ${{ vars.POIETIC_ISSUES_SERVER }}
    POIETIC_ISSUES_TOKEN: ${{ secrets.POIETIC_ISSUES_TOKEN }}
  ```

  The CLI is not published yet, so a workflow either calls the API with `Authorization: Bearer $POIETIC_ISSUES_TOKEN` or builds the CLI from this repository.

Both agents see only the private projects they are members of.

## Learn the surface in two calls

```sh
poietic-issues commands --json      # all commands/options/exit codes
poietic-issues project schema       # valid statuses, labels, repos, assignable users, custom fields
```

## Recipes

```sh
# Pick up work
poietic-issues issue list --assignee me --category unstarted,started --sort priority --fields key,title,status.name,priority

# Claim and start an issue, guarding against concurrent edits
v=$(poietic-issues issue view ENG-42 --fields version | jq .version)
poietic-issues issue edit ENG-42 --assignee me --status "In Progress" --if-version "$v"

# Break work down
poietic-issues issue create -t "Write migration" --parent ENG-42 -l chore -q      # prints ENG-43

# Report progress with markdown from a file or stdin
poietic-issues comment add ENG-42 --body-file - <<'MD'
Implemented the migration. Tests: `pnpm test` ✅
MD

# Record links to external artifacts
poietic-issues issue edit ENG-42 --meta github.pr=https://github.com/acme/app/pull/12 --meta agent.session=abc123

# Relate work
poietic-issues link add ENG-43 blocks ENG-42

# Finish
poietic-issues issue edit ENG-42 --status "In Review"
```

## Reacting to changes

- **Polling:** keep the last `seq` you processed and call `poietic-issues event list --after <seq>`. The log is commit-ordered, so no event is ever skipped.
- **Streaming:** `poietic-issues event tail --types issue.updated,comment.created` prints one JSON event per line.
- **Push:** an admin can register a webhook (`poietic-issues webhook create URL --events 'issue.*'`) so your service is called on each event. See [events.md](events.md#webhooks).
- **Payload:** each event carries the full resource snapshot, plus `changes: { field: { from, to } }` for updates, so a refetch is never needed.

## Handling failures

Branch on the exit code, not the message text:

| Exit | Do                                                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------------------- |
| 2    | Fix the input (stderr JSON has `errors[]` with field paths). Don't retry unchanged.                               |
| 3    | The reference is wrong; list or search to find the right one.                                                     |
| 4    | Someone else changed it (`VERSION_MISMATCH`) or it already exists (`CONFLICT`). Refetch, re-decide, retry.        |
| 5    | Credentials or permissions. Stop and report.                                                                      |
| 6    | Transient (server down) or setup (`poietic-issues db migrate`). Retrying later is safe: mutations are idempotent. |
