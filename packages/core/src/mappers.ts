import { type Database, fromJson, type Selectable, toBool } from '@poietic-tech/issues-db';
import type {
  ApiToken,
  Comment,
  Label,
  LinkType,
  Project,
  ProjectRepo,
  Status,
  User,
  UserOwner,
  UserSummary,
  View,
} from '@poietic-tech/issues-schema';
import { migrateViewConfig } from '@poietic-tech/issues-schema';

type Row<T extends keyof Database> = Selectable<Database[T]>;

/** The owner reference for a user row joined to its owner's handle (null when there is no owner). */
export function toUserOwner(
  ownerId: string | null,
  ownerHandle: string | null | undefined,
): UserOwner | null {
  return ownerId && ownerHandle ? { id: ownerId, handle: ownerHandle } : null;
}

export function toUser(r: Row<'users'>, ownerHandle: string | null): User {
  return {
    id: r.id,
    handle: r.handle,
    name: r.name,
    kind: r.kind,
    avatarUrl: r.avatar_url,
    owner: toUserOwner(r.owner_id, ownerHandle),
    email: r.email,
    role: r.role,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deactivatedAt: r.deactivated_at,
    ownerId: r.owner_id,
  };
}

export function toUserSummary(
  u: Pick<User, 'id' | 'handle' | 'name' | 'kind' | 'avatarUrl'>,
  owner: UserOwner | null,
): UserSummary {
  return { id: u.id, handle: u.handle, name: u.name, kind: u.kind, avatarUrl: u.avatarUrl, owner };
}

export function toApiToken(r: Row<'api_tokens'>): ApiToken {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    prefix: r.prefix,
    scopes: fromJson<string[]>(r.scopes, []),
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
  };
}

export function toProject(r: Row<'projects'>, repos: ProjectRepo[] = []): Project {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    visibility: r.visibility,
    repos,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at,
  };
}

export function toStatus(r: Row<'statuses'>): Status {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    category: r.category,
    color: r.color,
    position: r.position,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function toLabel(r: Row<'labels'>): Label {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    color: r.color,
    description: r.description,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function toLinkType(r: Row<'link_types'>): LinkType {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    outwardLabel: r.outward_label,
    inwardLabel: r.inward_label,
    symmetric: toBool(r.symmetric),
    builtIn: toBool(r.built_in),
  };
}

export function toComment(r: Row<'comments'>, author: UserSummary): Comment {
  return {
    id: r.id,
    issueId: r.issue_id,
    authorId: r.author_id,
    author,
    body: r.body,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    editedAt: r.edited_at,
    deletedAt: r.deleted_at,
  };
}

export function toView(r: Row<'views'>): View {
  return {
    id: r.id,
    projectId: r.project_id,
    ownerId: r.owner_id,
    name: r.name,
    layout: r.layout,
    config: migrateViewConfig(fromJson(r.config, {})),
    position: r.position,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
