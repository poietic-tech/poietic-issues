import { describe, expect, it } from 'vitest';
import { TARGET_PORT_HEADER, withoutTargetPort } from './forward.ts';

describe('withoutTargetPort', () => {
  it('drops a client-supplied target port and keeps everything else', () => {
    const request = new Request('https://issues.poietic.tech/api/v1/projects?x=1', {
      method: 'DELETE',
      headers: { [TARGET_PORT_HEADER]: '9229', authorization: 'Bearer id_x', cookie: 'a=b' },
    });
    const forwarded = withoutTargetPort(request);
    expect(forwarded.headers.has(TARGET_PORT_HEADER)).toBe(false);
    expect(forwarded.method).toBe('DELETE');
    expect(forwarded.url).toBe(request.url);
    expect(forwarded.headers.get('authorization')).toBe('Bearer id_x');
    expect(forwarded.headers.get('cookie')).toBe('a=b');
  });

  it('passes a request without the header through unchanged', () => {
    const request = new Request('https://issues.poietic.tech/healthz');
    expect(withoutTargetPort(request)).toBe(request);
  });
});
