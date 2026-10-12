# 0025. Short, renewed SSO sessions

- **Status:** Accepted
- **Date:** 2026-10-11

## Context

`POST /auth/sso` traded the issuer's cookie for an ordinary 30-day tracker session (ADR 0018). Since issue #20 it
asks the issuer's `/session/live` first, so a revoked or signed-out issuer session can no longer start a tracker
session. A tracker session that already existed still lasted its 30 days, though: signing out of poietic.tech, or an
admin ending a session there, did not reach the tracker. The tracker can't re-ask the issuer about such a session
later, because the issuer's JWT it was minted from expires in minutes, and the issuer answers `/session/live` only
for a token it can verify.

## Decision

- **Short sessions.** A session from `POST /auth/sso` lasts `POIETIC_ISSUES_SSO_SESSION_MINUTES` (default 15) instead
  of 30 days. `AuthConfig.sso.sessionSeconds` tells clients. Token and dev logins keep 30 days.
- **Renewal is a fresh sign-in.** The web app renews by doing what it does to sign in: it calls the issuer's refresh
  URL, which renews the issuer cookie only while that session is live, then `POST /auth/sso`, which re-verifies the
  JWT and re-checks liveness. A renewal replaces the session the request carries, and a renewal the issuer refuses
  deletes it, so the old cookie stops at once. Creating a session also drops the user's expired ones.
- **When the web app renews.** It renews once half the lifetime has passed, checking every minute and when the tab
  becomes visible, regains focus or comes back online. It renews only a session that came from SSO, remembered
  in `localStorage`, never one from a token or dev login: the browser's SSO cookie could be someone else's.
  A session that lapses anyway (a sleeping laptop) is renewed on the next check, and cached data is refetched.
  An API call that gets 401 meanwhile goes to the sign-in page, whose automatic SSO attempt returns the visitor
  to where they were.
- **Live streams end with their credential.** `GET /events/stream` closes when the session or identity token it
  authenticated with expires. The browser reconnects with whatever cookie it holds by then, so a revoked person's
  open tab stops receiving events.
- **Fail closed.** A renewal that can't reach the issuer fails like any SSO sign-in (503), and the session lapses
  at its expiry. Someone signed in drops to anonymous until the issuer answers again. Public projects stay
  readable meanwhile.

## Consequences

- Ending a session at the issuer ends the tracker session within one lifetime (15 minutes by default). Agents'
  writes were already bounded (ADR 0023). A stolen tracker cookie is worth one lifetime, not 30 days.
- Each open, signed-in tab costs a refresh call to the issuer and a `POST /auth/sso` (with a liveness check)
  every half-lifetime.
- An issuer outage longer than one lifetime signs everyone who used SSO out of the tracker.
- Sessions issued before this change lasted 30 days and carry no SSO marker, so the web app could not renew them.
  Migration `0006_end_sso_users_sessions` deletes every session of a user with an SSO identity once. People who
  use SSO are signed in again from the sign-in page, silently while their issuer session is live. Sessions of
  users without an SSO identity (token or dev login only) are kept.
