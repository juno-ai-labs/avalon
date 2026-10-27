import { describe, expect, it } from 'vitest';
import worker from '../worker/index';
import { LANDING_CSP } from '../worker/landing-csp';

const GLOBAL_CSP = "default-src 'self'; script-src 'self'";

/** The asset layer's response as production served it: the global policy appended after the landing one. */
function assets(pathname: string) {
  return {
    fetch: async (request: Request) => {
      expect(new URL(request.url).pathname).toBe(pathname);
      const headers = new Headers({ 'Content-Type': 'text/html', 'X-Frame-Options': 'DENY' });
      headers.append('Content-Security-Policy', LANDING_CSP);
      headers.append('Content-Security-Policy', GLOBAL_CSP);
      return new Response('<!doctype html>', { headers });
    },
  };
}

describe('the homepage served through the site Worker', () => {
  it('carries exactly one CSP, the landing policy, and keeps the other headers', async () => {
    const response = await worker.fetch(new Request('https://rallywith.ai/'), { ASSETS: assets('/') });
    expect([response.headers.get('Content-Security-Policy'), response.headers.get('X-Frame-Options'), await response.text()])
      .toEqual([LANDING_CSP, 'DENY', '<!doctype html>']);
  });
});
