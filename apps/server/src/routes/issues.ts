import { createRoute, z } from '@hono/zod-openapi';
import {
  bulkUpdateIssues,
  createIssue,
  deleteIssue,
  getIssue,
  listChildren,
  listIssueActivity,
  listIssues,
  moveIssue,
  restoreIssue,
  updateIssue,
} from '@poietic-tech/issues-core';
import {
  CreateIssueInputSchema,
  EventSchema,
  IssueFilterSchema,
  IssueSchema,
  MoveIssueInputSchema,
  pageOf,
  SortSpecSchema,
  UpdateIssueInputSchema,
} from '@poietic-tech/issues-schema';
import type { TrackerApp } from '../env.ts';
import { parseIssueQuery } from '../issue-query-params.ts';
import {
  BooleanQuery,
  CursorQuery,
  errorResponses,
  expectedVersion,
  IfMatchHeader,
  json,
  jsonBody,
  LimitQuery,
  refParam,
  setEtag,
} from './common.ts';

const tags = ['Issues'];
const issueParam = z.object({
  issue: refParam('issue', 'Issue key (e.g. `ENG-42`) or id.', 'ENG-42'),
});
const projectParam = z.object({
  project: refParam('project', 'Project key (e.g. `ENG`) or id.', 'ENG'),
});
const IssuePage = pageOf(IssueSchema).openapi('IssuePage');
const EventPage = pageOf(EventSchema).openapi('EventPage');
const etagHeader = {
  ETag: { description: 'Issue version, for If-Match.', schema: { type: 'string' as const } },
};

const listQuery = z
  .object({
    status: z.string().optional().openapi({
      description: 'Status names or ids, comma-separated.',
      example: 'Todo,In Progress',
    }),
    statusCategory: z.string().optional().openapi({ example: 'started' }),
    type: z
      .string()
      .optional()
      .openapi({ description: 'Issue type names or ids, or `none`.', example: 'Bug,Task' }),
    assignee: z
      .string()
      .optional()
      .openapi({ description: 'Handles or ids; `me`, `none`.', example: 'me,none' }),
    creator: z.string().optional(),
    label: z
      .string()
      .optional()
      .openapi({ description: 'Issues having any of these labels.', example: 'bug' }),
    priority: z.string().optional().openapi({ example: '1,2' }),
    parent: z
      .string()
      .optional()
      .openapi({ description: 'Parent issue key/id, or `none`.', example: 'ENG-1' }),
    q: z.string().optional().openapi({ description: 'Text search in key, title and description.' }),
    filter: z
      .string()
      .optional()
      .openapi({ description: 'JSON-encoded IssueFilter, ANDed with the other parameters.' }),
    sort: z.string().optional().openapi({
      description: 'Comma-separated fields, `-` for descending.',
      example: '-updatedAt',
    }),
    limit: LimitQuery,
    cursor: CursorQuery,
    includeDeleted: BooleanQuery.openapi({
      description:
        'Trashed issues are included only for projects the caller can write in; for other projects this is ignored.',
    }),
  })
  .catchall(z.string())
  .openapi({
    description:
      'Any registry field works as `field=v1,v2` (in) or `field.op=value` with op in eq, neq, in, nin, gt, gte, lt, ' +
      'lte, isNull, contains — e.g. `priority.gte=2`, `dueDate.isNull=true`, `cf.severity=high`.',
  });

export function registerIssueRoutes(app: TrackerApp) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{project}/issues',
      tags,
      summary: 'List issues in a project',
      request: { params: projectParam, query: listQuery },
      responses: { 200: json(IssuePage, 'A page of issues'), ...errorResponses('NOT_FOUND') },
    }),
    async (c) => {
      const params = parseIssueQuery(new URL(c.req.url));
      return c.json(
        await listIssues(c.get('ctx'), { project: c.req.valid('param').project, ...params }),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/issues/search',
      tags,
      summary: 'Search issues with a structured filter',
      description:
        'Same as listing, with the filter in the body. Omit `project` to search all projects.',
      request: {
        body: jsonBody(
          z
            .object({
              project: z.string().optional(),
              filter: IssueFilterSchema.optional(),
              sort: z.array(SortSpecSchema).max(5).optional(),
              limit: z.number().int().min(1).max(200).optional(),
              cursor: z.string().nullish(),
              includeDeleted: z.boolean().optional().openapi({
                description:
                  'Trashed issues are included only for projects the caller can write in; for other projects this is ignored.',
              }),
            })
            .openapi('SearchIssuesInput'),
        ),
      },
      responses: { 200: json(IssuePage, 'A page of issues'), ...errorResponses('NOT_FOUND') },
    }),
    async (c) => c.json(await listIssues(c.get('ctx'), c.req.valid('json')), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/projects/{project}/issues',
      tags,
      summary: 'Create an issue',
      description: 'Supports `Idempotency-Key`. New issues go to the top of their status column.',
      request: { params: projectParam, body: jsonBody(CreateIssueInputSchema) },
      responses: {
        201: { ...json(IssueSchema, 'Created'), headers: etagHeader },
        ...errorResponses('NOT_FOUND', 'CONFLICT', 'INVALID_RELATION'),
      },
    }),
    async (c) => {
      const issue = await createIssue(
        c.get('ctx'),
        c.req.valid('param').project,
        c.req.valid('json'),
      );
      setEtag(c, issue.version);
      c.header('Location', `/api/v1/issues/${issue.key}`);
      return c.json(issue, 201);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/issues/{issue}',
      tags,
      summary: 'Get an issue',
      description:
        'Returns trashed issues too (see `deletedAt`) to actors who can write in the project; to anyone else a ' +
        'trashed issue is not found.',
      request: { params: issueParam },
      responses: {
        200: { ...json(IssueSchema, 'Issue'), headers: etagHeader },
        ...errorResponses('NOT_FOUND'),
      },
    }),
    async (c) => {
      const issue = await getIssue(c.get('ctx'), c.req.valid('param').issue);
      setEtag(c, issue.version);
      return c.json(issue, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/issues/{issue}',
      tags,
      summary: 'Update an issue',
      description:
        'Partial update; omitted fields are unchanged, `null` clears. `labels` replaces the set; `addLabels` / ' +
        '`removeLabels` adjust it. `customFields` merges. Send `If-Match` (or `expectedVersion`) to avoid lost updates.',
      request: {
        params: issueParam,
        headers: IfMatchHeader,
        body: jsonBody(UpdateIssueInputSchema),
      },
      responses: {
        200: { ...json(IssueSchema, 'Updated'), headers: etagHeader },
        ...errorResponses('NOT_FOUND', 'CONFLICT', 'VERSION_MISMATCH', 'INVALID_RELATION'),
      },
    }),
    async (c) => {
      const version = expectedVersion(c);
      const body = c.req.valid('json');
      const issue = await updateIssue(c.get('ctx'), c.req.valid('param').issue, {
        ...body,
        ...(version !== undefined && { expectedVersion: version }),
      });
      setEtag(c, issue.version);
      return c.json(issue, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/issues/{issue}',
      tags,
      summary: 'Delete an issue',
      description:
        'Moves the issue to the trash (restorable). `permanent=true` deletes for good (admin only).',
      request: {
        params: issueParam,
        headers: IfMatchHeader,
        query: z.object({ permanent: BooleanQuery }),
      },
      responses: {
        200: json(IssueSchema, 'The deleted issue'),
        ...errorResponses('NOT_FOUND', 'FORBIDDEN', 'VERSION_MISMATCH'),
      },
    }),
    async (c) => {
      const version = expectedVersion(c);
      const issue = await deleteIssue(c.get('ctx'), c.req.valid('param').issue, {
        permanent: c.req.valid('query').permanent,
        ...(version !== undefined && { expectedVersion: version }),
      });
      return c.json(issue, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/issues/{issue}/restore',
      tags,
      summary: 'Restore an issue from the trash',
      request: { params: issueParam },
      responses: { 200: json(IssueSchema, 'Restored'), ...errorResponses('NOT_FOUND') },
    }),
    async (c) => c.json(await restoreIssue(c.get('ctx'), c.req.valid('param').issue), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/issues/{issue}/move',
      tags,
      summary: 'Move an issue on the board',
      description:
        'Optionally change status, and place the issue after `afterId`, before `beforeId`, or at the `top`/`bottom` ' +
        'of the column. The server computes the ordering key.',
      request: { params: issueParam, body: jsonBody(MoveIssueInputSchema) },
      responses: {
        200: { ...json(IssueSchema, 'Moved'), headers: etagHeader },
        ...errorResponses('NOT_FOUND', 'CONFLICT', 'VERSION_MISMATCH'),
      },
    }),
    async (c) => {
      const issue = await moveIssue(c.get('ctx'), c.req.valid('param').issue, c.req.valid('json'));
      setEtag(c, issue.version);
      return c.json(issue, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/issues/bulk',
      tags,
      summary: 'Apply one update to many issues',
      description: 'Atomic: all issues update or none do. At most 100 issues.',
      request: {
        body: jsonBody(
          z
            .object({
              issues: z
                .array(z.string())
                .min(1)
                .max(100)
                .openapi({ description: 'Issue keys or ids.' }),
              patch: UpdateIssueInputSchema.omit({ expectedVersion: true }),
            })
            .openapi('BulkUpdateInput'),
        ),
      },
      responses: {
        200: json(z.object({ data: z.array(IssueSchema) }), 'Updated issues'),
        ...errorResponses('NOT_FOUND', 'CONFLICT', 'INVALID_RELATION'),
      },
    }),
    async (c) => {
      const { issues, patch } = c.req.valid('json');
      return c.json({ data: await bulkUpdateIssues(c.get('ctx'), issues, patch) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/issues/{issue}/labels',
      tags,
      summary: 'Add or remove labels',
      request: {
        params: issueParam,
        body: jsonBody(
          z
            .object({
              add: z.array(z.string()).default([]),
              remove: z.array(z.string()).default([]),
            })
            .openapi('ChangeLabelsInput'),
        ),
      },
      responses: { 200: json(IssueSchema, 'Updated'), ...errorResponses('NOT_FOUND') },
    }),
    async (c) => {
      const { add, remove } = c.req.valid('json');
      return c.json(
        await updateIssue(c.get('ctx'), c.req.valid('param').issue, {
          addLabels: add,
          removeLabels: remove,
        }),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/issues/{issue}/children',
      tags,
      summary: 'Sub-issues',
      request: { params: issueParam },
      responses: {
        200: json(z.object({ data: z.array(IssueSchema) }), 'Children in manual order'),
        ...errorResponses('NOT_FOUND'),
      },
    }),
    async (c) =>
      c.json({ data: await listChildren(c.get('ctx'), c.req.valid('param').issue) }, 200),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/issues/{issue}/activity',
      tags,
      summary: 'Issue history',
      description:
        'Events about the issue (changes, comments, links), oldest first. Page with `after=<seq>`.',
      request: {
        params: issueParam,
        query: z.object({ after: z.coerce.number().int().min(0).optional(), limit: LimitQuery }),
      },
      responses: { 200: json(EventPage, 'Events'), ...errorResponses('NOT_FOUND') },
    }),
    async (c) =>
      c.json(
        await listIssueActivity(c.get('ctx'), c.req.valid('param').issue, c.req.valid('query')),
        200,
      ),
  );
}
