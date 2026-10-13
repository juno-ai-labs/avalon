// `/marks/<shape>/<color>/<icon>.png`: a Channel's, thread's or Breakout's
// mark as an image, for surfaces that can show a picture but not the app's
// SVG components — a Slack unfurl first. See docs/marks.md.
//
// Drawn on request rather than built: 264 icons, 19 colours and two shapes are
// over ten thousand files, nearly all never asked for. A drawn mark is cached
// at the edge for a year, so each one is drawn about once per location.

import { parseMarkImagePath, type Mark } from '@rally/contracts/marks';
import { PALETTE_INK, PALETTE_RING, type PaletteKey } from '@rally/contracts/palette';
import { Resvg } from '@resvg/resvg-wasm';

import base from '../../../config/design-tokens/base.json';
import light from '../../../config/design-tokens/themes/light.json';

export interface MarkEnv {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

/** Pixels per side. Slack shows an accessory image at up to 88pt, so this is crisp at 1.5x. */
export const MARK_IMAGE_SIZE = 128;

const tokens: Record<string, string> = { ...base.tokens, ...light.tokens };
const PASTEL: ReadonlySet<string> = new Set(PALETTE_RING);

function token(name: string): string {
  const value = tokens[name];
  if (!value) throw new Error(`marks: design token ${name} is missing`);
  return value;
}

/**
 * The fill and the glyph's ink, as `markColors` in `@rally/ui` picks them: a
 * ring colour is its pastel tint with its own ink, and `black` and the retired
 * colours are the hue itself with the ink `PALETTE_INK` names. The light
 * appearance's values, since an image cannot follow the reader's theme.
 */
export function markColors(color: PaletteKey): { tint: string; ink: string } {
  if (PASTEL.has(color)) return { tint: token(`sys.color.project-tint.${color}`), ink: token(`sys.color.project-ink.${color}`) };
  return { tint: token(`sys.color.project.${color}`), ink: token(`sys.color.palette-ink.${PALETTE_INK[color] === 'white' ? 'light' : 'dark'}`) };
}

/**
 * The mark as one SVG: the shape filled with the tint, the glyph centred on it
 * in the ink. Sizes follow the app — a thread's circle carries its glyph at
 * half its width (`WorkstreamGlyph`), a Channel's squircle at 47% with corners
 * of 32% (`IdentityTile`).
 */
export function markSvg(mark: Mark, glyphSvg: string): string {
  const { tint, ink } = markColors(mark.color);
  const size = MARK_IMAGE_SIZE;
  const circle = mark.shape === 'circle';
  const glyph = Math.round(size * (circle ? 0.5 : 0.47));
  const offset = (size - glyph) / 2;
  const shape = circle
    ? `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${tint}"/>`
    : `<rect width="${size}" height="${size}" rx="${size * 0.32}" fill="${tint}"/>`;
  // Re-anchor the glyph's own root: its size and position are the mark's, and
  // its `currentColor` stroke becomes the ink.
  const inner = glyphSvg
    .replace(/^<svg\b[^>]*>/u, `<svg x="${offset}" y="${offset}" width="${glyph}" height="${glyph}" viewBox="0 0 24 24" fill="none" stroke="${ink}" stroke-width="${circle ? 1.9 : 1.8}" stroke-linecap="round" stroke-linejoin="round">`)
    .replaceAll('currentColor', ink);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${shape}${inner}</svg>`;
}

const notFound = (): Response => new Response('Not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=300' } });

/**
 * Answer one `/marks/...` request. `ready` initialises the renderer's
 * WebAssembly, which the caller owns because a Worker and a Node test load it
 * differently. An unknown shape, colour or icon is a 404, so the address space
 * is exactly the vocabulary.
 */
export async function serveMark(request: Request, env: MarkEnv, ready: () => Promise<void>): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/marks/glyphs/')) return env.ASSETS.fetch(request);
  const mark = parseMarkImagePath(url.pathname);
  if (!mark || (request.method !== 'GET' && request.method !== 'HEAD')) return notFound();
  const glyph = await env.ASSETS.fetch(new Request(new URL(`/marks/glyphs/${mark.icon}.svg`, url)));
  // Every storable key has a glyph in the same build, so a miss is a broken
  // deploy, not a bad request; say so rather than serve a 404 for a year.
  if (!glyph.ok) return new Response(`glyph_missing:${mark.icon}`, { status: 500 });
  await ready();
  const png = new Uint8Array(new Resvg(markSvg(mark, await glyph.text())).render().asPng());
  return new Response(request.method === 'HEAD' ? null : png, {
    headers: {
      'Content-Type': 'image/png',
      // Keys are stored values that never change meaning; a palette retune is
      // accepted as stale until the edge evicts it.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
