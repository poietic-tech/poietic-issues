# 0027. The SSO directory owns who people are

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

The tracker learned about people only when they signed in, and kept the name from their first token for good
(ADR 0018). Two problems followed: nobody could be assigned or added to a project before their first visit, and a
name or avatar changed at auth.poietic.tech never reached the tracker. auth.poietic.tech serves a read-only directory
of users and groups to services holding a service key (`@poietic-tech/auth`'s `PoieticAuthApi`). The decision for
issue #16 was that auth should act as the user service, with the tracker calling its API for user data.

The tracker can't drop its own `users` table. Assignees, authors, events, project roles and tokens reference it;
local mode, the browser demo and deployments without SSO have no directory; and history must survive the directory
being slow or a person leaving.

## Decision

- **Local users are the directory's cache.** With a service key configured, `GET /users` (signed in) first refreshes
  from the directory, then lists local users as before. Every user linked to the issuer takes the directory's name
  and avatar, and a `user.updated` event records each change. A human in the approval group (ADR 0026) who has never
  signed in is created as an active member, linked by subject, so their first sign-in finds them.
- **Nothing else follows the directory.** Role, activation and handle stay the tracker's. The refresh never
  deactivates or reactivates anyone, and never creates agents (they are created on first use, ADR 0023).
- **Bounded and failing open.** A refresh runs at most every five minutes (a failure is retried after one minute),
  one at a time, and each directory request times out after five seconds. If the directory is unreachable or
  answers malformed data, the failure is logged and the local users are served unchanged.
- **Why not resolve profiles at display time, or create users only when first referenced.** Either would put the
  directory on the path of every page that shows a person, or push placeholder ids for not-yet-created people through
  the API, the web app and the CLI. Refreshing the cache when people are listed gives the same result for the
  assignee picker, the member picker and the CLI, with no new reference type.
- **Configuration.** `POIETIC_ISSUES_SSO_DIRECTORY_KEY` (a secret) turns it on; `POIETIC_ISSUES_SSO_DIRECTORY_URL`
  defaults to the issuer's origin. Without a key nothing changes.

## Consequences

- People can be assigned before they first sign in, and names and avatars stay current. ADR 0018's "name fixed at
  creation" now holds only without a directory.
- A name edited in the tracker is overwritten by the next refresh. With a directory, edit names at auth.poietic.tech.
- Someone created from the directory starts as a member even if their role at auth is admin, because the directory
  doesn't report roles. An admin promotes them by hand.
- Events and webhook payloads keep the name a person had when each event happened.
- The directory has no search, so each refresh pages through every user. That is fine at team size; a larger
  directory would want an incremental API.
