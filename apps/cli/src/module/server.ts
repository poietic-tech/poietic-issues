import { findProjectConfig, PROJECT_CONFIG_FILE } from '../config.ts';
import { usage } from '../errors.ts';

export const DEFAULT_SERVER = 'https://issues.poietic.tech';

/**
 * Where the poietic-tech login may be sent: the host's caller attaches an identity token only to https on a
 * `*.poietic.tech` host.
 */
export function maySendLogin(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    url.hostname.endsWith('.poietic.tech') &&
    url.username === '' &&
    url.password === ''
  );
}

/**
 * The issues server's origin: `POIETIC_ISSUES_SERVER`, then the `server` of `.poietic-issues.json` (found walking
 * up from `cwd`), else https://issues.poietic.tech. Throws a usage error, before any network or credential
 * access, for a server the login may not go to, and for a project file holding a token.
 */
export function resolveServer(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): string {
  let value = env.POIETIC_ISSUES_SERVER;
  let source = 'POIETIC_ISSUES_SERVER';
  if (value === undefined || value === '') {
    const found = findProjectConfig(cwd);
    value = found?.config.server;
    source = found?.path ?? PROJECT_CONFIG_FILE;
  }
  if (value === undefined || value === '') return DEFAULT_SERVER;
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (!url || !maySendLogin(url))
    throw usage(
      `The issues server from ${source} (${url ? url.origin : 'not a URL'}) must be https on a *.poietic.tech host: ` +
        'only there may your poietic-tech login be sent. The operator tool, poietic-issues-admin, works on a local database.',
    );
  return url.origin;
}
