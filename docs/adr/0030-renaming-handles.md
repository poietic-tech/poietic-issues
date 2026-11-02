# 0030. Admins can rename handles

- **Status:** Accepted
- **Date:** 2026-11-01

## Context

A handle was fixed when its user was created. SSO sign-in derives it from the display name and adds `-2`, `-3`, … on a
collision (ADR 0018, ADR 0023), so a stale account can keep a newer identity's natural handle for good. On
issues.poietic.tech the legacy pre-SSO agent `claude` left the SSO agent **Claude** with `claude-2`.

## Decision

- **Admin only.** `PATCH /users/{user}` takes `handle`, and `poietic-tech issues user edit <user> --handle <new>` sends
  it. Users can't rename themselves, and the system user can't be renamed.
- **Only unlinked users.** A user linked to an SSO identity takes its handle from the issuer on every sign-in and
  directory refresh (ADR 0031), so renaming them here is refused: rename them at the issuer.
- **Same rules as creation.** The new handle passes `HandleSchema` (lowercased). `me` and `system` are reserved, and a
  taken handle is a `CONFLICT`.
- **History follows the user.** Everything stores user ids, so issues, comments, memberships and events move with the
  rename. A `user.updated` event records `handle: { from, to }`. The old handle is free immediately.

## Consequences

- An admin can move a legacy account out of the way, or tidy the handles of accounts with no identity. Linked
  accounts already get the right handle from auth.
- Text that quotes a handle, such as an `@old` mention in a comment or a script that filters by handle, keeps the old
  spelling. Prefer ids where a reference must survive a rename.
