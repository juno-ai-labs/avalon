import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import satori from 'satori';
import { pageNumber, type HelpPage, type HelpSite } from './content';

// One social image per page, so a link pasted into Slack, iMessage or X shows
// the page's own chapter, title and summary rather than the site's generic
// card. Satori lays the card out as SVG and resvg rasterizes it; neither needs
// a browser, so the build runs anywhere.

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

// Bump to regenerate every card after a design change; it is part of each
// file's hash, and the files are cached as immutable.
const DESIGN_VERSION = '1';

const require = createRequire(import.meta.url);
const font = (specifier: string): Buffer => readFileSync(require.resolve(specifier));

const INK = '#0b0b0b';
const PAPER = '#f5f5f5';
const MUTED = '#9a9a9a';
const FAINT = '#1c1c1c';
const HAIRLINE = '#2a2a2a';

interface Card {
  eyebrow: string;
  title: string;
  description: string;
  numeral: string;
  path: string;
  display: boolean;
}

function card(page: HelpPage): Card {
  const chapter = page.chapter;
  const chapterName = chapter ? (chapter.intro.frontMatter.navTitle ?? chapter.intro.frontMatter.title) : '';
  const eyebrow = page.kind === 'home'
    ? 'Rally Help Center'
    : page.kind === 'chapter' ? `Chapter ${chapter?.number ?? ''}` : `Chapter ${chapter?.number ?? ''} · ${chapterName}   /   ${pageNumber(page)}`;
  return {
    eyebrow,
    title: page.frontMatter.title,
    description: page.frontMatter.description,
    numeral: chapter ? String(chapter.number).padStart(2, '0') : '',
    path: `rallywith.ai${page.url}`,
    display: page.kind !== 'page',
  };
}

/** Published path of a page's card; the hash changes whenever its words do. */
export function ogImagePath(page: HelpPage): string {
  const words = card(page);
  const hash = createHash('sha256').update(JSON.stringify([DESIGN_VERSION, words])).digest('hex').slice(0, 10);
  const name = page.url === '/help/' ? 'help' : page.url.slice('/help/'.length, -1).replace(/\//gu, '--');
  return `/help/_og/${name}-${hash}.png`;
}

type Node = { type: string; props: Record<string, unknown> };
// Satori needs an explicit display on every box; text boxes that clamp use block.
const h = (type: string, style: Record<string, unknown>, ...children: Array<Node | string>): Node =>
  ({ type, props: { style: { display: style.lineClamp ? 'block' : 'flex', ...style }, children: children.length === 1 ? children[0] : children } });

function markDataUri(): string {
  const svg = readFileSync(new URL('../../public/brand/rally-mark-ink.svg', import.meta.url), 'utf8')
    .replace(/stroke="#111210"/gu, `stroke="${PAPER}"`);
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function tree(words: Card, mark: string): Node {
  const long = words.title.length > 48;
  const titleSize = words.display ? (long ? 72 : 96) : (long ? 60 : 76);
  return h('div', { width: OG_WIDTH, height: OG_HEIGHT, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '64px 72px', background: INK, color: PAPER, fontFamily: 'Barlow', position: 'relative' },
    words.numeral
      ? h('div', { position: 'absolute', right: 40, top: -60, fontFamily: 'Barlow Semi Condensed', fontSize: 420, lineHeight: 1, color: FAINT, letterSpacing: -12 }, words.numeral)
      : h('div', { display: 'none' }),
    h('div', { display: 'flex', alignItems: 'center', gap: 14 },
      { type: 'img', props: { src: mark, width: 44, height: 44 } },
      h('div', { fontFamily: 'Barlow Semi Condensed', fontSize: 42, lineHeight: 1, marginTop: -4 }, 'rally'),
      h('div', { width: 8, height: 8, borderRadius: 8, background: PAPER, marginLeft: 12 }),
      h('div', { fontSize: 20, fontWeight: 500, letterSpacing: 6, color: MUTED }, 'HELP')),
    h('div', { display: 'flex', flexDirection: 'column', gap: 22 },
      h('div', { fontSize: 22, fontWeight: 500, letterSpacing: 5, color: MUTED, textTransform: 'uppercase' }, words.eyebrow),
      h('div', { fontFamily: 'Barlow Semi Condensed', fontSize: titleSize, lineHeight: 1.02, letterSpacing: words.display ? 1 : -0.5, textTransform: words.display ? 'uppercase' : 'none', lineClamp: 3, maxWidth: 1000 }, words.title),
      h('div', { fontSize: 30, lineHeight: 1.35, color: MUTED, lineClamp: 2, maxWidth: 980 }, words.description)),
    h('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 22, borderTop: `1px solid ${HAIRLINE}`, fontSize: 22, color: MUTED },
      h('div', {}, words.path),
      h('div', { letterSpacing: 3 }, 'THE RALLY MANUAL')));
}

let ready: Promise<void> | undefined;
const initialize = (): Promise<void> => {
  ready ??= initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
  return ready;
};

/** Renders one page's card as PNG bytes. */
export async function renderOgImage(page: HelpPage): Promise<Uint8Array> {
  await initialize();
  const svg = await satori(tree(card(page), markDataUri()) as Parameters<typeof satori>[0], {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    fonts: [
      { name: 'Barlow', data: font('@fontsource/barlow/files/barlow-latin-400-normal.woff'), weight: 400, style: 'normal' },
      { name: 'Barlow', data: font('@fontsource/barlow/files/barlow-latin-500-normal.woff'), weight: 500, style: 'normal' },
      { name: 'Barlow Semi Condensed', data: font('@fontsource/barlow-semi-condensed/files/barlow-semi-condensed-latin-500-normal.woff'), weight: 500, style: 'normal' },
    ],
  });
  return new Resvg(svg, { fitTo: { mode: 'width', value: OG_WIDTH } }).render().asPng();
}

/** Every page's card, keyed by output path without the leading slash. */
export async function renderOgImages(site: HelpSite): Promise<Map<string, Uint8Array>> {
  const images = new Map<string, Uint8Array>();
  for (const page of site.pages) images.set(ogImagePath(page).slice(1), await renderOgImage(page));
  return images;
}
