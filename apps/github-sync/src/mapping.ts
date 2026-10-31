/**
 * Pure translation between GitHub issues and tracker issues: the synced snapshot of an issue, state ↔ status
 * category, the hidden markers that tie a copy to its origin, and attribution lines on mirrored comments.
 */

/** Whether an issue is open, and if not, why. GitHub's `duplicate` reason counts as not planned. */
export type SyncState = 'open' | 'completed' | 'not_planned';

/** The fields kept in step, as they were after the last sync. A change is a field that differs from this. */
export interface Snapshot {
  title: string;
  body: string;
  state: SyncState;
  /** Label names, sorted, compared case-insensitively. */
  labels: string[];
}

export type StatusCategory = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';

/** The subset of a GitHub REST/webhook issue the sync reads. */
export interface GitHubIssue {
  number: number;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  state_reason?: string | null;
  html_url: string;
  labels?: Array<{ name: string; color?: string } | string>;
  pull_request?: unknown;
}

/** The subset of a tracker issue the sync reads. */
export interface TrackerIssueLike {
  id: string;
  key: string;
  projectId: string;
  title: string;
  description: string;
  status: { category: StatusCategory };
  labels: Array<{ name: string }>;
  metadata: Record<string, unknown>;
  repo: string | null;
  deletedAt: string | null;
}

/** The metadata key holding a tracker issue's GitHub issue URL, shared with persistent-agents' intake. */
export const GITHUB_URL_KEY = 'poietic.github.url';

const ISSUE_MARKER = /\n*<!-- poietic-issues:(iss_[0-9a-z]+) -->\s*$/;
const COMMENT_MARKER = /<!-- poietic-issues:comment:([0-9a-z_]+) -->/;

/** The tracker issue id a GitHub body was written for, if the sync wrote it. */
export function issueMarker(body: string | null | undefined): string | undefined {
  return body ? ISSUE_MARKER.exec(body)?.[1] : undefined;
}

/** The tracker comment id a GitHub comment mirrors, if the sync wrote it. */
export function commentMarker(body: string | null | undefined): string | undefined {
  return body ? COMMENT_MARKER.exec(body)?.[1] : undefined;
}

/** A body without the sync's marker, normalised so `null`, CRLF and trailing space compare equal. */
export function cleanBody(body: string | null | undefined): string {
  return (body ?? '').replace(/\r\n/g, '\n').replace(ISSUE_MARKER, '').trimEnd();
}

/** The body to send to GitHub for a tracker issue: its description, then an invisible marker. */
export function bodyWithMarker(description: string, trackerId: string): string {
  const text = description.trimEnd();
  return `${text}${text ? '\n\n' : ''}<!-- poietic-issues:${trackerId} -->`;
}

export function stateOfGitHub(issue: Pick<GitHubIssue, 'state' | 'state_reason'>): SyncState {
  if (issue.state === 'open') return 'open';
  return issue.state_reason === 'not_planned' || issue.state_reason === 'duplicate'
    ? 'not_planned'
    : 'completed';
}

export function stateOfCategory(category: StatusCategory): SyncState {
  if (category === 'completed') return 'completed';
  if (category === 'canceled') return 'not_planned';
  return 'open';
}

/** The GitHub fields that put an issue in `state`. */
export function gitHubStateFields(state: SyncState): {
  state: 'open' | 'closed';
  state_reason: 'reopened' | 'completed' | 'not_planned';
} {
  if (state === 'open') return { state: 'open', state_reason: 'reopened' };
  return { state: 'closed', state_reason: state };
}

/** Label names, first spelling of each kept, sorted case-insensitively. */
export function sortedLabels(names: string[]): string[] {
  const seen = new Map<string, string>();
  for (const name of names) if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  return [...seen.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

export function labelName(label: { name: string } | string): string {
  return typeof label === 'string' ? label : label.name;
}

export function snapshotOfGitHub(issue: GitHubIssue): Snapshot {
  return {
    title: issue.title,
    body: cleanBody(issue.body),
    state: stateOfGitHub(issue),
    labels: sortedLabels((issue.labels ?? []).map(labelName)),
  };
}

export function snapshotOfTracker(issue: TrackerIssueLike): Snapshot {
  return {
    title: issue.title,
    body: cleanBody(issue.description),
    state: issue.deletedAt ? 'not_planned' : stateOfCategory(issue.status.category),
    labels: sortedLabels(issue.labels.map((l) => l.name)),
  };
}

function sameLabels(a: string[], b: string[]): boolean {
  const x = sortedLabels(a);
  const y = sortedLabels(b);
  return x.length === y.length && x.every((name, i) => name.toLowerCase() === y[i]!.toLowerCase());
}

/** The fields of `next` that differ from `prev`: what changed on one side since the last sync. */
export function changedFields(prev: Snapshot, next: Snapshot): Partial<Snapshot> {
  const out: Partial<Snapshot> = {};
  if (prev.title !== next.title) out.title = next.title;
  if (prev.body !== next.body) out.body = next.body;
  if (prev.state !== next.state) out.state = next.state;
  if (!sameLabels(prev.labels, next.labels)) out.labels = next.labels;
  return out;
}

export function isEmpty(change: Partial<Snapshot>): boolean {
  return Object.keys(change).length === 0;
}

/** The tracker comment body for a GitHub comment: who wrote it and where, then their words. */
export function trackerCommentBody(
  comment: { body?: string | null; html_url: string },
  login: string,
): string {
  const words = cleanBody(comment.body) || '_(empty)_';
  return `**[@${login}](https://github.com/${login})** [on GitHub](${comment.html_url}):\n\n${words}`;
}

/** The GitHub comment body for a tracker comment: who wrote it and where, their words, then a marker. */
export function gitHubCommentBody(
  comment: { id: string; body: string },
  author: { name: string; handle: string },
  issueUrl: string,
): string {
  return (
    `**${author.name}** (@${author.handle}) [in Poietic Issues](${issueUrl}):\n\n${comment.body.trimEnd()}` +
    `\n\n<!-- poietic-issues:comment:${comment.id} -->`
  );
}

const KEY = /^[A-Z][A-Z0-9]{1,9}$/;

/**
 * A project key for a repository: the initials of a multi-word name (`poietic-bridge` → `PB`), or the first
 * letters of a single word (`tracker` → `TRA`), made unique among `taken` with a numeric suffix.
 */
export function projectKeyFor(repoName: string, taken: Set<string>): string {
  const words = repoName
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  let base = words.length >= 2 ? words.map((w) => w[0]).join('') : (words[0] ?? '').slice(0, 3);
  base = base.replace(/^[0-9]+/, '').slice(0, 8);
  if (base.length < 2) base = `GH${base}`.slice(0, 8);
  if (!KEY.test(base)) base = 'GH';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const key = `${base}${n}`;
    if (!taken.has(key)) return key;
  }
}
