import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { fontScheme } from '../common/theme-assets';
import {
  FONT_SIZE_LIMIT,
  ThemeFontCache,
  themeFontSchemes,
} from './theme-assets';

async function directory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'rally-theme-fonts-'));
}

function bytes(length: number): ArrayBuffer {
  return new Uint8Array(length).fill(7).buffer;
}

function integrityOf(value: ArrayBuffer): string {
  return `sha256-${createHash('sha256').update(new Uint8Array(value)).digest('base64')}`;
}

function ok(body: ArrayBuffer): Response {
  return new Response(body, { status: 200 });
}

describe('the remote font cache', () => {
  it('registers only the private font scheme', () => {
    expect(themeFontSchemes).toEqual([
      { scheme: fontScheme, privileges: { standard: true, secure: true } },
    ]);
  });

  const id = 'a'.repeat(32);
  const url = `${fontScheme}://cache/${id}.woff2`;
  const fonts = { [id]: { url: 'https://fonts.example/geist.woff2' } };

  it('fetches a font once and serves it from disk after that', async () => {
    const where = await directory();
    const body = bytes(64);
    const fetch = vi.fn(async () => ok(body));
    const cache = new ThemeFontCache({ directory: where, fetch, fonts });

    const first = await cache.respond(url);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('font/woff2');
    expect(await first.arrayBuffer()).toEqual(body);

    // A second cache reading the same directory is the next launch: the file is
    // there, so nothing is fetched. Reusing the same instance would prove only
    // that an in-memory map works.
    const relaunched = new ThemeFontCache({ directory: where, fetch, fonts });
    expect((await relaunched.respond(url)).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('serves the cached copy rather than reaching the network again', async () => {
    const where = await directory();
    const fetch = vi.fn(async () => ok(bytes(32)));
    await new ThemeFontCache({ directory: where, fetch, fonts }).respond(url);

    expect(await readdir(where)).toEqual([`${id}.woff2`]);
    expect(new Uint8Array(await readFile(join(where, `${id}.woff2`))).buffer).toEqual(bytes(32));
  });

  /**
   * Four faces of one family on the first paint are four asks for one file, and
   * they arrive together. Without this the application opens by downloading the
   * same font four times.
   */
  it('collapses concurrent asks for the same file into one fetch', async () => {
    // The deferred is built before the cache runs, not inside the first call:
    // `respond` awaits a missing file before it fetches, so a resolver captured
    // by the executor is not assigned yet at the point the test would call it.
    let release: (value: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const fetch = vi.fn(() => pending);
    const cache = new ThemeFontCache({ directory: await directory(), fetch, fonts });

    const asks = [cache.respond(url), cache.respond(url), cache.respond(url)];
    // `waitFor`'s one-second default bets on the machine rather than on the
    // code: reaching the fetch costs three real filesystem round trips, and a
    // loaded runner can leave an already-resolved continuation waiting longer
    // than that — failing as an assertion that never came true. The `main`
    // project has no setup file to widen this globally, so it is widened here.
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled(), { timeout: 5_000 });
    release(ok(bytes(16)));
    const responses = await Promise.all(asks);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
  });

  it('refuses bytes that do not match a declared integrity', async () => {
    const where = await directory();
    const fetch = vi.fn(async () => ok(bytes(48)));
    const cache = new ThemeFontCache({
      directory: where,
      fetch,
      fonts: { [id]: { url: fonts[id]!.url, integrity: integrityOf(bytes(49)) } },
    });

    expect((await cache.respond(url)).status).toBe(404);
    expect(await readdir(where)).toEqual([]);
  });

  it('accepts bytes that do match', async () => {
    const cache = new ThemeFontCache({
      directory: await directory(),
      fetch: async () => ok(bytes(48)),
      fonts: { [id]: { url: fonts[id]!.url, integrity: integrityOf(bytes(48)) } },
    });

    expect((await cache.respond(url)).status).toBe(200);
  });

  it.each([
    ['an empty body', 0],
    ['a file too large to be a font', FONT_SIZE_LIMIT + 1],
  ])('rejects %s', async (_label, length) => {
    const where = await directory();
    const cache = new ThemeFontCache({ directory: where, fetch: async () => ok(bytes(length)), fonts });

    expect((await cache.respond(url)).status).toBe(404);
    expect(await readdir(where)).toEqual([]);
  });

  it.each([
    ['a failing response', async () => new Response('nope', { status: 500 })],
    ['a fetch that throws', async () => { throw new Error('offline'); }],
  ])('answers 404 for %s rather than propagating it', async (_label, fetch) => {
    const cache = new ThemeFontCache({ directory: await directory(), fetch, fonts });

    expect((await cache.respond(url)).status).toBe(404);
  });

  /**
   * The id is the only thing that selects a file, and it comes off a URL the
   * renderer composed. Anything not in the generated table is a 404 before a
   * request is made — a theme cannot name a host at runtime.
   */
  it.each([
    [`${fontScheme}://cache/${'b'.repeat(32)}.woff2`, 'an id no theme declared'],
    [`${fontScheme}://cache/${id}.ttf`, 'a different extension'],
    [`${fontScheme}://cache/../../secret.woff2`, 'a traversal'],
    [`${fontScheme}://elsewhere/${id}.woff2`, 'another host'],
    [`https://fonts.example/${id}.woff2`, 'the remote URL itself'],
    ['not a url', 'nonsense'],
  ])('answers 404 for %s (%s)', async (candidate) => {
    const fetch = vi.fn(async () => ok(bytes(8)));
    const cache = new ThemeFontCache({ directory: await directory(), fetch, fonts });

    expect((await cache.respond(candidate)).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves no partial file behind when a write is interrupted', async () => {
    const where = await directory();
    await writeFile(join(where, `${id}.woff2.999.partial`), 'half a font');
    const cache = new ThemeFontCache({ directory: where, fetch: async () => ok(bytes(24)), fonts });

    const response = await cache.respond(url);

    expect(response.status).toBe(200);
    // The stale partial is not what got served, and the real file is named
    // without the suffix — the rename is what makes the file appear whole.
    expect(await response.arrayBuffer()).toEqual(bytes(24));
    expect(await readFile(join(where, `${id}.woff2`))).toHaveLength(24);
  });
});
