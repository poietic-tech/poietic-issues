# 0023. Agent identities from SSO identity tokens

- **Status:** Accepted
- **Date:** 2026-10-11

## Context

auth.poietic.tech issues agents: identities owned by a person, which act with a ten-minute identity token sent as
`Authorization: Bearer` (the agent's own `pat_…` secret is exchanged for it and never reaches a service). The
token carries `kind: "agent"` and the owner's subject. Before this, each tracker agent was a hand-made user with a
`trk_` API token, managed separately from the person it acts for.

## Decision

- **Precedence.** A bearer value starting with `trk_` is an API token, as before. With SSO configured, any other
  bearer value is an identity token, verified like the SSO cookie (ADR 0022). The header decides on its own: an
  invalid value is a 401, and the request never falls back to the session cookie. Identity tokens are not ambient
  credentials, so they are exempt from the same-origin check (`authVia: 'identity'`).
- **Provisioning.** The first request from an unknown agent creates a `kind: 'agent'` user, with role `member`
  whatever the token's role says. Its `users.owner_id` is the tracker user mapped from the token's `owner` through
  `user_identities`. The agent is created active when that owner is active, and pending otherwise. An agent whose
  owner has never signed in is refused, so there are no orphan agents. Humans may also send identity tokens; they
  are resolved as `POST /auth/sso` resolves them.
- **Owner liveness.** A known agent may act only while it and its owner are both active. Deactivating a person
  stops their agents without touching each one.
- **No browser sessions for agents.** `POST /auth/sso` refuses agent identities.
- **CLI.** In remote mode, `POIETIC_AGENT_TOKEN` (read with `agentFromEnv` from `@poietic-tech/auth`) takes the
  place of a `trk_` token. The CLI never prints the token.

## Consequences

- An agent is attributed to its owner in data (`User.ownerId`), and its access follows the owner's account status.
  Project access does not follow automatically: like any new member, an agent needs a role on each private project
  (ADR 0021).
- A revoked agent token keeps working for reads until the identity token it was exchanged for expires (ten
  minutes). Writes check liveness with the issuer when `POIETIC_ISSUES_SSO_LIVENESS_URL` is set (issue #20 step 5):
  each `POST`/`PUT`/`PATCH`/`DELETE` made with an identity token asks `GET /session/live` with that token, and a
  `{ "live": false }` answer is a 401. Answers are cached per token for 30 seconds against the injected clock, so
  a revocation stops writes within about 30 seconds at the cost of one issuer round trip per token per half-minute.
  Reads are not checked: the window there is the token's lifetime, and a read leaks nothing the agent could not
  have read a minute earlier.
- The liveness check **fails closed**. An issuer that can't be reached within 5 seconds, or answers anything but
  200 `{ "live": boolean }`, makes the write a 503 `UNAVAILABLE`, matching how an unreachable JWKS is treated.
  Failing open would let a revoked agent keep writing whenever the issuer is degraded, which is exactly when
  nobody is watching. The cost is that agents cannot write during an issuer outage longer than the cache, and
  nobody can start a new tracker session through `POST /auth/sso`, which asks the same question before trading the
  SSO cookie for one; people already signed in with a tracker session are unaffected.
- Each identity-token request verifies a JWT and reads `user_identities`. Known identities resolve without the
  write lock; only the first request from a new identity writes.
- `trk_` tokens remain the way to give a non-SSO deployment, or a CI job without an agent token, its own user.
