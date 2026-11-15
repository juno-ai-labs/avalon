import { expect, it } from 'vitest';
import { requestArtifactAccess } from './artifact-access';

const canvas = { canvasId: 'shopping', resourceId: 'res 1', version: 3, title: 'Shopping' };
const directory = { workspacePath: '/app/workspaces/global/0193-work' };

it('asks the browser transport for fresh access on the session cookie, with the app origin', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ openUrl: 'https://site.rallyusercontent.com/__rally/open#c', canonicalUrl: 'https://site.rallyusercontent.com/', artifactId: 'a', mode: 'static', stateful: false }), { status: 200 });
  }) as typeof fetch;
  const access = await requestArtifactAccess('https://app.rallywith.ai', directory, canvas, fetchImpl);
  expect(access).toEqual({ ...canvas, openUrl: 'https://site.rallyusercontent.com/__rally/open#c', canonicalUrl: 'https://site.rallyusercontent.com/' });
  expect(calls[0]!.url).toBe('https://app.rallywith.ai/regional/global/browser/api/0193-work/resources/res%201/artifact/open');
  expect(calls[0]!.init).toMatchObject({ method: 'POST', credentials: 'include', headers: { Origin: 'https://app.rallywith.ai', 'x-rally-client-contract': expect.any(String) } });
});

it('returns null on a refusal, a malformed reply or a network failure, so the caller asks Home', async () => {
  const reply = (body: unknown, status: number) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  expect(await requestArtifactAccess('https://app.rallywith.ai', directory, canvas, reply({ error: { message: 'no' } }, 401))).toBeNull();
  expect(await requestArtifactAccess('https://app.rallywith.ai', directory, canvas, reply({ openUrl: 1 }, 200))).toBeNull();
  expect(await requestArtifactAccess('https://app.rallywith.ai', directory, canvas, (async () => { throw new TypeError('offline'); }) as unknown as typeof fetch)).toBeNull();
});
