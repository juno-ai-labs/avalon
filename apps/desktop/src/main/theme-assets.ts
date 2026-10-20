/**
 * The cache behind `rally-font://cache/<id>.woff2`.
 *
 * A design-token file may name a remote font. The main process fetches it once
 * and keeps it; the renderer only ever asks for this private scheme, so opening
 * Rally does not repeatedly contact a font host. Nothing here imports Electron:
 * the fetch function and protocol registration are supplied by `index.ts`,
 * keeping the parsing and cache independently testable.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cachedFonts, fontScheme } from '../common/theme-assets';
import { logWarn } from '../common/logger';
/** Deliberately narrower than the renderer: the scheme itself fetches nothing. */
export const themeFontSchemes = [
  { scheme: fontScheme, privileges: { standard: true, secure: true } },
];

const FONT_HOST = 'cache';
const FONT_FILE = /^\/([0-9a-f]{32})\.woff2$/u;

/** A file larger than this is not a font file. */
export const FONT_SIZE_LIMIT = 8 * 1024 * 1024;

function notFound(): Response {
  return new Response('Not found', { status: 404 });
}

function integrityOf(bytes: ArrayBuffer): string {
  return `sha256-${createHash('sha256').update(new Uint8Array(bytes)).digest('base64')}`;
}

export interface ThemeFontCacheOptions {
  directory: string;
  /** The shared Electron fetch adapter in the application; a stub in tests. */
  fetch: (url: string) => Promise<Response>;
  fonts?: Record<string, { url: string; integrity?: string }>;
}

/**
 * A font file a theme named by URL, fetched once and then kept.
 *
 * Keyed by a hash of the URL rather than of the bytes, because the stylesheet
 * has to name the file before anything has been fetched. Nothing invalidates: a
 * font at a URL is immutable in practice, and a theme that wants different bytes
 * changes the URL, which changes the key, which misses. That is what makes this
 * a cache with no expiry rather than one with a wrong expiry.
 */
export class ThemeFontCache {
  private readonly inFlight = new Map<string, Promise<ArrayBuffer | null>>();
  private readonly directory: string;
  private readonly fetch: (url: string) => Promise<Response>;
  private readonly fonts: Record<string, { url: string; integrity?: string }>;

  constructor(options: ThemeFontCacheOptions) {
    this.directory = options.directory;
    this.fetch = options.fetch;
    this.fonts = options.fonts ?? cachedFonts;
  }

  private path(id: string): string {
    return join(this.directory, `${id}.woff2`);
  }

  /**
   * The cached bytes, fetching them first if this is the first ask.
   *
   * An `ArrayBuffer` rather than the `Buffer` `readFile` returns, because a
   * `Buffer` is a view onto a shared pool: handing its backing store to a
   * `Response` would send whatever else the pool happens to hold.
   */
  async bytes(id: string): Promise<ArrayBuffer | null> {
    const font = Object.hasOwn(this.fonts, id) ? this.fonts[id] : undefined;
    if (!font) return null;

    try {
      return new Uint8Array(await readFile(this.path(id))).buffer;
    } catch {
      // Not cached yet.
    }

    // One fetch per file, however many faces ask at once. A stylesheet naming
    // the same family at four weights would otherwise start four downloads of
    // the same bytes on the first paint.
    const existing = this.inFlight.get(id);
    if (existing) return existing;

    const download = this.download(id, font).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, download);
    return download;
  }

  private async download(
    id: string,
    font: { url: string; integrity?: string },
  ): Promise<ArrayBuffer | null> {
    try {
      const response = await this.fetch(font.url);
      if (!response.ok) {
        logWarn('rally', 'theme font fetch failed', { id, status: response.status });
        return null;
      }
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength === 0 || bytes.byteLength > FONT_SIZE_LIMIT) {
        logWarn('rally', 'theme font rejected for size', { id, bytes: bytes.byteLength });
        return null;
      }
      if (font.integrity && integrityOf(bytes) !== font.integrity) {
        logWarn('rally', 'theme font failed its integrity check', { id });
        return null;
      }

      // Written beside the target and renamed, so a launch interrupted mid-write
      // leaves no half-file that every later launch would serve as a valid font.
      await mkdir(this.directory, { recursive: true });
      const staging = `${this.path(id)}.${process.pid}.partial`;
      await writeFile(staging, new Uint8Array(bytes));
      await rename(staging, this.path(id));
      return bytes;
    } catch (error) {
      logWarn('rally', 'theme font could not be fetched', { id, error: String(error) });
      return null;
    }
  }

  /** The response for a font URL, or a 404 for anything this build did not name. */
  async respond(url: string): Promise<Response> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return notFound();
    }
    if (parsed.protocol !== `${fontScheme}:` || parsed.host !== FONT_HOST) return notFound();
    const match = FONT_FILE.exec(decodeURIComponent(parsed.pathname));
    if (!match) return notFound();

    const bytes = await this.bytes(match[1]!);
    if (!bytes) return notFound();
    return new Response(bytes, {
      headers: {
        'content-type': 'font/woff2',
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  }
}
