import type { Schemas } from '@poietic-tech/issues-client';
import type { Command } from 'commander';
import type { Tree } from '../tree/runtime.ts';

export const PROJECT_ROLES = ['viewer', 'editor', 'manager'] as const;
export const PROJECT_VISIBILITIES = ['public', 'private'] as const;

/** `--role <role>`, required, limited to the project roles (a bad value is a usage error, exit 2). */
const roleOption = (cmd: Command, what: string) =>
  cmd.createOption('--role <role>', what).choices(PROJECT_ROLES).makeOptionMandatory();

/** `--visibility <visibility>`, limited to the two visibilities. */
export const visibilityOption = (cmd: Command, what: string) =>
  cmd.createOption('--visibility <visibility>', what).choices(PROJECT_VISIBILITIES);

/**
 * `project members …`. The project comes from the global `-P/--project`, `POIETIC_ISSUES_PROJECT` or
 * `.poietic-issues.json`, so the positional slot is free for the user.
 */
export function registerMembers(parent: Command, tree: Tree): Command {
  const act: Tree['act'] = (fn) => tree.act(fn);
  const cmd = parent
    .command('members')
    .description(
      "Manage who can use a private project and how (a project's members; project is set with -P)",
    );
  cmd
    .command('list')
    .alias('ls')
    .description('List the project members')
    .action(
      act(async (rt) => {
        const api = await rt.api();
        rt.out.list(
          'member',
          (
            await rt.call(
              api.GET('/projects/{project}/members', {
                params: { path: { project: rt.project(undefined) } },
              }),
            )
          ).data,
        );
      }),
    );
  cmd
    .command('add')
    .description('Give a user a role on the project (needs manage)')
    .argument('<user>', 'handle, @handle or user id')
    .addOption(
      roleOption(cmd, 'viewer reads, editor also writes, manager also manages the project'),
    )
    .action(
      act(async (rt, [user], o) => {
        const api = await rt.api();
        rt.out.item(
          'member',
          await rt.call(
            api.POST('/projects/{project}/members', {
              params: { path: { project: rt.project(undefined) } },
              body: { user: String(user), role: o.role } as Schemas['AddProjectMemberInput'],
            }),
          ),
        );
      }),
    );
  cmd
    .command('set')
    .description("Change a member's role (needs manage)")
    .argument('<user>', 'handle, @handle or user id')
    .addOption(roleOption(cmd, 'the new role'))
    .action(
      act(async (rt, [user], o) => {
        const api = await rt.api();
        rt.out.item(
          'member',
          await rt.call(
            api.PATCH('/projects/{project}/members/{user}', {
              params: { path: { project: rt.project(undefined), user: String(user) } },
              body: { role: o.role } as Schemas['UpdateProjectMemberInput'],
            }),
          ),
        );
      }),
    );
  cmd
    .command('remove')
    .alias('rm')
    .description("Remove a user's role on the project (needs manage)")
    .argument('<user>', 'handle, @handle or user id')
    .action(
      act(async (rt, [user]) => {
        const api = await rt.api();
        const res = await api.DELETE('/projects/{project}/members/{user}', {
          params: { path: { project: rt.project(undefined), user: String(user) } },
        });
        await rt.call(res as never);
        rt.out.item('raw', { id: String(user), removed: true }, () => `Removed ${String(user)}\n`);
      }),
    );
  return cmd;
}

/** `project repo …`: the GitHub repositories linked to a project. The project comes from `-P` as above. */
export function registerRepo(parent: Command, tree: Tree): Command {
  const act: Tree['act'] = (fn) => tree.act(fn);
  const cmd = parent
    .command('repo')
    .description("Manage a project's linked GitHub repositories (project is set with -P)");
  cmd
    .command('list')
    .alias('ls')
    .description('List the linked repositories')
    .action(
      act(async (rt) => {
        const api = await rt.api();
        const project = await rt.call(
          api.GET('/projects/{project}', {
            params: { path: { project: rt.project(undefined) } },
          }),
        );
        rt.out.list('repo', project.repos);
      }),
    );
  cmd
    .command('add')
    .description('Link a GitHub repository to the project (needs manage)')
    .argument('<repo>', 'owner/name or a github.com URL')
    .action(
      act(async (rt, [repo]) => {
        const api = await rt.api();
        rt.out.item(
          'repo',
          await rt.call(
            api.POST('/projects/{project}/repos', {
              params: { path: { project: rt.project(undefined) } },
              body: { repo: String(repo) },
            }),
          ),
        );
      }),
    );
  cmd
    .command('remove')
    .alias('rm')
    .description(
      'Unlink a repository (needs manage); issues that named it are cleared. Takes owner/name, a URL or an rpo_ id',
    )
    .argument('<repo>', 'owner/name, github.com URL or repo id')
    .action(
      act(async (rt, [repo]) => {
        const api = await rt.api();
        const res = await api.DELETE('/projects/{project}/repos/{repo}', {
          params: { path: { project: rt.project(undefined), repo: String(repo) } },
        });
        await rt.call(res as never);
        rt.out.item('raw', { id: String(repo), removed: true }, () => `Unlinked ${String(repo)}\n`);
      }),
    );
  return cmd;
}
