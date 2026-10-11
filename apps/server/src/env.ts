import type { OpenAPIHono } from '@hono/zod-openapi';
import type {
  Actor,
  BlobStore,
  Clock,
  EventTailer,
  IdGenerator,
  ServiceContext,
  WebhookPolicy,
} from '@poietic-tech/issues-core';
import type { Db } from '@poietic-tech/issues-db';
import type { Logger } from './logger.ts';
import type { SsoVerifier } from './sso/verifier.ts';

/** Single sign-on with a JWT that a shared issuer keeps in a cookie. */
export interface SsoOptions {
  /** Shown on the sign-in button, e.g. "poietic.tech". */
  name: string;
  /** Cookie holding the issuer's JWT. */
  cookie: string;
  /** The issuer (`iss`); identities are stored under it. */
  issuer: string;
  /** Where to send a browser without a valid cookie; the tracker appends `redirect=<sign-in URL>`. */
  loginUrl: string;
  /** Optional endpoint the browser calls (with credentials) to renew a lapsed cookie before signing in. */
  refreshUrl?: string | undefined;
  /** Token `role` that makes a new user an active admin. */
  adminRole: string;
  verifier: SsoVerifier;
}

/**
 * How requests are authenticated.
 * - `standard`: bearer tokens (`Authorization: Bearer trk_…`) and web session cookies. With `allowDevLogin`,
 *   `POST /auth/dev-login` lets the web UI sign in as any user — development only.
 * - `trusted`: every request acts as a fixed user, no credentials. Used only in-process by the CLI's local mode
 *   (which already has direct database access); never mounted on a listening server.
 */
export type AuthConfig =
  | {
      mode: 'standard';
      allowDevLogin?: boolean;
      secureCookies?: boolean;
      allowedOrigins?: string[];
      sso?: SsoOptions | undefined;
    }
  | { mode: 'trusted'; actor: string };

export interface AppDeps {
  /** Database handle; resolved lazily so the app (and its OpenAPI document) can be built without one. */
  db?: Db | (() => Db);
  auth?: AuthConfig;
  clock?: Clock;
  ids?: IdGenerator;
  /** Directory with the built web app to serve at `/` (production). */
  webDir?: string;
  /** Where attachment bytes are stored. Without one, attachment routes answer 503. */
  blobStore?: BlobStore;
  /** Upload size limit in bytes (default 25 MB). */
  maxUploadBytes?: number;
  /** How webhooks may reach the network (default: https to public addresses only). */
  webhooks?: WebhookPolicy;
  /** Follows the event log for live streaming (`GET /events/stream`) and webhooks. */
  tailer?: EventTailer;
  /** Structured logger (default: silent — embedded apps such as tests and the CLI stay quiet). */
  logger?: Logger;
  /** Aborted when the server begins shutting down: long-lived streams end so clients reconnect elsewhere. */
  shutdownSignal?: AbortSignal;
  /** Extra hooks for features that attach to the app (attachments, …). */
  extensions?: AppExtension[];
}

export type AppExtension = (app: TrackerApp, deps: ResolvedDeps) => void;

export interface ResolvedDeps extends Omit<AppDeps, 'db'> {
  getDb(): Db;
  auth: AuthConfig;
}

export interface AppEnv {
  Variables: {
    requestId: string;
    logger: Logger;
    actor: Actor | null;
    authVia: 'bearer' | 'session' | 'trusted' | null;
    ctx: ServiceContext;
  };
}

export type TrackerApp = OpenAPIHono<AppEnv>;

export const SESSION_COOKIE = 'poietic_issues_session';
/** Pre-rename cookie name, still accepted for one release (ADR 0020). */
export const LEGACY_SESSION_COOKIE = 'tracker_session';
export const API_PREFIX = '/api/v1';
