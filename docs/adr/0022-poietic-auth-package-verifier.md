# 0022. Verify SSO tokens with `@poietic-tech/auth`

- **Status:** Accepted
- **Date:** 2026-10-11

## Context

ADR 0018 verified the SSO cookie with a verifier vendored from poietic-dot-tech `packages/identity/verify.ts`, to
avoid a dependency. auth.poietic.tech now publishes that verifier, together with its directory API and agent client,
as `@poietic-tech/auth`. The vendored copy had already fallen behind: it does not read the `groups`, `kind` and
`owner` claims that group-based approval and agent identities (issues #16 and #20) build on.

## Decision

- **Verification** (supersedes the "no new dependency" part of ADR 0018). `POST /auth/sso` verifies the cookie with
  `verifyIdentityToken` from `@poietic-tech/auth` (pinned to `^0.2.1`). The package is dependency-free (WebCrypto and
  `fetch`) and is bundled into `dist/server.mjs` like any pure-JS dependency. The vendored `sso/jwt.ts` is deleted.
- **A thin wrapper stays.** `apps/server/src/sso/verifier.ts` binds the issuer, audience and JWKS URL from config and
  adds a 5-second timeout to JWKS fetches, which the package does not have.
- **Claims.** The token's `groups` are passed to `SsoIdentity`. They are carried only: access is still decided by the
  `role` claim, as in ADR 0018, until group-based approval is designed.
- The rest of ADR 0018 is unchanged: identity mapping, pending approval, and `POST /auth/sso` as the
  cookie-to-session exchange.

## Consequences

- Claim validation tracks auth.poietic.tech. Tokens now also need a string `sid`; well-formed `groups`, `kind` and
  `owner` claims, when present; and absent `groups` read as `[]`.
- The package caches JWKS in module scope, so one server process verifies for one issuer (the config already allows
  only one). Its tests reset that cache by re-importing the module (`vi.resetModules`, with the package inlined).
- Two small differences from the vendored copy: a JWKS response with no usable keys now replaces the cache instead
  of being ignored, and empty `sub`, `role` and `name` strings are accepted (the core falls back to the handle and
  name `user` and `User`).
- Upgrades come through npm. If the package diverges from what a non-poietic issuer needs, the escape hatch is to
  vendor it again behind the same `SsoVerifier` interface.
