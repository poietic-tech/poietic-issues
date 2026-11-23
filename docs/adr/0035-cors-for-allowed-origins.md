# 0035. CORS with credentials for the allowed origins

- **Status:** Accepted
- **Date:** 2026-11-23

## Context

Other poietic.tech sites want to file issues as the signed-in person straight from the browser. The first is the
newsroom (`https://newsroom.poietic.tech` and its staging site), which files reader feedback into a project. The
browser already holds the shared `.poietic.tech` SSO cookie, so the page can do what the tracker's own web app does:
`POST /api/v1/auth/sso` for a tracker session, then call the API with that session cookie. The tracker sent no CORS
headers, so the browser hid every answer from the page, and refused outright any request that needs a preflight, such
as a JSON `POST`.

The tracker already had one list of trusted browser origins: `POIETIC_ISSUES_ALLOWED_ORIGINS`, the CSRF allow-list.
An origin on it may already send cookie-authenticated writes, including `POST /auth/sso`.

## Decision

- The `/api/v1/*` routes answer CORS for exactly the origins in `POIETIC_ISSUES_ALLOWED_ORIGINS`, compared as exact
  strings. There is no second list and no wildcard. An allowed `Origin` is echoed in `Access-Control-Allow-Origin` with
  `Access-Control-Allow-Credentials: true`, `Access-Control-Expose-Headers: ETag, Location, X-Request-Id` and
  `Vary: Origin`, on every response including problem responses.
- A preflight (`OPTIONS` with `Access-Control-Request-Method`) from an allowed origin is answered 204 before
  authentication. It allows the API's methods (`GET, HEAD, POST, PUT, PATCH, DELETE`) and the request headers its
  clients send (`Content-Type, Authorization, X-Change-Reason, If-Match, Idempotency-Key, X-Request-Id`), cached for
  10 minutes.
- Any other origin, and a request without one, gets no CORS headers and is handled exactly as before. API responses
  carry `Vary: Origin` whenever the list is not empty, because they differ by origin.
- The whole API, not a list of routes. An allowed origin could already write anything the person can write; CORS only
  adds reading the answers. A route list would not narrow that trust. It would only break a client when it needs one
  more route (labels, comments, the issue it just created), and keeping the list in step would be one more thing to
  get wrong. The web app's paths and the health probes get no CORS headers.
- The CSRF check is unchanged. CORS decides only whether the browser shows the page the answer. Whether a
  cookie-authenticated write is accepted is still `sameOrigin()`.

## Consequences

- A page on an allowed origin can act as the signed-in person in every way the API allows them, and read what they
  can read. Add an origin only for a site you trust as much as the tracker itself, and only with `https://`.
- This works with cookies only for origins that are same-site with the tracker (the same registrable domain, such as
  any `*.poietic.tech`). The session cookie is host-only and `SameSite=Lax`, so a browser sends it on a same-site
  `fetch(…, { credentials: 'include' })` but not on a cross-site one. A cross-site origin on the list gets CORS headers
  but still has no session; it would need an identity token in `Authorization` instead.
- A session from a cross-origin `POST /auth/sso` is the same browser-wide cookie the tracker's tab uses, so it replaces
  that tab's session (the tab keeps working with the new one).
