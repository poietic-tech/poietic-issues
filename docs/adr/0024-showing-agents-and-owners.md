# 0024. Showing agents and their owners

- **Status:** Accepted
- **Date:** 2026-10-11

## Context

ADR 0023 records an SSO agent's owner as `User.ownerId`. Readers should see who an agent acts for wherever the agent
appears: comment authors, the activity log, assignees, creators, member lists and the CLI's tables. Most of those
places hold a `UserSummary`, which had no owner, and signed-out visitors of public projects cannot list users, so
resolving `ownerId` against the user directory would leave them without it.

## Decision

- **The owner travels with the summary.** `UserSummary` (and so `User`) has `owner: { id, handle } | null`, filled
  by core with a join on `users.owner_id` wherever it builds a summary. It is optional in the contract because issue
  snapshots stored in older events lack it; readers treat a missing owner as none.
- **One formatter.** `formatActor` in `packages/schema` renders `Ada bot · agent · owned by @ada` (or `@ada-bot · …`
  with `label: 'handle'`, for the CLI), and `agentNote` renders the suffix alone for places that style it apart.
  It lives in `schema` rather than `core` because the web app bundles `schema` and never `core`. The CLI and the web
  app use only these to describe an actor.

## Consequences

- Every summary-building query joins `users` a second time for the owner's handle.
- Agents created through the API (not SSO) have no owner and read as `Name · agent`.
