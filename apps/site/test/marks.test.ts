import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { initWasm } from '@resvg/resvg-wasm';
import sharp from 'sharp';

import { markGlyphFiles } from '../src/mark-glyphs';
import { serveMark } from '../worker/marks';

const glyphs = new Map(markGlyphFiles().map(([path, svg]) => [`/${path}`, svg]));
const env = {
  ASSETS: {
    fetch: async (request: Request) => {
      const svg = glyphs.get(new URL(request.url).pathname);
      return svg ? new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } }) : new Response('', { status: 404 });
    },
  },
};
let started: Promise<void> | null = null;
const ready = () => {
  started ??= initWasm(readFileSync(createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm')));
  return started;
};
const get = (path: string) => serveMark(new Request(`https://rallywith.ai${path}`), env, ready);

async function pixel(response: Response, x: number, y: number): Promise<string> {
  const { data, info } = await sharp(Buffer.from(await response.arrayBuffer())).raw().ensureAlpha()
    .toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * 4;
  return [...data.subarray(at, at + 4)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

describe('/marks', () => {
  it('given a thread mark, when it is requested, then it is a 128px circle in the pastel tint with the ink glyph', async () => {
    const response = await get('/marks/circle/violet/database.png');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    const meta = await sharp(Buffer.from(await response.clone().arrayBuffer())).metadata();
    expect([meta.width, meta.height]).toEqual([128, 128]);
    expect(await pixel(response.clone(), 64, 4)).toBe('e8e4ffff');
    expect(await pixel(response.clone(), 2, 2)).toBe('00000000');
    // The top of the database glyph's ellipse: y=2 on its 24-unit grid, 64px wide at 32px in.
    expect(await pixel(response, 64, 37)).toBe('5f499cff');
  });

  it('given a Channel mark, when it is requested, then its corner is rounded and its body is filled', async () => {
    const response = await get('/marks/squircle/blue/rocket.png');
    expect(response.status).toBe(200);
    expect(await pixel(response.clone(), 0, 0)).toBe('00000000');
    expect(await pixel(response, 8, 64)).toBe('dce9feff');
  });

  it('given black, which has no pastel, when it is requested, then the fill is the hue itself', async () => {
    expect(await pixel(await get('/marks/circle/black/star.png'), 64, 4)).toBe('17171aff');
  });

  it('given a key outside the vocabulary, when it is requested, then it is not found', async () => {
    expect((await get('/marks/circle/violet/not-an-icon.png')).status).toBe(404);
    expect((await get('/marks/hexagon/violet/database.png')).status).toBe(404);
    expect((await get('/marks/circle/magenta/database.png')).status).toBe(404);
  });
});
