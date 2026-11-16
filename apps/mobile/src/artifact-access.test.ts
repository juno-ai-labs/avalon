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
  const access = await requestArtifactAccess('https://app.rallywith.ai', directory, canvas, { fetchImpl });
  expect(access).toEqual({ ...canvas, openUrl: 'https://site.rallyusercontent.com/__rally/open#c', canonicalUrl: 'https://site.rallyusercontent.com/' });
  expect(calls[0]!.url).toBe('https://app.rallywith.ai/regional/global/browser/api/0193-work/resources/res%201/artifact/open');
  expect(calls[0]!.init).toMatchObject({ method: 'POST', credentials: 'include', headers: { Origin: 'https://app.rallywith.ai', 'x-rally-client-contract': expect.any(String) } });
});

it('returns null on a refusal, a malformed reply, a network failure or a timeout, naming each reason, so the caller asks Home', async () => {
  const reasons: string[] = [];
  const ask = (fetchImpl: typeof fetch, timeoutMs?: number) => requestArtifactAccess('https://app.rallywith.ai', directory, canvas, { fetchImpl, timeoutMs, report: (reason) => reasons.push(reason) });
  const reply = (body: unknown, status: number) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  expect(await ask(reply({ error: { message: 'no' } }, 401))).toBeNull();
  expect(await ask(reply({ openUrl: 1 }, 200))).toBeNull();
  expect(await ask((async () => { throw new TypeError('offline'); }) as unknown as typeof fetch)).toBeNull();
  const hung = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  })) as unknown as typeof fetch;
  expect(await ask(hung, 5)).toBeNull();
  expect(reasons).toEqual(['http_401', 'artifact_access_invalid:openUrl:invalid_type:canonicalUrl:invalid_type', 'network_error', 'timed_out']);
});
