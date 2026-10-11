import { z } from 'zod';
import type { SsoOptions } from './env.ts';
import { createSsoLiveness } from './sso/liveness.ts';
import { createSsoVerifier } from './sso/verifier.ts';

const bool = (fallback: boolean) =>
  z
    .enum(['1', '0', 'true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === '1' || v === 'true'));

/**
 * Server configuration from environment variables (all prefixed `POIETIC_ISSUES_`). Validated at startup so a bad
 * deployment fails fast with a clear message. Defaults suit local development.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === 'production';
  const schema = z.object({
    POIETIC_ISSUES_DATABASE_URL: z.string().default('sqlite:./data/dev.db'),
    POIETIC_ISSUES_HOST: z.string().default(production ? '0.0.0.0' : '127.0.0.1'),
    POIETIC_ISSUES_PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    POIETIC_ISSUES_AUTH_MODE: z.enum(['dev', 'standard']).default(production ? 'standard' : 'dev'),
    POIETIC_ISSUES_AUTO_MIGRATE: bool(!production),
    POIETIC_ISSUES_SEED: bool(!production),
    POIETIC_ISSUES_WEB_DIR: z.string().optional(),
    POIETIC_ISSUES_SECURE_COOKIES: bool(production),
    POIETIC_ISSUES_BLOB_STORE: z.enum(['local', 's3']).default('local'),
    POIETIC_ISSUES_BLOB_DIR: z.string().default('./data/blobs'),
    POIETIC_ISSUES_S3_ENDPOINT: z.string().optional(),
    POIETIC_ISSUES_S3_BUCKET: z.string().optional(),
    POIETIC_ISSUES_S3_REGION: z.string().optional(),
    POIETIC_ISSUES_S3_ACCESS_KEY_ID: z.string().optional(),
    POIETIC_ISSUES_S3_SECRET_ACCESS_KEY: z.string().optional(),
    POIETIC_ISSUES_S3_FORCE_PATH_STYLE: z.string().optional(),
    POIETIC_ISSUES_S3_PRESIGN: z.string().optional(),
    POIETIC_ISSUES_S3_PUBLIC_ENDPOINT: z.string().optional(),
    /** Run the background webhook worker in this process (turn off on replicas that should only serve API). */
    POIETIC_ISSUES_WEBHOOKS: bool(true),
    /** Let webhooks use http and reach private/loopback addresses. Never enable in production. */
    POIETIC_ISSUES_WEBHOOK_ALLOW_PRIVATE: bool(!production),
    POIETIC_ISSUES_LOG_LEVEL: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
      .default(process.env.VITEST ? 'silent' : 'info'),
    /** `json` for log collectors (production default); `pretty` for terminals. */
    POIETIC_ISSUES_LOG_FORMAT: z.enum(['json', 'pretty']).default(production ? 'json' : 'pretty'),
    /** How long shutdown waits for in-flight requests before closing connections. */
    POIETIC_ISSUES_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),
    POIETIC_ISSUES_MAX_UPLOAD_MB: z.coerce.number().positive().max(1024).default(25),
    POIETIC_ISSUES_ALLOWED_ORIGINS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    /** SSO: enabled when the issuer is set. See docs/deployment.md "Single sign-on". */
    POIETIC_ISSUES_SSO_ISSUER: z.url().optional(),
    POIETIC_ISSUES_SSO_NAME: z.string().optional(),
    POIETIC_ISSUES_SSO_COOKIE: z.string().optional(),
    POIETIC_ISSUES_SSO_AUDIENCE: z.string().optional(),
    POIETIC_ISSUES_SSO_JWKS_URL: z.url().optional(),
    POIETIC_ISSUES_SSO_LOGIN_URL: z.url().optional(),
    POIETIC_ISSUES_SSO_REFRESH_URL: z.url().optional(),
    POIETIC_ISSUES_SSO_ADMIN_ROLE: z.string().default('admin'),
    /** The issuer's `/session/live`; when set, identity-token writes are refused once the session is revoked. */
    POIETIC_ISSUES_SSO_LIVENESS_URL: z.url().optional(),
  });
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${lines}`);
  }
  if (production && parsed.data.POIETIC_ISSUES_AUTH_MODE === 'dev')
    throw new Error('POIETIC_ISSUES_AUTH_MODE=dev is not allowed when NODE_ENV=production');
  if (production && parsed.data.POIETIC_ISSUES_WEBHOOK_ALLOW_PRIVATE)
    throw new Error('POIETIC_ISSUES_WEBHOOK_ALLOW_PRIVATE is not allowed when NODE_ENV=production');
  if (parsed.data.POIETIC_ISSUES_BLOB_STORE === 's3')
    for (const name of [
      'POIETIC_ISSUES_S3_ENDPOINT',
      'POIETIC_ISSUES_S3_BUCKET',
      'POIETIC_ISSUES_S3_ACCESS_KEY_ID',
      'POIETIC_ISSUES_S3_SECRET_ACCESS_KEY',
    ] as const)
      if (!parsed.data[name])
        throw new Error(`${name} is required when POIETIC_ISSUES_BLOB_STORE=s3`);
  if (parsed.data.POIETIC_ISSUES_SSO_ISSUER) {
    const missing = (
      [
        'POIETIC_ISSUES_SSO_COOKIE',
        'POIETIC_ISSUES_SSO_AUDIENCE',
        'POIETIC_ISSUES_SSO_JWKS_URL',
        'POIETIC_ISSUES_SSO_LOGIN_URL',
      ] as const
    ).filter((name) => !parsed.data[name]);
    if (missing.length)
      throw new Error(
        `${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} required when POIETIC_ISSUES_SSO_ISSUER is set`,
      );
  }
  return parsed.data;
}

export type ServerConfig = ReturnType<typeof loadConfig>;

/** SSO options for the app, or undefined when SSO is off. */
export function ssoOptionsFromConfig(config: ServerConfig): SsoOptions | undefined {
  const issuer = config.POIETIC_ISSUES_SSO_ISSUER;
  if (!issuer) return undefined;
  const audience = config.POIETIC_ISSUES_SSO_AUDIENCE!;
  return {
    name: config.POIETIC_ISSUES_SSO_NAME ?? new URL(issuer).hostname,
    cookie: config.POIETIC_ISSUES_SSO_COOKIE!,
    issuer,
    loginUrl: config.POIETIC_ISSUES_SSO_LOGIN_URL!,
    refreshUrl: config.POIETIC_ISSUES_SSO_REFRESH_URL,
    adminRole: config.POIETIC_ISSUES_SSO_ADMIN_ROLE,
    verifier: createSsoVerifier({ jwksUrl: config.POIETIC_ISSUES_SSO_JWKS_URL!, issuer, audience }),
    liveness: config.POIETIC_ISSUES_SSO_LIVENESS_URL
      ? createSsoLiveness({ url: config.POIETIC_ISSUES_SSO_LIVENESS_URL })
      : undefined,
  };
}
