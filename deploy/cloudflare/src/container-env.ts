/** Worker bindings: `vars` in wrangler.jsonc (R2_ENDPOINT via `--var` at deploy) and secrets set by CI. */
export interface WorkerEnv {
  PUBLIC_ORIGIN: string;
  R2_ENDPOINT: string;
  DB_BUCKET: string;
  SSO_NAME: string;
  SSO_COOKIE: string;
  SSO_ISSUER: string;
  SSO_AUDIENCE: string;
  SSO_JWKS_URL: string;
  SSO_LOGIN_URL: string;
  SSO_REFRESH_URL: string;
  SSO_LIVENESS_URL: string;
  SSO_MEMBER_GROUP: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  /** auth.poietic.tech service key for its directory API (ADR 0027). */
  SSO_DIRECTORY_KEY: string;
  /**
   * Other sites whose pages call the API with the visitor's cookie (comma-separated origins), e.g. the newsroom,
   * which files feedback as the signed-in person. Added to PUBLIC_ORIGIN in POIETIC_ISSUES_ALLOWED_ORIGINS.
   */
  EXTRA_ALLOWED_ORIGINS?: string;
  /**
   * The tracker's own agent token at auth.poietic.tech (ADR 0037). Attachments are stored in its artifacts
   * collection; the old R2 attachments bucket was copied in and retired on 2026-11-24.
   */
  ARTIFACTS_AGENT_TOKEN: string;
}

/** PUBLIC_ORIGIN, then each extra origin once (trimmed, empty entries dropped). */
function allowedOrigins(env: WorkerEnv): string {
  const extra = (env.EXTRA_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return [...new Set([env.PUBLIC_ORIGIN, ...extra])].join(',');
}

const REQUIRED = [
  'PUBLIC_ORIGIN',
  'R2_ENDPOINT',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'SSO_DIRECTORY_KEY',
  'ARTIFACTS_AGENT_TOKEN',
] as const;

/**
 * The container's environment. The tracker image's own defaults (NODE_ENV=production, port 3000, /data) stay;
 * this adds storage, the public origin and SSO. POIETIC_ISSUES_ALLOWED_ORIGINS is needed because Containers forward the
 * request with its scheme downgraded to http, so the browser's https Origin would not match the request URL and the
 * tracker's same-origin check would reject writes. Litestream reads the LITESTREAM_* values through litestream.yml.
 */
export function containerEnv(env: WorkerEnv): Record<string, string> {
  for (const name of REQUIRED)
    if (!env[name]) throw new Error(`${name} is not set on the poietic-issues Worker`);
  return {
    POIETIC_ISSUES_DATABASE_URL: 'sqlite:/data/tracker.db',
    POIETIC_ISSUES_SECURE_COOKIES: '1',
    POIETIC_ISSUES_ALLOWED_ORIGINS: allowedOrigins(env),
    POIETIC_ISSUES_LOG_FORMAT: 'json',
    POIETIC_ISSUES_BLOB_STORE: 'artifacts',
    POIETIC_ISSUES_ARTIFACTS_AGENT_TOKEN: env.ARTIFACTS_AGENT_TOKEN,
    POIETIC_ISSUES_SSO_NAME: env.SSO_NAME,
    POIETIC_ISSUES_SSO_COOKIE: env.SSO_COOKIE,
    POIETIC_ISSUES_SSO_ISSUER: env.SSO_ISSUER,
    POIETIC_ISSUES_SSO_AUDIENCE: env.SSO_AUDIENCE,
    POIETIC_ISSUES_SSO_JWKS_URL: env.SSO_JWKS_URL,
    POIETIC_ISSUES_SSO_LOGIN_URL: env.SSO_LOGIN_URL,
    POIETIC_ISSUES_SSO_REFRESH_URL: env.SSO_REFRESH_URL,
    POIETIC_ISSUES_SSO_LIVENESS_URL: env.SSO_LIVENESS_URL,
    POIETIC_ISSUES_SSO_MEMBER_GROUP: env.SSO_MEMBER_GROUP,
    POIETIC_ISSUES_SSO_DIRECTORY_KEY: env.SSO_DIRECTORY_KEY,
    LITESTREAM_ENDPOINT: env.R2_ENDPOINT,
    LITESTREAM_BUCKET: env.DB_BUCKET,
    LITESTREAM_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
    LITESTREAM_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
  };
}
