import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { browserRequest } from '../../../../browser/src/transport';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it('serializes mobile exchange behind renewal through the browser cookie lock', async () => {
  // CI's Node 22 has no Web Locks API. Substitute the browser capability at
  // its boundary; exercise the real transport and observe HTTP dispatch order.
  const queues = new Map<string, Promise<unknown>>();
  const locks = {
    request<T>(name: string, callback: () => Promise<T>): Promise<T> {
      const result = (queues.get(name) ?? Promise.resolve()).then(callback);
      queues.set(name, result.catch(() => undefined));
      return result;
    },
  };
  vi.stubGlobal('navigator', { locks });
  const calls: string[] = [];
  const renewal = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    calls.push(url);
    return url.endsWith('/session/renew') ? renewal.promise : Promise.resolve(Response.json({ ok: true }));
  }));
  const schema = z.object({ ok: z.boolean() });
  const renewing = browserRequest('global', '/session/renew', schema, {});
  const exchange = browserRequest('global', '/mobile/exchange', schema, {});
  try {
    await vi.waitFor(() => expect(calls).toContain('/regional/global/browser/session/renew'));
    expect(calls).toEqual(['/regional/global/browser/session/renew']);
  } finally { renewal.resolve(Response.json({ ok: true })); }
  await Promise.all([renewing, exchange]);
  expect(calls).toEqual(['/regional/global/browser/session/renew', '/regional/global/browser/mobile/exchange']);
});
