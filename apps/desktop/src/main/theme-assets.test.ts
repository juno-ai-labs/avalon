import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { backdropScheme, fontScheme } from '../common/theme-assets';
import {
  BACKDROP_CONTENT_SECURITY_POLICY,
  FONT_SIZE_LIMIT,
  ThemeFontCache,
  backdropDocumentFor,
  backdropResponse,
  backdropUrl,
  isBackdropUrl,
  themeAssetSchemes,
} from './theme-assets';

const DOCUMENTS = { air: '<!doctype html><html><body>orbs</body></html>' };

async function directory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'avalon-theme-fonts-'));
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

describe('backdrop documents', () => {
  it('serves the document a theme id names', () => {
    expect(backdropDocumentFor(backdropUrl('air'), DOCUMENTS)).toBe(DOCUMENTS.air);
  });

  it.each([
    [`${backdropScheme}://theme/neu`, 'a theme with no backdrop'],
    [`${backdropScheme}://elsewhere/air`, 'another host on the scheme'],
    [`${backdropScheme}://theme/../../etc/passwd`, 'a traversal'],
    [`${backdropScheme}://theme/`, 'no theme at all'],
    ['app://rally/index.html', "the renderer's own scheme"],
    ['not a url', 'nonsense'],
  ])('serves nothing for %s (%s)', (url) => {
    expect(backdropDocumentFor(url, DOCUMENTS)).toBeNull();
    expect(backdropResponse(url, DOCUMENTS).status).toBe(404);
  });

  /**
   * The policy is the other half of the sandbox attribute on the frame, and both
   * halves are load-bearing. Without `default-src 'none'` a backdrop could call
   * out and report that it had been rendered; without the sandbox its inline
   * script would be running in the application's own origin.
   */
  it('permits painting and denies everything else', () => {
    const response = backdropResponse(backdropUrl('air'), DOCUMENTS);
    const policy = response.headers.get('content-security-policy') ?? '';

    expect(policy).toBe(BACKDROP_CONTENT_SECURITY_POLICY);
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain('connect-src');
    expect(policy).not.toMatch(/\bhttps:/u);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });

  /**
   * The response carries its own policy, so the window's must not be attached
   * alongside it — that one ends in `frame-ancestors 'none'`, and a backdrop
   * that cannot be framed never renders. This is the predicate `index.ts` uses
   * to leave the response alone.
   */
  it('is recognisable to the header handler that must skip it', () => {
    expect(isBackdropUrl(backdropUrl('air'))).toBe(true);
    expect(isBackdropUrl('app://rally/index.html')).toBe(false);
  });

  it('registers both schemes without the privileges a fetch would need', () => {
    expect(themeAssetSchemes.map((entry) => entry.scheme)).toEqual([backdropScheme, fontScheme]);
    for (const { privileges } of themeAssetSchemes) {
      expect(privileges).toEqual({ standard: true, secure: true });
    }
  });
});

describe('the remote font cache', () => {
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
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
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
