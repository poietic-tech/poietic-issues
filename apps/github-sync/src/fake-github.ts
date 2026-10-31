import type { GitHubComment } from './github.ts';
import type { GitHubIssue } from './mapping.ts';

interface FakeIssue extends GitHubIssue {
  labels: Array<{ name: string; color: string }>;
  comments: GitHubComment[];
}

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * An in-memory GitHub for tests: the issue and comment REST calls the sync makes, and the webhook payloads
 * GitHub would send for changes made through it or by `act` (a person on github.com).
 */
export class FakeGitHub {
  readonly repos = new Map<string, { description: string; issues: Map<number, FakeIssue> }>();
  readonly calls: string[] = [];
  #nextComment = 1000;
  #nextIssue = 1;

  addRepo(fullName: string, description = ''): void {
    this.repos.set(fullName.toLowerCase(), { description, issues: new Map() });
  }

  issue(repo: string, number: number): FakeIssue {
    const found = this.repos.get(repo.toLowerCase())?.issues.get(number);
    if (!found) throw new Error(`No issue ${repo}#${number}`);
    return found;
  }

  /** A person opens an issue on github.com. */
  open(repo: string, input: { title: string; body?: string; labels?: string[] }): FakeIssue {
    return this.#create(repo, input);
  }

  /** A person comments on github.com. */
  comment(repo: string, number: number, body: string): GitHubComment {
    const issue = this.issue(repo, number);
    const id = this.#nextComment++;
    const comment = { id, body, html_url: `${issue.html_url}#issuecomment-${id}` };
    issue.comments.push(comment);
    return comment;
  }

  /** The webhook payload for an issue event. */
  issuePayload(action: string, repo: string, number: number, sender = 'octocat') {
    const [owner, name] = repo.split('/');
    return {
      action,
      issue: structuredClone({ ...this.issue(repo, number), comments: undefined }),
      repository: {
        full_name: repo,
        name,
        owner: { login: owner },
        description: this.repos.get(repo.toLowerCase())?.description ?? null,
      },
      sender: { login: sender },
    };
  }

  /** The webhook payload for a comment event. */
  commentPayload(
    action: string,
    repo: string,
    number: number,
    comment: GitHubComment,
    sender = 'octocat',
  ) {
    return {
      ...this.issuePayload(action, repo, number, sender),
      comment: { ...comment, user: { login: sender } },
    };
  }

  #create(repo: string, input: { title: string; body?: string; labels?: string[] }): FakeIssue {
    const r = this.repos.get(repo.toLowerCase());
    if (!r) throw new Error(`No repo ${repo}`);
    const number = this.#nextIssue++;
    const issue: FakeIssue = {
      number,
      title: input.title,
      body: input.body ?? null,
      state: 'open',
      state_reason: null,
      html_url: `https://github.com/${repo}/issues/${number}`,
      labels: (input.labels ?? []).map((name) => ({ name, color: 'd73a4a' })),
      comments: [],
    };
    r.issues.set(number, issue);
    return issue;
  }

  #findComment(repo: string, id: number): { issue: FakeIssue; index: number } | undefined {
    for (const issue of this.repos.get(repo.toLowerCase())?.issues.values() ?? []) {
      const index = issue.comments.findIndex((c) => c.id === id);
      if (index >= 0) return { issue, index };
    }
    return undefined;
  }

  readonly fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    this.calls.push(`${request.method} ${url.pathname}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a test double reading GitHub's request bodies
    const body: any =
      request.method === 'GET' || request.method === 'DELETE' ? undefined : await request.json();
    let m = /^\/repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/.exec(url.pathname);
    if (m) {
      const found = this.#findComment(m[1]!, Number(m[2]));
      if (!found) return json(404, { message: 'Not Found' });
      if (request.method === 'DELETE') {
        found.issue.comments.splice(found.index, 1);
        return json(204);
      }
      Object.assign(found.issue.comments[found.index]!, { body: body.body });
      return json(200, found.issue.comments[found.index]);
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(url.pathname);
    if (m) {
      const issue = this.issue(m[1]!, Number(m[2]));
      const comment = { id: this.#nextComment++, body: body.body, html_url: `${issue.html_url}#c` };
      issue.comments.push(comment);
      return json(201, comment);
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(url.pathname);
    if (m) {
      let issue: FakeIssue;
      try {
        issue = this.issue(m[1]!, Number(m[2]));
      } catch {
        return json(404, { message: 'Not Found' });
      }
      if (request.method === 'PATCH') {
        if (body.title !== undefined) issue.title = body.title;
        if (body.body !== undefined) issue.body = body.body;
        if (body.state !== undefined) issue.state = body.state;
        if (body.state_reason !== undefined) issue.state_reason = body.state_reason;
        if (body.labels !== undefined)
          issue.labels = body.labels.map((name: string) => ({ name, color: 'ededed' }));
      }
      return json(200, { ...issue, comments: undefined });
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(url.pathname);
    if (m && request.method === 'POST')
      return json(201, { ...this.#create(m[1]!, body), comments: undefined });
    return json(404, { message: `No fake route ${request.method} ${url.pathname}` });
  };
}
