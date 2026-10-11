import { describe, expect, it } from 'vitest';
import { CliError } from './errors.ts';
import { agentFetch, retryingFetch } from './transport.ts';

const AUTH = 'https://auth.poietic.tech';
const SERVER = 'https://issues.example.test/api/v1/me';
const SECRET = 'pat_s3cret';

/** A fake auth service and tracker: records every request, answers the exchange with `status`. */
function network(status = 200) {
  const seen: { url: string; authorization: string | null }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push({ url: request.url, authorization: request.headers.get('authorization') });
    if (request.url === `${AUTH}/token`)
      return status === 200
        ? Response.json({
            access_token: 'identity.jwt.token',
            expires_in: 600,
            agent: { id: 'ag1', name: 'Helper', owner: 'u1', groups: [] },
          })
        : new Response('no', { status });
    return Response.json({ ok: true });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

describe('agentFetch', () => {
  it('is null without POIETIC_AGENT_TOKEN', () => {
    expect(agentFetch({})).toBeNull();
    expect(agentFetch({ POIETIC_AGENT_TOKEN: '' })).toBeNull();
  });

  it('sends the exchanged identity token to the server, and the agent token only to auth', async () => {
    const { seen, fetchImpl } = network();
    const fetch = agentFetch({ POIETIC_AGENT_TOKEN: SECRET }, { fetchImpl })!;
    expect((await fetch(new Request(SERVER))).status).toBe(200);
    expect(seen).toEqual([
      { url: `${AUTH}/token`, authorization: `Bearer ${SECRET}` },
      { url: SERVER, authorization: 'Bearer identity.jwt.token' },
    ]);
  });

  it('refuses a malformed token without echoing it', () => {
    let error: unknown;
    try {
      agentFetch({ POIETIC_AGENT_TOKEN: 'pat with spaces' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((error as Error).message).not.toContain('pat with');
  });

  it('turns a refused exchange into UNAUTHENTICATED, without retrying it', async () => {
    const { seen, fetchImpl } = network(401);
    const fetch = retryingFetch(agentFetch({ POIETIC_AGENT_TOKEN: SECRET }, { fetchImpl })!);
    await expect(fetch(new Request(SERVER))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(seen).toHaveLength(1);
  });
});
