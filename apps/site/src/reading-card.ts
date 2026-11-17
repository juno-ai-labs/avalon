/** Build-time link previews for every page of the pencil site: see docs/site-design-system.md. */
import { readFileSync } from 'node:fs';
import opentype from 'opentype.js';
import sharp from 'sharp';
import { getIllustration } from './home-illustrations';

export interface ReadingCard {
  eyebrow: string;
  title: string;
  description: string;
  address: string;
  scene: 'canvas' | 'sidekick' | 'together';
}

const font = (name: string): opentype.Font =>
  opentype.parse(new Uint8Array(readFileSync(new URL(`./fonts/${name}.ttf`, import.meta.url))).buffer);
const display = font('instrument-serif-regular');
const body = font('geist-regular');
const bold = font('geist-semibold');
const markPath = /<path d="([^"]+)"/u.exec(readFileSync(new URL('../public/brand/rally-mark-ink.svg', import.meta.url), 'utf8'))?.[1];
if (!markPath) throw new Error('reading-card: the Rally mark must contain its path');

const illustrations: Partial<Record<ReadingCard['scene'], Promise<Buffer>>> = {};
function illustration(scene: ReadingCard['scene']): Promise<Buffer> {
  const { src, crop } = getIllustration(scene);
  return illustrations[scene] ??= sharp(readFileSync(new URL(`../public${src}`, import.meta.url)))
    .extract(crop)
    .resize(420, 315).png().toBuffer();
}

/** The line every card ends on, set flush right; the product's own words from the landing page. */
const SIGN_OFF = 'Reactive artifacts, shared with your team.';

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

function wrap(value: string, face: opentype.Font, size: number, measure: number): string[] {
  const lines: string[] = [];
  for (const word of value.split(/\s+/u)) {
    const pieces: string[] = [];
    let piece = '';
    for (const { segment } of graphemes.segment(word)) {
      if (piece && face.getAdvanceWidth(piece + segment, size) > measure) {
        pieces.push(piece);
        piece = '';
      }
      piece += segment;
    }
    pieces.push(piece);
    for (const part of pieces) {
      const index = lines.length - 1;
      const line = lines[index];
      if (line !== undefined && face.getAdvanceWidth(`${line} ${part}`, size) <= measure) lines[index] = `${line} ${part}`;
      else lines.push(part);
    }
  }
  return lines;
}

function clamp(lines: string[], face: opentype.Font, size: number, measure: number): string[] {
  if (lines.length <= 3) return lines;
  const result = lines.slice(0, 3);
  const final = [...graphemes.segment(result[2]!)].map(({ segment }) => segment);
  while (final.length && face.getAdvanceWidth(final.join('').trimEnd() + '…', size) > measure) final.pop();
  result[2] = final.join('').trimEnd() + '…';
  return result;
}
const text = (face: opentype.Font, value: string, x: number, y: number, size: number, color: string): string =>
  `<path fill="${color}" d="${face.getPath(value, x, y, size).toPathData(1)}"/>`;

export async function renderReadingCard(card: ReadingCard): Promise<Buffer> {
  // A line break in the title is kept, so a card can break a headline where its page does.
  const wrapTitle = (size: number) => card.title.split('\n').flatMap((line) => wrap(line, display, size, 625));
  let size = 82;
  while (wrapTitle(size).length > 3 && size > 48) size -= 2;
  const lines = clamp(wrapTitle(size), display, size, 625);
  const bodyY = Math.min(464, 240 + (lines.length - 1) * size * 1.03 + 60);
  const bodyLines = clamp(wrap(card.description, body, 22, 620), body, 22, 620);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
    <rect width="1200" height="630" fill="#fcfbf7"/>
    <svg x="64" y="44" width="38" height="38" viewBox="66.45 72.89 249.63 249.63"><path d="${markPath}" fill="none" stroke="#393d31" stroke-width="15"/></svg>
    ${text(bold, 'rally', 111, 78, 38, '#393d31')}
    ${text(body, card.eyebrow, 64, 149, 17, '#536547')}
    ${lines.map((line, index) => text(display, line, 64, 240 + index * size * 1.03, size, '#393d31')).join('')}
    ${bodyLines.map((line, index) => text(body, line, 64, bodyY + index * 31, 22, '#646b5b')).join('')}
    <path d="M64 571H1136" stroke="#e4e4d8"/>
    ${text(body, card.address, 64, 604, 15, '#646b5b')}
    ${text(body, SIGN_OFF, 1136 - body.getAdvanceWidth(SIGN_OFF, 15), 604, 15, '#646b5b')}
  </svg>`;
  return sharp(Buffer.from(svg))
    .composite([{ input: await illustration(card.scene), left: 742, top: 165 }])
    .png({ compressionLevel: 9 }).toBuffer();
}
