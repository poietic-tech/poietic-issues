import { createRoute, z } from '@hono/zod-openapi';
import {
  createUser,
  getUser,
  listUsers,
  SYSTEM_ACTOR,
  updateUser,
  withActor,
} from '@poietic-tech/issues-core';
import {
  CreateUserInputSchema,
  UpdateUserInputSchema,
  UserSchema,
} from '@poietic-tech/issues-schema';
import type { ResolvedDeps, TrackerApp } from '../env.ts';
import { BooleanQuery, errorResponses, json, jsonBody, refParam } from './common.ts';

const tags = ['Users'];
const userParam = z.object({ user: refParam('user', 'User id, handle, `@handle` or `me`.', 'me') });

export function registerUserRoutes(app: TrackerApp, deps: ResolvedDeps) {
  const directory = deps.auth.mode === 'standard' ? deps.auth.sso?.directory : undefined;
  app.openapi(
    createRoute({
      method: 'get',
      path: '/users',
      tags,
      summary: 'List users',
      description:
        'With an SSO directory configured, a signed-in listing first refreshes users from it, at most every few ' +
        'minutes: names and avatars follow the directory, and members of the approval group who have never signed in ' +
        'are added, so they can be assigned. If the directory is unreachable, the local users are listed as they are.',
      request: { query: z.object({ includeDeactivated: BooleanQuery }) },
      responses: {
        200: json(z.object({ data: z.array(UserSchema) }), 'Users'),
        ...errorResponses(),
      },
    }),
    async (c) => {
      // The directory owns who people are; signed-in listings refresh the local cache first (ADR 0027).
      if (directory && c.get('actor'))
        await directory.refresh(withActor(c.get('ctx'), SYSTEM_ACTOR), c.get('logger'));
      return c.json({ data: await listUsers(c.get('ctx'), c.req.valid('query')) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/users',
      tags,
      summary: 'Create a user (human or agent)',
      description:
        'Admin only. Create an `agent` user per automated worker so its changes are attributed.',
      request: { body: jsonBody(CreateUserInputSchema) },
      responses: { 201: json(UserSchema, 'Created'), ...errorResponses('FORBIDDEN', 'CONFLICT') },
    }),
    async (c) => c.json(await createUser(c.get('ctx'), c.req.valid('json')), 201),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/users/{user}',
      tags,
      summary: 'Get a user',
      request: { params: userParam },
      responses: { 200: json(UserSchema, 'User'), ...errorResponses('NOT_FOUND') },
    }),
    async (c) => c.json(await getUser(c.get('ctx'), c.req.valid('param').user), 200),
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/users/{user}',
      tags,
      summary: 'Update a user',
      description: 'Users may edit their own name, email and avatar; admins may change anything.',
      request: { params: userParam, body: jsonBody(UpdateUserInputSchema) },
      responses: { 200: json(UserSchema, 'Updated'), ...errorResponses('FORBIDDEN', 'NOT_FOUND') },
    }),
    async (c) =>
      c.json(await updateUser(c.get('ctx'), c.req.valid('param').user, c.req.valid('json')), 200),
  );
}
