# 0036. Issues have per-project types

- **Status:** Accepted
- **Date:** 2026-11-24

## Context

People wanted to tell features, bugs and tasks apart (PIB-2), and to add kinds of their own. A select custom field
could hold that, but it is optional per project, lives under `customFields`, and would not show in the issue's core
properties, the CLI's tables or a future GitHub mapping in the same way as status or priority.

## Decision

- **A first-class, per-project list.** Table `issue_types(id, project_id, name, color, position, …)` with names
  unique per project, case-insensitively, and ids prefixed `typ_`. It is modelled on statuses: list, create (at a
  position), rename and recolor, reorder and delete, with `issue_type.created/updated/deleted` events. Editors manage
  it, like statuses and labels.
- **Optional on issues.** `issues.type_id` is nullable, and an issue has no type until one is set. There is no
  default on create. Issues expose `typeId` and `type: { id, name, color } | null`, and take `type` (id or name, or
  null) on create and update. A change is recorded in `issue.updated` as `type: { from, to }`.
- **Defaults.** New projects start with Feature, Bug and Task. Migration 0011 seeds the same three into every
  existing project, leaving existing issues without a type.
- **Deleting a type** leaves its issues with no type, or gives them `moveIssuesTo` (another type of the project).
  Their versions are bumped, as when a status is deleted, without an `issue.updated` per issue.
- **Querying.** `type` is a field-registry key: filterable (`eq`, `in`, `isNull`, names or ids, `none` for no type)
  and groupable, with groups in type order and "No type" first. It is not sortable, like status, so the server's
  order and the web app's live matcher can't disagree.
- **API and CLI.** `/projects/{project}/issue-types` (GET, POST, `/reorder`), `/issue-types/{id}` (PATCH, DELETE),
  `issues type list|create|edit|delete|reorder`, and `--type` on `issue create|edit|list`.

## Consequences

- A type works everywhere status does: the issue page, the create dialog, list columns, board columns (dropping a
  card sets the type), quick filters, saved views, the CLI and the agent input schema (`project schema`).
- Types are per project, so the same name in two projects is two types. Cross-project filters by name match each
  project's type of that name.
- GitHub sync does not map types yet. Mapping them to GitHub issue types or labels is follow-up work.

## Alternatives considered

- **A seeded "Type" select custom field.** Almost no new code, but it would stay a custom field (`cf.type`) that a
  project can delete, and other features couldn't rely on it.
- **One global, fixed enum.** Simple, but not extensible per project, which the request asked for.
- **A required type with a default.** That would have forced a choice on every existing issue and every create.
  "No type" is a fair answer for many issues.
