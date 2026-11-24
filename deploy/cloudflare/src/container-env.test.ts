import { describe, expect, it } from 'vitest';
import { containerEnv, type WorkerEnv } from './container-env.ts';

const env: WorkerEnv = {
  PUBLIC_ORIGIN: 'https://issues.poietic.tech',
  R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  DB_BUCKET: 'poietic-issues-db',
  ATTACHMENTS_BUCKET: 'poietic-issues-attachments',
  SSO_NAME: 'poietic.tech',
  SSO_COOKIE: '__Secure-poietic-session',
  SSO_ISSUER: 'https://auth.poietic.tech',
  SSO_AUDIENCE: 'poietic:public',
  SSO_JWKS_URL: 'https://auth.poietic.tech/.well-known/jwks.json',
  SSO_LOGIN_URL: 'https://auth.poietic.tech/signin',
  SSO_REFRESH_URL: 'https://auth.poietic.tech/me',
  SSO_LIVENESS_URL: 'https://auth.poietic.tech/session/live',
  SSO_MEMBER_GROUP: 'issues-users',
  R2_ACCESS_KEY_ID: 'AKID',
  R2_SECRET_ACCESS_KEY: 'SECRET',
  SSO_DIRECTORY_KEY: 'ptk_dir',
};

describe('containerEnv', () => {
  it('maps Worker bindings to the tracker and Litestream environment', () => {
    expect(containerEnv(env)).toEqual({
      POIETIC_ISSUES_DATABASE_URL: 'sqlite:/data/tracker.db',
      POIETIC_ISSUES_SECURE_COOKIES: '1',
      POIETIC_ISSUES_ALLOWED_ORIGINS: 'https://issues.poietic.tech',
      POIETIC_ISSUES_LOG_FORMAT: 'json',
      POIETIC_ISSUES_BLOB_STORE: 's3',
      POIETIC_ISSUES_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
      POIETIC_ISSUES_S3_BUCKET: 'poietic-issues-attachments',
      POIETIC_ISSUES_S3_REGION: 'auto',
      POIETIC_ISSUES_S3_ACCESS_KEY_ID: 'AKID',
      POIETIC_ISSUES_S3_SECRET_ACCESS_KEY: 'SECRET',
      POIETIC_ISSUES_SSO_NAME: 'poietic.tech',
      POIETIC_ISSUES_SSO_COOKIE: '__Secure-poietic-session',
      POIETIC_ISSUES_SSO_ISSUER: 'https://auth.poietic.tech',
      POIETIC_ISSUES_SSO_AUDIENCE: 'poietic:public',
      POIETIC_ISSUES_SSO_JWKS_URL: 'https://auth.poietic.tech/.well-known/jwks.json',
      POIETIC_ISSUES_SSO_LOGIN_URL: 'https://auth.poietic.tech/signin',
      POIETIC_ISSUES_SSO_REFRESH_URL: 'https://auth.poietic.tech/me',
      POIETIC_ISSUES_SSO_LIVENESS_URL: 'https://auth.poietic.tech/session/live',
      POIETIC_ISSUES_SSO_MEMBER_GROUP: 'issues-users',
      POIETIC_ISSUES_SSO_DIRECTORY_KEY: 'ptk_dir',
      LITESTREAM_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
      LITESTREAM_BUCKET: 'poietic-issues-db',
      LITESTREAM_ACCESS_KEY_ID: 'AKID',
      LITESTREAM_SECRET_ACCESS_KEY: 'SECRET',
    });
  });

  it('stores attachments in artifacts, without an R2 fallback, once the tracker has an agent token', () => {
    const out = containerEnv({ ...env, ARTIFACTS_AGENT_TOKEN: 'agent-token' });
    expect(out).toMatchObject({
      POIETIC_ISSUES_BLOB_STORE: 'artifacts',
      POIETIC_ISSUES_ARTIFACTS_AGENT_TOKEN: 'agent-token',
    });
    expect(out).not.toHaveProperty('POIETIC_ISSUES_BLOB_FALLBACK');
    expect(containerEnv({ ...env, ARTIFACTS_AGENT_TOKEN: '' }).POIETIC_ISSUES_BLOB_STORE).toBe(
      's3',
    );
  });

  it('allows the public origin plus any extra origins, each once', () => {
    expect(
      containerEnv({
        ...env,
        EXTRA_ALLOWED_ORIGINS:
          ' https://newsroom.poietic.tech, https://newsroom-staging.poietic.tech,,https://issues.poietic.tech',
      }).POIETIC_ISSUES_ALLOWED_ORIGINS,
    ).toBe(
      'https://issues.poietic.tech,https://newsroom.poietic.tech,https://newsroom-staging.poietic.tech',
    );
  });

  it('refuses to start without the R2 credentials or the directory key', () => {
    expect(() => containerEnv({ ...env, R2_SECRET_ACCESS_KEY: '' })).toThrow(
      /R2_SECRET_ACCESS_KEY/,
    );
    expect(() => containerEnv({ ...env, SSO_DIRECTORY_KEY: '' })).toThrow(/SSO_DIRECTORY_KEY/);
  });
});
