# @poietic-tech/issues

The issue tracker at [issues.poietic.tech](https://issues.poietic.tech), as a module of the `poietic-tech` command.
It runs as `poietic-tech issues …`, signed in with the shared poietic.tech login. Nothing prompts, so it suits AI
agents as much as people.

## Install

```sh
npm i -g @poietic-tech/cli @poietic-tech/issues
```

Install both. A global install of the module alone does not put `poietic-tech` on your PATH. The host finds the
module on its own; there is nothing to configure. It needs Node 22.12 or later.

## Sign in

```sh
poietic-tech login
poietic-tech issues whoami        # the tracker account you act as
```

## Set up a project

In a repository, record the project once and commit the file:

```sh
poietic-tech issues init --project ENG    # writes .poietic-issues.json (never a token)
poietic-tech issues issue list
poietic-tech issues issue create -t "Fix login" -p high -l bug
```

Without the file, pass `-P ENG` or set `POIETIC_ISSUES_PROJECT`.

## Act as an agent

- In a session you started, after `poietic-tech login`, set `POIETIC_IDENTITY=<agent>` to act as one of your agents.
- In a harness or CI job, set `POIETIC_AGENT_TOKEN=pat_…`. Create the agent with `poietic-tech agents create`.

An agent is a `kind: agent` member owned by you and needs a role on each private project it works in.

## Output and exit codes

The format and exit codes are the host's: `--json`, `--format table|json|ndjson|ids`, `-q`, and
`POIETIC_TECH_FORMAT`. Exit codes are in `poietic-tech help exit-codes`. Conflicts (`conflict`, `version_mismatch`)
exit 2 with their own machine code. `poietic-tech issues commands` prints every command, option and error code as
JSON.

The server is `https://issues.poietic.tech`. `POIETIC_ISSUES_SERVER` or `server` in `.poietic-issues.json` may
override it, but only with an https URL on a `*.poietic.tech` host.

More: [CLI guide](https://github.com/poietic-tech/poietic-issues/blob/main/docs/cli.md) and
[agents guide](https://github.com/poietic-tech/poietic-issues/blob/main/docs/agents.md).
