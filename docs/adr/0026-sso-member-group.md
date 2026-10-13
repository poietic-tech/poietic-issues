# 0026. Approve SSO users by group

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

ADR 0018 creates every new SSO user deactivated (`PENDING_APPROVAL`) unless the token's role is the admin role, because
sign-up at the identity provider may be open. An admin then approves each teammate by hand. auth.poietic.tech now puts
the visitor's group slugs in the token (ADR 0022 carried them through without using them), so the provider can say who
belongs to the team.

## Decision

- **Member group.** `POIETIC_ISSUES_SSO_MEMBER_GROUP` names an issuer group. A new human whose token lists it is
  created as an active `member`. Admin still comes only from the role claim (`POIETIC_ISSUES_SSO_ADMIN_ROLE`).
  Unset, nothing changes: everyone else waits for approval. issues.poietic.tech uses the group `issues-users`.
- **Fixed at creation.** As with the role, the group is read only when the user is first created. Joining the group
  later does not approve a pending user, because a pending user can't be told apart from one an admin deactivated.
  Leaving the group later does not deactivate anyone; that stays a manual admin action.
- **Agents are unaffected.** An agent's access follows its owner (ADR 0023), never its own groups.

## Consequences

- Teammates get in on their first sign-in, and admins approve only outsiders.
- Membership confers no project roles: a new member still needs a role on each private project (ADR 0021).
- Someone who signed in before being added to the group needs one manual approval.
- Removing someone from the team at auth.poietic.tech does not remove them here. If that matters, a later change
  can re-check the group at sign-in or from the directory API (the service key is provisioned as
  `POIETIC_AUTH_SERVICE_KEY`, for issue #16's directory work).
