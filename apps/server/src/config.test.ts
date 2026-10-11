import { describe, expect, it } from 'vitest';
import { loadConfig, ssoOptionsFromConfig } from './config.ts';

const SSO = {
  POIETIC_ISSUES_SSO_ISSUER: 'https://auth.example.test',
  POIETIC_ISSUES_SSO_COOKIE: '__Secure-example-session',
  POIETIC_ISSUES_SSO_AUDIENCE: 'example:public',
  POIETIC_ISSUES_SSO_JWKS_URL: 'https://auth.example.test/.well-known/jwks.json',
  POIETIC_ISSUES_SSO_LOGIN_URL: 'https://auth.example.test/',
};

describe('SSO configuration', () => {
  it('is off unless POIETIC_ISSUES_SSO_ISSUER is set', () => {
    expect(ssoOptionsFromConfig(loadConfig({}))).toBeUndefined();
  });

  it('requires the cookie, audience, JWKS and login URL with an issuer', () => {
    expect(() => loadConfig({ POIETIC_ISSUES_SSO_ISSUER: 'https://auth.example.test' })).toThrow(
      /POIETIC_ISSUES_SSO_COOKIE, POIETIC_ISSUES_SSO_AUDIENCE, POIETIC_ISSUES_SSO_JWKS_URL, POIETIC_ISSUES_SSO_LOGIN_URL are required/,
    );
    expect(() => loadConfig({ ...SSO, POIETIC_ISSUES_SSO_AUDIENCE: undefined })).toThrow(
      /POIETIC_ISSUES_SSO_AUDIENCE is required/,
    );
  });

  it('builds options with defaults', () => {
    const sso = ssoOptionsFromConfig(loadConfig(SSO))!;
    expect(sso).toMatchObject({
      name: 'auth.example.test',
      cookie: '__Secure-example-session',
      issuer: 'https://auth.example.test',
      loginUrl: 'https://auth.example.test/',
      adminRole: 'admin',
    });
    expect(sso.refreshUrl).toBeUndefined();
    expect(typeof sso.verifier.verify).toBe('function');
    expect(sso.liveness).toBeUndefined();
  });

  it('checks session liveness only when POIETIC_ISSUES_SSO_LIVENESS_URL is set', () => {
    const sso = ssoOptionsFromConfig(
      loadConfig({
        ...SSO,
        POIETIC_ISSUES_SSO_LIVENESS_URL: 'https://auth.example.test/session/live',
      }),
    )!;
    expect(typeof sso.liveness?.isLive).toBe('function');
  });
});
