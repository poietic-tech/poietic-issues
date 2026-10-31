import { type ApiClient, type Schemas, unwrap } from '@poietic-tech/issues-client';
import { projectKeyFor, sortedLabels } from './mapping.ts';

export type Issue = Schemas['Issue'];
export type Comment = Schemas['Comment'];
export type Project = Schemas['ProjectWithAccess'];
export type Status = Schemas['Status'];
export type TrackerEvent = Schemas['Event'];
export type Me = Schemas['User'];

/** What the sync needs to know about a GitHub repository to give it a project. */
export interface RepoInfo {
  full_name: string;
  name: string;
  description?: string | null;
}

const idem = (key: string) => ({ 'idempotency-key': key });

/**
 * The tracker as the sync uses it: the public API, with projects indexed by linked repository and each
 * project's statuses and labels cached. Creates carry deterministic idempotency keys, so a retried create
 * (within the server's 24-hour window) returns the first result instead of a duplicate.
 */
export class Tracker {
  readonly api: ApiClient;
  readonly #visibility: 'private' | 'public';
  #projects: Project[] | undefined;
  readonly #statuses = new Map<string, Status[]>();
  readonly #labels = new Map<string, Map<string, string>>();

  constructor(api: ApiClient, opts: { visibility?: 'private' | 'public' } = {}) {
    this.api = api;
    this.#visibility = opts.visibility ?? 'private';
  }

  async me(): Promise<Me> {
    const me = unwrap(await this.api.GET('/me'));
    if (!('id' in me)) throw new Error('The tracker does not know this agent (anonymous).');
    return me;
  }

  /** Forgets cached projects (after a repo was linked or unlinked elsewhere, say). */
  invalidate(projectId?: string): void {
    this.#projects = undefined;
    if (projectId) {
      this.#statuses.delete(projectId);
      this.#labels.delete(projectId);
    }
  }

  async projects(): Promise<Project[]> {
    this.#projects ??= unwrap(await this.api.GET('/projects', {})).data;
    return this.#projects;
  }

  async project(id: string): Promise<Project | undefined> {
    const found = (await this.projects()).find((p) => p.id === id);
    if (found) return found;
    this.invalidate();
    return (await this.projects()).find((p) => p.id === id);
  }

  /** The project a repository is linked to, looking again once before giving up. */
  async projectForRepo(repo: string): Promise<Project | undefined> {
    const find = (list: Project[]) =>
      list.find((p) => p.repos.some((r) => r.fullName.toLowerCase() === repo.toLowerCase()));
    const cached = find(await this.projects());
    if (cached) return cached;
    this.invalidate();
    return find(await this.projects());
  }

  /** The repository's project, creating one named after it (and linking it) when there is none. */
  async ensureProjectForRepo(repo: RepoInfo): Promise<Project> {
    const existing = await this.projectForRepo(repo.full_name);
    if (existing) return existing;
    const taken = new Set((await this.projects()).map((p) => p.key));
    const key = projectKeyFor(repo.name, taken);
    const created = unwrap(
      await this.api.POST('/projects', {
        body: {
          key,
          name: repo.name,
          description: repo.description ?? '',
          visibility: this.#visibility,
        },
        headers: idem(`github-sync:project:${repo.full_name.toLowerCase()}`),
      }),
    );
    unwrap(
      await this.api.POST('/projects/{project}/repos', {
        params: { path: { project: created.id } },
        body: { repo: repo.full_name },
      }),
    );
    this.invalidate();
    const linked = await this.projectForRepo(repo.full_name);
    if (!linked)
      throw new Error(`Created project ${key} but ${repo.full_name} is not linked to it.`);
    return linked;
  }

  async statuses(projectId: string): Promise<Status[]> {
    let list = this.#statuses.get(projectId);
    if (!list) {
      list = unwrap(
        await this.api.GET('/projects/{project}/statuses', {
          params: { path: { project: projectId } },
        }),
      ).data.sort((a, b) => a.position - b.position);
      this.#statuses.set(projectId, list);
    }
    return list;
  }

  /** The first status (by position) of the first category that has one. */
  async statusIn(projectId: string, categories: Status['category'][]): Promise<Status> {
    const list = await this.statuses(projectId);
    for (const category of categories) {
      const found = list.find((s) => s.category === category);
      if (found) return found;
    }
    throw new Error(`Project ${projectId} has no status in ${categories.join('/')}.`);
  }

  /** Label names as the project spells them, creating any it lacks (with GitHub's colour when known). */
  async ensureLabels(
    projectId: string,
    names: string[],
    colors: Record<string, string> = {},
  ): Promise<string[]> {
    let byName = this.#labels.get(projectId);
    if (!byName) {
      const list = unwrap(
        await this.api.GET('/projects/{project}/labels', {
          params: { path: { project: projectId } },
        }),
      ).data;
      byName = new Map(list.map((l) => [l.name.toLowerCase(), l.name]));
      this.#labels.set(projectId, byName);
    }
    const out: string[] = [];
    for (const name of sortedLabels(names)) {
      let actual = byName.get(name.toLowerCase());
      if (!actual) {
        const color = colors[name.toLowerCase()];
        const created = unwrap(
          await this.api.POST('/projects/{project}/labels', {
            params: { path: { project: projectId } },
            body: { name, ...(color && /^[0-9a-f]{6}$/i.test(color) && { color: `#${color}` }) },
            headers: idem(`github-sync:label:${projectId}:${name.toLowerCase()}`),
          }),
        );
        actual = created.name;
        byName.set(name.toLowerCase(), actual);
      }
      out.push(actual);
    }
    return out;
  }

  async issue(id: string): Promise<Issue> {
    return unwrap(await this.api.GET('/issues/{issue}', { params: { path: { issue: id } } }));
  }

  async createIssue(
    projectId: string,
    body: Schemas['CreateIssueInput'],
    idempotencyKey: string,
  ): Promise<Issue> {
    return unwrap(
      await this.api.POST('/projects/{project}/issues', {
        params: { path: { project: projectId } },
        body,
        headers: idem(idempotencyKey),
      }),
    );
  }

  async updateIssue(id: string, body: Schemas['UpdateIssueInput']): Promise<Issue> {
    return unwrap(
      await this.api.PATCH('/issues/{issue}', { params: { path: { issue: id } }, body }),
    );
  }

  async trashIssue(id: string): Promise<void> {
    unwrap(await this.api.DELETE('/issues/{issue}', { params: { path: { issue: id } } }));
  }

  /** Every issue of a project, trashed ones included. */
  async *allIssues(projectId: string): AsyncGenerator<Issue> {
    let cursor: string | undefined;
    do {
      const page = unwrap(
        await this.api.GET('/projects/{project}/issues', {
          params: {
            path: { project: projectId },
            query: { limit: 100, includeDeleted: 'true', ...(cursor && { cursor }) },
          },
        }),
      );
      yield* page.data;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  async createComment(issueId: string, body: string, idempotencyKey: string): Promise<Comment> {
    return unwrap(
      await this.api.POST('/issues/{issue}/comments', {
        params: { path: { issue: issueId } },
        body: { body },
        headers: idem(idempotencyKey),
      }),
    );
  }

  async updateComment(id: string, body: string): Promise<Comment> {
    return unwrap(
      await this.api.PATCH('/comments/{id}', { params: { path: { id } }, body: { body } }),
    );
  }

  async deleteComment(id: string): Promise<void> {
    unwrap(await this.api.DELETE('/comments/{id}', { params: { path: { id } } }));
  }

  async events(
    after: number,
    types: string[],
    limit = 100,
  ): Promise<{ data: TrackerEvent[]; nextCursor: string | null }> {
    return unwrap(
      await this.api.GET('/events', {
        params: { query: { after, limit, types: types.join(',') } },
      }),
    );
  }
}
