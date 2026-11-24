# 0037. Attachments can be stored in artifacts.poietic.tech

- **Status:** Accepted
- **Date:** 2026-11-24

## Context

Attachment bytes live in the tracker's own R2 bucket, reached through the S3 driver. artifacts.poietic.tech is now
the platform's shared place for files: one index, deduplicated by SHA-256, and reachable by other services through
grants. Until now, though, it let every signed-in caller read every collection, which would expose the attachments of
private projects (ADR 0021) to anyone signed in.

poietic-artifacts now has restricted collections (`read: grants`). Only admins and holders of a user or group grant
can see such a collection; everyone else gets 404 on every route, and is never shown it in a list or search. Grants
work as they do on any other collection.

## Decision

- **Artifacts is a storage layer, not an access model.** Attachments go in one restricted collection,
  `issues-attachments`. Its only grant is `editor` for the tracker's own agent at auth.poietic.tech. Artifacts learns
  nothing about projects, issues, comments or uploaders: every access decision stays in the tracker, which streams the
  bytes itself (there are no presigned URLs). An admin can still grant a person or agent read access to the collection
  directly, as with any other service's collection.
- **A third blob store.** `POIETIC_ISSUES_BLOB_STORE=artifacts` stores each blob under its existing key as an artifact
  name in the collection (`POIETIC_ISSUES_ARTIFACTS_COLLECTION`, default `issues-attachments`), acting as the agent whose
  token is `POIETIC_ISSUES_ARTIFACTS_AGENT_TOKEN`. It is a separate variable from `POIETIC_AGENT_TOKEN`, so the operator
  tool never mixes up its caller and the tracker.
- **Moving without downtime.** `POIETIC_ISSUES_BLOB_FALLBACK=s3` reads the old bucket when artifacts has no such key.
  Writes and deletes go to artifacts only, so the old bucket is read-only from then on.
  `poietic-issues-admin blobs copy --from s3 --to artifacts` copies every key in the bucket, skipping keys that
  artifacts already holds with the same SHA-256 and checking the hash after each upload. It reads the bucket, not the
  database, so it can run from anywhere with both sets of credentials, and it is safe to re-run. Once a run copies
  nothing and fails nothing, the fallback can be removed and the bucket retired.
- **issues.poietic.tech** switches when the GitHub `production` secret `POIETIC_ISSUES_ARTIFACTS_AGENT_TOKEN` is set:
  the deploy passes it to the Worker as `ARTIFACTS_AGENT_TOKEN`, and the container then uses artifacts with the R2
  fallback.

## Consequences

- Attachments join the platform's file index without becoming readable outside the tracker.
- **Deletes are soft in artifacts.** Deleting an attachment removes it from the collection, but its bytes stay in
  artifacts' bucket (until a sweep, which artifacts does not have yet). With the S3 store, deleting removed the bytes.
- Downloads always stream through the tracker, which costs it bandwidth that presigned S3 URLs avoided.
- The tracker depends on artifacts.poietic.tech and auth.poietic.tech being reachable for uploads and downloads.
- The tracker's agent token is a long-lived production secret; it must be rotated at auth if it leaks.

## Alternatives considered

- **Keep the tracker's own R2 bucket.** Simplest, and it already works, but attachments would stay outside the
  platform's index.
- **Mirror the tracker's access rules in artifacts** (per-project collections, grants kept in sync). Two copies of
  access logic that would drift, against poietic-dot-tech ADR 0001.
- **Encrypt in the tracker and store ciphertext** in an unrestricted collection. It needs no change to artifacts, but
  the files are unusable outside the tracker, and losing the key loses every attachment.
