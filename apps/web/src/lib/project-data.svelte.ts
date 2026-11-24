import { createQuery } from '@tanstack/svelte-query';
import {
  ApiError,
  type CustomField,
  type IssueType,
  type Label,
  type Project,
  type Status,
  type User,
  type View,
} from './api.ts';
import { type Access, canManage, canWrite, fetchers, isSignedIn, keys } from './queries.ts';

export interface ProjectData {
  readonly key: string;
  readonly statuses: Status[];
  /** The project's issue types, in order: the values an issue's `type` can take. */
  readonly issueTypes: IssueType[];
  readonly labels: Label[];
  readonly users: User[];
  /** GitHub repositories linked to the project: the values an issue's `repo` can take. */
  readonly repos: Project['repos'];
  readonly views: View[];
  /** Active custom field definitions (they also feed the field registry). */
  readonly customFields: CustomField[];
  readonly loaded: boolean;
  /** The caller's level on the project (`myAccess`), once known. */
  readonly access: Access | undefined;
  /** May edit issues, comments, links and attachments. Cosmetic: the server stays the authority. */
  readonly canWrite: boolean;
  /** May change the project's settings. */
  readonly canManage: boolean;
  /** Signed in (not an anonymous visitor). */
  readonly signedIn: boolean;
  /** The project does not exist or is not readable (both are a 404). */
  readonly notFound: boolean;
  /**
   * Why the project's data could not be loaded, other than a 404 (a server or network error), while some of it is
   * still missing. A failed background refetch of data already shown is not an error here.
   */
  readonly error: Error | null;
  /** Refetches whatever failed to load. */
  retry(): void;
}

/**
 * Reactive reference data for a project (statuses, issue types, labels, users, views, fields), cached by TanStack Query.
 * Project queries wait for a key: global components (command menu, create dialog) mount before one is chosen.
 */
export function useProjectData(key: () => string): ProjectData {
  const me = createQuery(() => ({ queryKey: keys.me, queryFn: fetchers.me, staleTime: 300_000 }));
  const signedIn = $derived(isSignedIn(me.data));
  const project = createQuery(() => ({
    queryKey: keys.project(key()),
    queryFn: () => fetchers.project(key()),
    enabled: !!key(),
  }));
  const statuses = createQuery(() => ({
    queryKey: keys.statuses(key()),
    queryFn: () => fetchers.statuses(key()),
    enabled: !!key(),
  }));
  const issueTypes = createQuery(() => ({
    queryKey: keys.issueTypes(key()),
    queryFn: () => fetchers.issueTypes(key()),
    enabled: !!key(),
  }));
  const labels = createQuery(() => ({
    queryKey: keys.labels(key()),
    queryFn: () => fetchers.labels(key()),
    enabled: !!key(),
  }));
  // The user directory needs sign-in; signed-out visitors see people only as embedded in issues.
  const users = createQuery(() => ({
    queryKey: keys.users,
    queryFn: fetchers.users,
    staleTime: 60_000,
    enabled: signedIn,
  }));
  const views = createQuery(() => ({
    queryKey: keys.views(key()),
    queryFn: () => fetchers.views(key()),
    enabled: !!key(),
  }));
  const fields = createQuery(() => ({
    queryKey: keys.fields(key()),
    queryFn: () => fetchers.fields(key()),
    enabled: !!key(),
  }));
  /** What `loaded` waits for; a failure here is the project's error. */
  const required = [project, statuses, labels, users, fields];
  /**
   * Also retried, but optional: saved views or issue types failing to load leaves the project usable without
   * them (issues still show their own type).
   */
  const queries = [...required, views, issueTypes];
  return {
    get key() {
      return key();
    },
    get statuses() {
      return statuses.data ?? [];
    },
    get issueTypes() {
      return issueTypes.data ?? [];
    },
    get labels() {
      return labels.data ?? [];
    },
    get users() {
      return users.data ?? [];
    },
    get repos() {
      return project.data?.repos ?? [];
    },
    get views() {
      return views.data ?? [];
    },
    get customFields() {
      return fields.data ?? [];
    },
    get loaded() {
      // Read every query's status (no short-circuit): TanStack only notifies about result properties that
      // were read, so a status first read after it changed would never update this again.
      const [p, s, l, f, u, m] = [project, statuses, labels, fields, users, me].map(
        (q) => q.isSuccess,
      ) as [boolean, boolean, boolean, boolean, boolean, boolean];
      const anonymous = !signedIn;
      // People: the user directory, or nothing to wait for once `me` says the visitor is signed out.
      return p && s && l && f && (u || (m && anonymous));
    },
    get access() {
      return project.data?.myAccess;
    },
    get canWrite() {
      return canWrite(project.data?.myAccess);
    },
    get canManage() {
      return canManage(project.data?.myAccess);
    },
    get signedIn() {
      return signedIn;
    },
    get notFound() {
      return [project.error, statuses.error].some((e) => e instanceof ApiError && e.status === 404);
    },
    get error() {
      // Read data and error of every query (no short-circuit), for the same reason as `loaded`.
      const failures = required.map((q) => [q.data, q.error] as const);
      const failed = failures.find(
        ([data, error]) =>
          data === undefined && error && !(error instanceof ApiError && error.status === 404),
      );
      return failed?.[1] ?? null;
    },
    retry() {
      for (const q of queries) if (q.isError) void q.refetch();
    },
  };
}
