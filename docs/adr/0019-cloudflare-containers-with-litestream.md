# 0019. Cloudflare Containers with Litestream for issues.poietic.tech

- **Status:** Accepted
- **Date:** 2026-10-07

## Context

The tracker is hosted at issues.poietic.tech, a domain served entirely by Cloudflare Workers that OpenTofu creates
in benjamin-small/poietic-dot-tech. It is a long-running Node process with a native SQLite driver and SSE streams.
Containers have no persistent disk, Cloudflare offers no hosted Postgres, and D1 lacks interactive transactions.

## Decision

- Run the unchanged tracker image on Cloudflare Containers behind a Worker (`deploy/cloudflare`), as one instance
  (Durable Object id `main`, `max_instances: 1`).
- Keep the database as SQLite on the container disk, replicated by Litestream 0.5 to the R2 bucket
  `poietic-issues-db`. It is restored on a fresh disk and synced on SIGTERM. Attachments go to R2 over the S3 API.
- New dependencies: `wrangler`, `@cloudflare/containers` and `@cloudflare/workers-types` (deploy package only), and
  the Litestream binary pinned by version and SHA-256 in the image.
- Deploy from this repository's CI after CI passes on `main`.

## Consequences

- All infrastructure stays on Cloudflare, and the tracker code needs no changes.
- A crash (not a clean stop) can lose the last second or so of writes. A cold start restores before serving.
  Webhooks are delivered only while the container is awake.
- Exactly one writer: never raise `max_instances` or use more than one Durable Object id while on SQLite.
- Single writer during rollouts: a deploy must stop the old container (and let Litestream's final sync finish)
  before the new one restores. Verified live on 2026-10-07 (plan Task 6, Step 5a): Deploy run 37681019282
  (`workflow_dispatch`, same commit 1d4737a) built a new image digest, because builds aren't reproducible, so
  Wrangler rolled the container application from v1 to v2 (rollout 33ae8f42…, `rolling`, `full_auto`). The old
  instance's Litestream logged `litestream shut down` at 20:20:37.672Z. The new instance started (`VMStarted`) at
  20:20:41.148Z, logged `attempting restore before replication` at 20:20:41.886Z and `restore completed` at
  20:20:46.555Z, and caught up to the latest replica txid (0x0a). The order is stop-then-start, so no lease guard
  is needed. Re-check this if `max_instances`, the rollout policy or the scheduling policy changes. If it ever stops
  holding, the fallback is the spec's lease guard: the Worker holds a lease in Durable Object storage that the
  entrypoint checks before restoring.
- The Worker and the container image do not switch atomically. `wrangler deploy` makes the new Worker live before the
  container rollout replaces the image, so a sleeping container woken in between starts on the old image with the new
  Worker's environment. Seen live on 2026-10-08 in the rename deploy (Deploy run 37838113244, ADR 0020): the new
  Worker went live at 20:16:41Z and the rollout (2cc07f24…, `rolling`, `full_auto`) ran 20:16:59–20:17:33Z. From
  20:17:00.95Z to 20:17:19.03Z, about 18 seconds, the old image ran under the new Worker. It read only `TRACKER_*`
  while the Worker sent only `POIETIC_ISSUES_*`, so SSO, S3 attachment storage and allowed origins were briefly unset.
  No writes happened and no data was lost. Litestream was still stop-then-start: the old instance shut down at
  20:17:19.032Z and the new one's restore completed at 20:17:40.637Z at the latest replica txid (0x13). Rule: any
  change to the container's environment contract (`deploy/cloudflare/src/container-env.ts`) must work with both the
  previous and the new image for one deploy. For example, send both the old and the new variable names for a release,
  then drop the old ones.
- The opposite skew is possible too, and lasts until the container restarts. Seen live on 2026-11-23 (PR #58 added
  `EXTRA_ALLOWED_ORIGINS` for the newsroom; Deploy run 45216243087): the new Worker (b34f6bd8) was at 100% at
  16:26:09Z, the rollout stopped the old container at 16:26:52Z, and the Durable Object, still running the previous
  Worker version (d2fc16f0), started the new image at 16:26:53Z with the old environment (only
  `https://issues.poietic.tech` allowed). At 16:31:23Z the Durable Object reset to the new version and reattached to
  the running container, whose environment is fixed at start, and traffic kept it from sleeping. Newsroom CORS
  preflights got 401 until a manual redeploy re-rolled the container at about 16:49Z. Fix: the Durable Object stores a
  SHA-256 fingerprint of the environment it starts the container with, and before each request restarts a container
  whose fingerprint differs from its own (`deploy/cloudflare/src/env-restart.ts`). The restart is SIGTERM, wait until
  the container has exited, then start, all inside the one Durable Object, so it keeps stop-then-start and the single
  writer. A container that has not exited after two minutes is left alone and requests get 503 until it does; nothing
  new starts. The compatibility rule above still applies, since the old image can still meet the new environment.
- Sleep and wake restore from the replica: on 2026-10-07 the container slept at 18:57:04Z (`litestream shut down`)
  and woke at 19:49:22Z with `restore completed` and no migrations to run.
- Restore fails closed: if the replica cannot be read (bad credentials, endpoint down), the container exits instead
  of starting an empty database. Only a reachable, empty replica counts as a first boot.
- Escape hatches: point `TRACKER_DATABASE_URL` at a Postgres (Neon etc.) and drop Litestream. Or port the server to
  Workers with Durable Object SQLite, which removes the container.
