import { createHash } from 'node:crypto';
import { pageNumber, type HelpPage, type HelpSite } from './content';
import { renderReadingCard } from '../../src/reading-card';

// One social image per page, so a link pasted into Slack, iMessage or X shows
// the page's own chapter, title and summary rather than the site's generic
// card. The shared reading-card renderer uses the same fonts and pencil master
// as the pages, without requiring a browser at build time.

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

// Bump to regenerate every card after a design change; it is part of each
// file's hash, and the files are cached as immutable.
const DESIGN_VERSION = '3-pencil';

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

/** Renders one page's card as PNG bytes. */
export function renderOgImage(page: HelpPage): Promise<Uint8Array> {
  const words = card(page);
  return renderReadingCard({
    eyebrow: words.eyebrow,
    title: words.title,
    description: words.description,
    address: words.path,
    scene: 'sidekick',
  });
}

/** Every page's card, keyed by output path without the leading slash. */
export async function renderOgImages(site: HelpSite): Promise<Map<string, Uint8Array>> {
  const images = new Map<string, Uint8Array>();
  for (const page of site.pages) images.set(ogImagePath(page).slice(1), await renderOgImage(page));
  return images;
}
