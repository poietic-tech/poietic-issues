# 0031. Identity is global; access is layered

- **Status:** Proposed. Needs a handle and a directory disabled state in auth.poietic.tech (see "What auth must provide").
- **Date:** 2026-11-01

## Context

auth.poietic.tech already owns who people and agents are. The tracker keeps a local `users` row per identity, linked by
`user_identities(issuer, subject)` (ADR 0018), and the directory refresh keeps its name and avatar current (ADR 0027).
Several identity facts are still decided locally, though, and each has caused friction:

- **Handles.** The tracker derives a handle from the display name on first use and adds `-2`, `-3`, … on a collision.
  The SSO agent **Claude** became `claude-2` because a legacy pre-SSO account held `claude`. Any other subsystem that
  derives handles the same way can name the same identity differently.
- **Activation.** Approval and deactivation are local. Someone removed at auth stays active here (ADR 0026), and
  joining the approval group later does not approve a pending user.
- **Access.** Group claims are read once, at creation. Every project role is a hand-made membership, so each new agent
  needs a membership on each private project before it can see anything (ADR 0021, ADR 0023).

## Decision

### The local user is a cache of the global identity

The `users` table stays: issues, comments, events and memberships reference it by foreign key, history must outlive a
deleted identity, the tracker keeps serving when auth is unreachable (ADR 0027 fails open), and pre-SSO accounts have
no identity to link. What changes is who owns each field:

| Field             | Owner for a linked user              | Owner for an unlinked (legacy) user |
| ----------------- | ------------------------------------ | ----------------------------------- |
| Handle            | auth (copied on sign-in and refresh) | tracker (ADR 0030 renames)          |
| Name, avatar      | auth (already, ADR 0027)             | tracker                             |
| Global admin      | auth role claim, re-read each time   | tracker                             |
| Active / disabled | auth, with a local veto (below)      | tracker                             |
| Owner (agents)    | auth (already, ADR 0023)             | none                                |
| Project roles     | tracker, plus group grants (below)   | tracker                             |
| Email             | tracker (auth never shares it)       | tracker                             |

### Global handles

- auth.poietic.tech gives every person and agent a unique `handle` that already passes `HandleSchema` (2–39 of
  `a-z`, `0-9`, `-`, `_`), carried in the identity token and the directory.
- The tracker copies it on sign-in and on each directory refresh, recording `user.updated` with `handle: { from, to }`
  as ADR 0030 does. `PATCH /users/{user}` refuses `handle` for a linked user, since the next refresh would undo it.
- **Collisions** can only be with an unlinked account, because auth handles are unique. The linked identity wins: the
  unlinked account is renamed to `<handle>-legacy` (then `-legacy-2`, …) in the same transaction, with its own
  `user.updated` event. Ids don't change, so its history stays intact.
- Until auth sends a handle, the tracker keeps deriving one as today.

### Activation follows auth, with a local veto

- A disabled identity is deactivated here on the next refresh, and an identity token from it is refused.
- An admin can still deactivate a linked user locally. Local reactivation can't override a disabled identity.
- The two causes are stored apart (`deactivated_at` plus a reason, `admin` or `directory`), so the tracker can tell a
  user an admin removed from one the directory removed. That distinction is what ADR 0026 lacked, so the approval
  group can now be re-read on each refresh: joining it approves a pending user, and leaving it deactivates them with
  reason `directory`. An agent still follows its owner (ADR 0023) as well as its own state.

### Access in three layers

1. **Entry and global admin come from auth.** The approval group (`issues-users`) and the admin role claim decide
   who can sign in and who is a global admin. They are re-read rather than fixed at creation.
2. **Project roles stay local** (ADR 0021). Only the tracker knows its projects, and `viewer`/`editor`/`manager` stay
   its RBAC.
3. **Group grants are optional.** A project can grant a role to an auth group: `project_group_grants(project_id,
issuer, group, role)`, managed with `project members add --group <slug> --role editor`. A user's level is the
   highest of their direct membership and the grants for their current groups. An agent gets grants from **its own**
   groups at auth, not its owner's, so an agent can never reach more than it was put in. Global admins and the
   `NOT_FOUND`-for-unreadable rule don't change.

A subsystem that doesn't want its own RBAC can rely on layers 1 and 3 alone. The tracker uses all three.

### What auth must provide

As of poietic-dot-tech `bc7be55`, auth has no username concept. A user has an opaque id, a provider `name`, an optional
`display_name` and an avatar. The GitHub `login` is dropped on purpose, so nothing downstream depends on a provider's
field. An agent's name is free text, unique only per owner and renameable, so two owners can both have a `claude`.
The token's `name` claim and the directory's users carry only these display names.

- **Missing: a handle.** A new globally unique, handle-safe `handle` column for people and agents (agents included,
  so the per-owner name rule isn't enough), chosen at sign-up or agent creation, in the token and `/api/users`.
- **Partly there: disabled state.** Agents have `agent_profiles.disabled_at`, but `/api/users` doesn't expose it, and
  people have no disabled state. The directory needs one for both.
- **Already there: agent groups.** Tokens and `/api/users` carry each user's own groups, agents included, and an
  agent's token never carries its owner's role or groups. Layer 3 needs nothing new from auth.
- **Not wanted: email.** The token never carries email, and the directory doesn't send it. Email stays local.

## Consequences

- An identity has one handle across the platform. Renames happen once, at auth. ADR 0030's rename stays for legacy
  accounts.
- Removing someone at auth removes them here within one refresh interval (five minutes, ADR 0027), or on their next
  request.
- A new agent added to the right group can work in a project with no tracker-side membership.
- Text that quotes an old handle (an `@mention`, a script) goes stale after an auth-side rename, as with ADR 0030.
- Refreshes now write more often, and a directory bug can deactivate users. The refresh must keep failing open: an
  unreachable or malformed directory changes nothing, and a response that would deactivate an unusual share of users
  at once is refused and logged.
- Other subsystems (Bridge, Meetings) can take the same split, so one identity looks the same everywhere.

## Alternatives considered

- **Keep identity facts local (status quo).** Simple, but it caused `claude-2`, and every subsystem would repeat the
  handle and activation logic and drift apart.
- **No local users; resolve every person from auth at read time.** That puts auth on the path of every page and
  breaks foreign keys and history for deleted identities. ADR 0027 already rejected it.
- **Grant agents their owner's groups.** Simpler to set up, but any agent would get its owner's full reach. Agents
  are scoped on their own.

## Rollout

1. auth.poietic.tech adds handles and a disabled state for people and agents in the directory.
2. The tracker reads `handle` and resolves collisions. One-off: give legacy accounts that block a linked identity's
   handle the `-legacy` suffix. `claude` → `claude-legacy` is the first.
3. Activation reasons and re-read entry and admin claims, with a test for each dialect.
4. `project_group_grants`, its API, CLI and OpenAPI.

Each step is its own change and works without the steps after it.
