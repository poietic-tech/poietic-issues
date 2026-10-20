# Extending the tracker

Short recipes for common changes. Each keeps the rules in [AGENTS.md](../AGENTS.md): business logic in `packages/core`, portable SQL, the committed OpenAPI contract, and tests on both dialects.

## Add a field to issues

1. **Schema.** Add a migration in `packages/db/src/migrations/` (use `columnTypes`) and register it in `migrate.ts`. Update `packages/db/src/types.ts`.
2. **Contract.** Add the field to `IssueSchema`, and to the create/update inputs, in `packages/schema/src/entities.ts`.
3. **Services.** Map it in `packages/core/src/issue-query.ts` and write it in `services/issues.ts`. Include it in the `diff` for `issue.updated` events.
4. **Registry.** To make it filterable, sortable, groupable or displayable, register it in the field registry (`packages/schema/src/fields.ts`). Then add the SQL in `issue-query.ts`. The filter parity property test (`filter-parity.test.ts`) checks that `matchesFilter` and SQL agree.
5. **Regenerate** the API contract and client with `pnpm openapi:gen`.
6. **Web.** Add a cell/card renderer in `IssueCard`/`IssueList` and an editor in `IssueProperties`.

Most per-team fields don't need any of this. Use custom fields (`poietic-tech issues field create`) instead.

## Add a custom field type

1. Add the type to `CUSTOM_FIELD_TYPES` in `packages/schema/src/custom-fields.ts`, with its value schema and filter operators.
2. Store it in `issue_field_values`, adding a column in a migration if no existing `v_*` column fits. Handle it in `packages/core/src/custom-field-values.ts` and `custom-field-query.ts`.
3. Add an editor (`CustomFieldEditor.svelte`) and a renderer (`CustomFieldValue.svelte`).

## Add an event type

1. Add it to `EVENT_TYPES`, with a data schema in `EVENT_DATA_SCHEMAS` (`packages/schema/src/events.ts`).
2. Record it inside the service's write transaction with `recordEvent(tx, ctx, type, …)`.
3. It then flows automatically to `/events`, SSE and webhooks, which can subscribe with `<noun>.*`. Handle it in `apps/web/src/lib/live.svelte.ts` if the web app should react, and describe it in `ActivityTimeline` if it belongs to an issue.
4. Document it in the catalogue in [events.md](events.md).

## Add an API route

1. Implement the behaviour as a core service function that takes a `ServiceContext` and writes through `withWriteTx`.
2. Declare the route in `apps/server/src/routes/*.ts` with `createRoute` and schemas from `@poietic-tech/issues-schema`, and list its error codes with `errorResponses(...)`.
3. Run `pnpm openapi:gen`, then commit `docs/openapi.json` and the regenerated client.
4. Add an `app.request()` test. It runs on both dialects.

## Add a CLI command

1. Add it under `apps/cli/src/commands/`. Call the API through `rt.api()` and print with `rt.out.item/list`, so `--json`, `--format` and `--fields` work.
2. Keep the contract: never prompt, and report failures by throwing `CliError`/`usage()`, which maps to the documented exit codes.
3. Avoid local options that clash with global ones (`--project`, `--json`, …).
4. Add a test in `cli.test.ts`, then run `pnpm vitest run --project cli -u` to update the golden command tree and `docs/cli-reference.md`.

## Add a storage backend

Implement `BlobStore` (`put`, `get`, `delete`, and optionally `presignedGetUrl`) in `packages/core/src/storage/` and select it in `blobStoreFromEnv`. Run the shared contract test from `attachments.test.ts` against it.
