import type { GitHubIssue } from './mapping.ts';

/** A failed GitHub API call. `transient` failures (network, 5xx, rate limits) are worth retrying. */
export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }

  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export interface GitHubComment {
  id: number;
  body?: string | null;
  html_url: string;
}

export interface GitHubOptions {
  /** A fine-grained token with Issues: read and write on the synced repositories. */
  token: string;
  baseUrl?: string;
  fetch?: (request: Request) => Promise<Response>;
}

export interface IssueChange {
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  state_reason?: string | null;
  labels?: string[];
}

/** The few GitHub REST calls the sync makes, over plain fetch. */
export class GitHub {
  readonly #token: string;
  readonly #base: string;
  readonly #fetch: (request: Request) => Promise<Response>;

  constructor(options: GitHubOptions) {
    this.#token = options.token;
    this.#base = (options.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.#fetch = options.fetch ?? ((r) => fetch(r));
  }

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const request = new Request(`${this.#base}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.#token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'poietic-issues-github-sync',
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    let response: Response;
    try {
      response = await this.#fetch(request);
    } catch (error) {
      throw new GitHubError(0, `${method} ${path}: ${(error as Error).message}`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new GitHubError(
        response.status,
        `${method} ${path}: HTTP ${response.status} ${text.slice(0, 300)}`,
      );
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  getIssue(repo: string, number: number): Promise<GitHubIssue> {
    return this.#call('GET', `/repos/${repo}/issues/${number}`);
  }

  createIssue(
    repo: string,
    input: { title: string; body: string; labels: string[] },
  ): Promise<GitHubIssue> {
    return this.#call('POST', `/repos/${repo}/issues`, input);
  }

  updateIssue(repo: string, number: number, change: IssueChange): Promise<GitHubIssue> {
    return this.#call('PATCH', `/repos/${repo}/issues/${number}`, change);
  }

  createComment(repo: string, number: number, body: string): Promise<GitHubComment> {
    return this.#call('POST', `/repos/${repo}/issues/${number}/comments`, { body });
  }

  updateComment(repo: string, id: number, body: string): Promise<GitHubComment> {
    return this.#call('PATCH', `/repos/${repo}/issues/comments/${id}`, { body });
  }

  async deleteComment(repo: string, id: number): Promise<void> {
    try {
      await this.#call('DELETE', `/repos/${repo}/issues/comments/${id}`);
    } catch (error) {
      // Already gone is what we wanted.
      if (!(error instanceof GitHubError && error.status === 404)) throw error;
    }
  }
}
