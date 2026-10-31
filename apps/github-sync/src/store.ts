import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Snapshot } from './mapping.ts';

/** A GitHub issue and the tracker issue that mirrors it, with what both looked like after the last sync. */
export interface IssueLink {
  repo: string;
  number: number;
  trackerId: string;
  trackerKey: string;
  projectId: string;
  url: string;
  snapshot: Snapshot;
}

/** A comment and its mirror. `origin` is the side a person wrote it on; the other side is the sync's copy. */
export interface CommentLink {
  repo: string;
  githubId: number;
  trackerId: string;
  trackerIssueId: string;
  origin: 'github' | 'tracker';
  /** The origin's text after the last sync, to tell an edit from an echo. */
  body: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS issue_links (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  tracker_id TEXT NOT NULL UNIQUE,
  tracker_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  url TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);
CREATE TABLE IF NOT EXISTS comment_links (
  repo TEXT NOT NULL,
  github_id INTEGER NOT NULL,
  tracker_id TEXT NOT NULL UNIQUE,
  tracker_issue_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (repo, github_id)
);
CREATE TABLE IF NOT EXISTS cursors (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
`;

interface IssueRow {
  repo: string;
  number: number;
  tracker_id: string;
  tracker_key: string;
  project_id: string;
  url: string;
  snapshot: string;
}

interface CommentRow {
  repo: string;
  github_id: number;
  tracker_id: string;
  tracker_issue_id: string;
  origin: 'github' | 'tracker';
  body: string;
}

const toIssue = (r: IssueRow): IssueLink => ({
  repo: r.repo,
  number: r.number,
  trackerId: r.tracker_id,
  trackerKey: r.tracker_key,
  projectId: r.project_id,
  url: r.url,
  snapshot: JSON.parse(r.snapshot) as Snapshot,
});

const toComment = (r: CommentRow): CommentLink => ({
  repo: r.repo,
  githubId: r.github_id,
  trackerId: r.tracker_id,
  trackerIssueId: r.tracker_issue_id,
  origin: r.origin,
  body: r.body,
});

/** Repository names compare case-insensitively on GitHub, so they are stored lowercased. */
const repoKey = (repo: string) => repo.toLowerCase();

/**
 * The sync's own state, in one SQLite file: which issues and comments are linked, the last synced snapshot of
 * each issue, and the tracker event cursor. Links are also recorded on the tracker (`poietic.github.url`), so a
 * lost file can be rebuilt; snapshots and cursors are what make an echo recognisable.
 */
export class Store {
  readonly #db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.#db.exec(SCHEMA);
  }

  close(): void {
    this.#db.close();
  }

  isEmpty(): boolean {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM issue_links').get() as { n: number };
    return row.n === 0;
  }

  issueByGitHub(repo: string, number: number): IssueLink | undefined {
    const row = this.#db
      .prepare('SELECT * FROM issue_links WHERE repo = ? AND number = ?')
      .get(repoKey(repo), number) as IssueRow | undefined;
    return row && toIssue(row);
  }

  issueByTracker(trackerId: string): IssueLink | undefined {
    const row = this.#db
      .prepare('SELECT * FROM issue_links WHERE tracker_id = ?')
      .get(trackerId) as IssueRow | undefined;
    return row && toIssue(row);
  }

  saveIssue(link: IssueLink): void {
    this.#db
      .prepare(
        `INSERT INTO issue_links (repo, number, tracker_id, tracker_key, project_id, url, snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo, number) DO UPDATE SET tracker_id = excluded.tracker_id,
           tracker_key = excluded.tracker_key, project_id = excluded.project_id, url = excluded.url,
           snapshot = excluded.snapshot`,
      )
      .run(
        repoKey(link.repo),
        link.number,
        link.trackerId,
        link.trackerKey,
        link.projectId,
        link.url,
        JSON.stringify(link.snapshot),
      );
  }

  commentByGitHub(repo: string, githubId: number): CommentLink | undefined {
    const row = this.#db
      .prepare('SELECT * FROM comment_links WHERE repo = ? AND github_id = ?')
      .get(repoKey(repo), githubId) as CommentRow | undefined;
    return row && toComment(row);
  }

  commentByTracker(trackerId: string): CommentLink | undefined {
    const row = this.#db
      .prepare('SELECT * FROM comment_links WHERE tracker_id = ?')
      .get(trackerId) as CommentRow | undefined;
    return row && toComment(row);
  }

  saveComment(link: CommentLink): void {
    this.#db
      .prepare(
        `INSERT INTO comment_links (repo, github_id, tracker_id, tracker_issue_id, origin, body)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo, github_id) DO UPDATE SET tracker_id = excluded.tracker_id,
           tracker_issue_id = excluded.tracker_issue_id, origin = excluded.origin, body = excluded.body`,
      )
      .run(
        repoKey(link.repo),
        link.githubId,
        link.trackerId,
        link.trackerIssueId,
        link.origin,
        link.body,
      );
  }

  deleteComment(repo: string, githubId: number): void {
    this.#db
      .prepare('DELETE FROM comment_links WHERE repo = ? AND github_id = ?')
      .run(repoKey(repo), githubId);
  }

  cursor(name: string): number | undefined {
    const row = this.#db.prepare('SELECT value FROM cursors WHERE name = ?').get(name) as
      { value: number } | undefined;
    return row?.value;
  }

  setCursor(name: string, value: number): void {
    this.#db
      .prepare(
        'INSERT INTO cursors (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value',
      )
      .run(name, value);
  }
}
