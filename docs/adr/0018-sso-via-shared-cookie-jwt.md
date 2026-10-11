# 0018. SSO via a parent-domain cookie JWT

- **Status:** Accepted; the vendored verifier is superseded by [0022](0022-poietic-auth-package-verifier.md)
- **Date:** 2026-10-07

## Context

The tracker is deployed under a domain whose identity service (for poietic.tech, `auth.poietic.tech`) sets a
short-lived ES256 JWT in a cookie scoped to the parent domain and publishes its public keys as JWKS. ADR 0009
anticipated a real login "issuing the same sessions". Sign-up at such a provider may be open, and the tracker has no
per-project permissions, so a verified identity alone must not grant access.

## Decision

- **Verification.** When `TRACKER_SSO_ISSUER` is set, `POST /auth/sso` reads the issuer's cookie and verifies the JWT
  (ES256 only, `iss`, `aud`, `exp`, `iat`) against the JWKS with WebCrypto. There is no new dependency: the verifier
  is adapted from poietic-dot-tech `packages/identity/verify.ts`.
- **Identity mapping.** Identities are stored in `user_identities(issuer, subject)`. The first sign-in creates a
  human user with a handle derived from the token's name.
- **Access.** The token's role equal to `TRACKER_SSO_ADMIN_ROLE` makes a new user an active admin. Anyone else starts
  deactivated (`PENDING_APPROVAL`) until an admin runs `tracker user edit <handle> --reactivate`. Role and name are
  fixed at creation and never re-derived from later tokens.
- **Sessions.** Success issues the ordinary `tracker_session`. Tokens and sessions are otherwise unchanged.

## Consequences

- One login across the parent domain, with a lapsed cookie renewed by the provider's refresh endpoint before
  signing in.
- Signing out of the provider does not end an existing tracker session (30 days). Revisit with a shorter SSO session
  TTL or a liveness check if that matters.
- Nothing here is poietic-specific; any issuer with a cookie JWT and JWKS works. OIDC redirect flows would be a
  separate mode.
