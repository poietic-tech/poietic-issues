# 0028. SSO only, and the CLI as a `poietic-tech` module

- **Status:** Accepted
- **Date:** 2026-10-19

## Context

poietic.tech is one toolkit, with `poietic-tech` (`@poietic-tech/cli`) as the host command and one login at
auth.poietic.tech. poietic-issues still had its own command, its own credential (`trk_` API tokens, ADR 0009), its
own config file and its own output and exit-code conventions, and the CLI could not be installed outside this
repository. ADR 0023 kept `trk_` tokens for non-SSO deployments and CI jobs without an agent token.

issues.poietic.tech is the only deployment that matters. A self-hosted deployment without auth.poietic.tech is no
longer a goal.

## Decision

- **`trk_` is retired.** Migration `0007_drop_api_tokens` drops `api_tokens`. The token routes
  (`/users/{user}/tokens`, `/tokens/{id}`, `/auth/token-login`), the token half of `bootstrapAdmin`, the web login's
  paste-a-token form and the `trk_` security scheme are removed. A bearer value is always an identity token: it is
  verified when SSO is configured and is a 401 otherwise, and it never falls back to the cookie. People and agents
  reach the API only through an auth.poietic.tech identity (ADR 0023). A CI job is an agent with its own
  `POIETIC_AGENT_TOKEN`.
- **The remote CLI is a `poietic-tech` module,** `@poietic-tech/issues`, run as `poietic-tech issues …`. It has no
  `bin`, holds no credential and has no local mode. It follows the host's formats (`--json`, `--format`, `-q`,
  `POIETIC_TECH_FORMAT`), exit codes, error rendering and identity rules (`POIETIC_IDENTITY`,
  `POIETIC_AGENT_TOKEN`). Its server is https://issues.poietic.tech, and an override must be https on a
  `*.poietic.tech` host, because that is where the host may send an identity token.
- **The module builds every command from the host's `commander` objects,** and its bundle contains no commander
  code, so a version skew between the two copies cannot break parsing. A test inspects the built file and loads it
  through the real host.
- **Local mode remains only in the operator tool,** `poietic-issues-admin` (`pnpm issues-admin …`, and a binary in
  the Docker image). It runs the same command tree over the in-process app in trusted mode, plus
  `db migrate|status|bootstrap|seed` and `serve`. It is never published.
- **Releases are tag-driven.** A tag `issues-v<semver>` publishes the module to npm through trusted publishing
  (`docs/releases.md`).
- **The two command hosts share one command tree,** written once against a small runtime interface (API client,
  output sink, project resolver, way to fail with a code).

## Consequences

- Existing `trk_` tokens stop working when the deploy runs migration 0007. Nothing outside this repository was
  found using them. The old `claude` and `ci` users keep their history and are not merged into their new SSO agents.
- The `poietic-tech` host has no conflict exit code, no raw output channel and no text block in table output, so
  the module works around each: conflicts exit 2 under their own machine code (`conflict`, `version_mismatch`, …);
  raw commands (`event tail`, `attachment download`, `schema`, `api`, `commands`, `fields describe`) print the same
  bytes whatever the format; and `issue view` inlines the description in table format. A JSON list carries no
  `nextCursor` (the hint goes to stderr; use `--all`), and `-q` on a single item prints the id. Each is a follow-up
  in the host.
- The JSON shape of the CLI's output changed to the host's. This is accepted because the CLI was never published.
- A stack without SSO, such as `docker compose up`, can no longer be called remotely or signed in to. Operators use
  `poietic-issues-admin` inside the container.
- Trusted mode and dev login stay for development, tests and the operator tool, and are never for remote callers in
  production.
- ADR 0023's last sentence, keeping `trk_` for non-SSO deployments and CI, is superseded by this decision.
