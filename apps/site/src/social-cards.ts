/**
 * Social cards: the 1200x630 image a link unfurls into on Slack, X, LinkedIn
 * and iMessage. Text is set in Barlow and converted to SVG paths here, so the
 * card looks the same on every machine that builds it and never depends on a
 * system font. Node only: Vite calls it at build time and in the dev server.
 */
import { readFileSync } from 'node:fs';
import opentype from 'opentype.js';
import sharp from 'sharp';

export const SOCIAL_CARD_WIDTH = 1200;
export const SOCIAL_CARD_HEIGHT = 630;

export interface SocialCard {
  /** Small spaced capitals above the headline. */
  eyebrow: string;
  /** One or two lines, set in display capitals. A line's `muted` words are greyed. */
  headline: { text: string; muted?: string }[];
  /** A sentence under the headline, wrapped to at most two lines. */
  body: string;
  /** Bottom-right address, such as `rallywith.ai/compare/slack`. */
  address: string;
}

const fontFile = (path: string): opentype.Font =>
  opentype.parse(new Uint8Array(readFileSync(new URL(`../node_modules/@fontsource/${path}`, import.meta.url))).buffer);
const display = fontFile('barlow-semi-condensed/files/barlow-semi-condensed-latin-500-normal.woff');
const text = fontFile('barlow/files/barlow-latin-400-normal.woff');
const medium = fontFile('barlow/files/barlow-latin-500-normal.woff');
const hero = readFileSync(new URL('./assets/hero-sunrise.webp', import.meta.url));
const markPath = /<path d="([^"]+)"/u.exec(readFileSync(new URL('../public/brand/rally-mark-ink.svg', import.meta.url), 'utf8'))?.[1];
if (!markPath) throw new Error('social-cards: rally-mark-ink.svg no longer has the single <path d> the cards draw');

const PAPER = '#f7f7f7';
const MUTED = '#9b9b9b';
const SOFT = '#d4d4d4';
const GREEN = '#1f8a66';
const LEFT = 72;
const WIDTH = SOCIAL_CARD_WIDTH - LEFT * 2;

function path(font: opentype.Font, value: string, x: number, y: number, size: number, letterSpacing = 0): string {
  return font.getPath(value, x, y, size, { letterSpacing }).toPathData(1);
}

function width(font: opentype.Font, value: string, size: number, letterSpacing = 0): number {
  return font.getAdvanceWidth(value, size, { letterSpacing });
}

function wrap(value: string, size: number, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  for (const word of value.split(/\s+/u)) {
    const last = lines[lines.length - 1];
    if (last !== undefined && width(text, `${last} ${word}`, size) <= maxWidth) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let final = kept[maxLines - 1] ?? '';
  while (final && width(text, `${final}…`, size) > maxWidth) final = final.replace(/\s*\S+$/u, '');
  kept[maxLines - 1] = `${final}…`;
  return kept;
}

export async function renderSocialCard(card: SocialCard): Promise<Buffer> {
  const lines = card.headline.map(({ text: line, muted }) => ({ line: line.toUpperCase(), muted: muted?.toUpperCase() }));
  // The longest line sets the size, so "Microsoft Teams" shrinks and "Slack" doesn't.
  const longest = Math.max(...lines.map(({ line }) => width(display, line, 1)));
  // Capped so a short name's eyebrow still clears the wordmark above it.
  const size = Math.min(128, WIDTH / longest);
  const lineHeight = size * 0.92;
  const bodyLines = wrap(card.body, 34, WIDTH - 32, 2);
  const bodyTop = SOCIAL_CARD_HEIGHT - 96 - bodyLines.length * 46;
  const headlineBottom = bodyTop - 48;

  const headline = lines.map(({ line, muted }, index) => {
    const y = headlineBottom - (lines.length - 1 - index) * lineHeight;
    if (!muted || !line.startsWith(muted)) return `<path fill="${PAPER}" d="${path(display, line, LEFT, y, size)}"/>`;
    const rest = line.slice(muted.length);
    return `<path fill="${MUTED}" d="${path(display, muted, LEFT, y, size)}"/>`
      + `<path fill="${PAPER}" d="${path(display, rest, LEFT + width(display, muted, size), y, size)}"/>`;
  }).join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SOCIAL_CARD_WIDTH}" height="${SOCIAL_CARD_HEIGHT}">
<defs><linearGradient id="fade" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#0a0a0a" stop-opacity=".96"/><stop offset=".55" stop-color="#0a0a0a" stop-opacity=".82"/><stop offset="1" stop-color="#0a0a0a" stop-opacity=".35"/></linearGradient>
<linearGradient id="floor" x1="0" x2="0" y1="0" y2="1"><stop offset=".55" stop-color="#0a0a0a" stop-opacity="0"/><stop offset="1" stop-color="#0a0a0a" stop-opacity=".9"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#fade)"/><rect width="100%" height="100%" fill="url(#floor)"/>
<svg x="${LEFT}" y="60" width="40" height="40" viewBox="66.45 72.89 249.63 249.63"><path d="${markPath}" fill="none" stroke="${PAPER}" stroke-width="15"/></svg>
<path fill="${PAPER}" d="${path(display, 'rally', LEFT + 52, 93, 38)}"/>
<circle cx="${LEFT + 4}" cy="${headlineBottom - (lines.length - 1) * lineHeight - size * 0.72 - 36}" r="4" fill="${PAPER}"/>
<path fill="${PAPER}" d="${path(medium, card.eyebrow.toUpperCase(), LEFT + 20, headlineBottom - (lines.length - 1) * lineHeight - size * 0.72 - 29, 20, 0.24)}"/>
${headline}
<rect x="${LEFT}" y="${bodyTop - 4}" width="5" height="${bodyLines.length * 46 - 4}" fill="${GREEN}"/>
${bodyLines.map((line, index) => `<path fill="${SOFT}" d="${path(text, line, LEFT + 28, bodyTop + 30 + index * 46, 34)}"/>`).join('')}
<rect x="${LEFT}" y="${SOCIAL_CARD_HEIGHT - 60}" width="${WIDTH}" height="1" fill="${PAPER}" fill-opacity=".18"/>
<path fill="${MUTED}" d="${path(medium, card.address, SOCIAL_CARD_WIDTH - LEFT - width(medium, card.address, 20), SOCIAL_CARD_HEIGHT - 26, 20)}"/>
<path fill="${MUTED}" d="${path(medium, 'Juno AI Labs', LEFT, SOCIAL_CARD_HEIGHT - 26, 20)}"/>
</svg>`;

  return sharp(hero)
    .resize(SOCIAL_CARD_WIDTH, SOCIAL_CARD_HEIGHT, { fit: 'cover', position: 'right' })
    .composite([{ input: Buffer.from(svg) }])
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** The card for one "Rally vs X" page. */
export function renderComparisonCard({ slug, name, edge }: { slug: string; name: string; edge: string }): Promise<Buffer> {
  return renderSocialCard({
    eyebrow: 'Compared to',
    headline: [{ text: 'Rally' }, { text: `vs ${name}`, muted: 'vs' }],
    body: edge,
    address: `rallywith.ai/compare/${slug}`,
  });
}
