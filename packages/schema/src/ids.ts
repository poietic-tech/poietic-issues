import { typeid } from 'typeid-js';

/**
 * Prefixes for TypeID-style identifiers (`<prefix>_<base32 UUIDv7>`).
 *
 * Every persisted entity gets a prefixed, time-ordered id so that an id is
 * self-describing: an agent (or a human reading logs) can tell an issue id
 * from a comment id at a glance, and APIs can reject ids of the wrong kind.
 *
 * Prefixes are part of the public API contract — never change an existing one.
 */
export const ID_PREFIXES = {
  user: 'usr',
  apiToken: 'tok',
  project: 'prj',
  status: 'sts',
  label: 'lbl',
  issue: 'iss',
  comment: 'cmt',
  linkType: 'lty',
  issueLink: 'lnk',
  customField: 'fld',
  customFieldOption: 'opt',
  fieldValue: 'fvl',
  attachment: 'att',
  view: 'viw',
  event: 'evt',
  webhook: 'whk',
  webhookDelivery: 'whd',
  projectRepo: 'rpo',
  issueType: 'typ',
} as const;

export type EntityKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[EntityKind];

/** Matches the TypeID suffix alphabet: 26 chars of Crockford base32, first char 0-7. */
const SUFFIX = '[0-7][0-9a-hjkmnp-tv-z]{25}';

/** Returns true if `value` is a well-formed id for the given entity kind. */
export function isIdOf(kind: EntityKind, value: string): boolean {
  return new RegExp(`^${ID_PREFIXES[kind]}_${SUFFIX}$`).test(value);
}

/** Generates a new time-ordered id for an entity kind, e.g. `newId('issue')` → `iss_01h455vb4pex5vsknk084sn02q`. */
export function newId(kind: EntityKind): string {
  return typeid(ID_PREFIXES[kind]).toString();
}

/** Human issue keys: `<PROJECT KEY>-<number>`, e.g. `ENG-42`. */
export const ISSUE_KEY_PATTERN = /^([A-Z][A-Z0-9]{1,9})-(\d+)$/;
export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

/** Parses `ENG-42` into its parts, or returns null. Case-insensitive on input (`eng-42` works). */
export function parseIssueKey(value: string): { projectKey: string; number: number } | null {
  const match = ISSUE_KEY_PATTERN.exec(value.trim().toUpperCase());
  if (!match) return null;
  return { projectKey: match[1]!, number: Number(match[2]) };
}

export function formatIssueKey(projectKey: string, number: number): string {
  return `${projectKey}-${number}`;
}
