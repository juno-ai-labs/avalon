import { pageNumber, type HelpChapter, type HelpPage, type HelpSite } from './content';
import { OG_HEIGHT, OG_WIDTH, ogImagePath } from './og';
import type { HelpHeading } from './markdown';

export const SITE_ORIGIN = 'https://rallywith.ai';

/** The built stylesheet and script each page links to. */
export interface HelpPageAssets {
  styles: string[];
  scripts: string[];
  /** `<meta name content>` pairs a page script reads, such as another entry's URL. */
  meta?: Array<{ name: string; content: string }>;
}

export interface LayoutInput {
  site: HelpSite;
  page: HelpPage;
  html: string;
  headings: HelpHeading[];
  assets: HelpPageAssets;
}

// The markup is kept small on purpose. Agents that cannot ask for Markdown read
// this HTML, so the article comes first in the source, the sidebar lists only
// the current chapter's pages, class names are short, and everything that is
// only for people (the search dialog) is built by the script.

export const escapeHtml = (value: string): string =>
  value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');

const pad = (value: number): string => String(value).padStart(2, '0');

const current = (active: boolean): string => (active ? ' aria-current="page"' : '');

const navLabel = (page: HelpPage): string => escapeHtml(page.frontMatter.navTitle ?? page.frontMatter.title);

const draftBadge = (page: HelpPage): string => (page.frontMatter.draft ? ' <mark class="draft">Draft</mark>' : '');

function sidebar(site: HelpSite, page: HelpPage): string {
  const chapters = site.chapters.map((chapter) => {
    const open = page.chapter === chapter;
    const pages = open && chapter.pages.length
      ? `<ol>${chapter.pages.map((child) => `<li><a href="${child.url}"${current(child === page)}>${navLabel(child)}${draftBadge(child)}</a></li>`).join('')}</ol>`
      : '';
    return `<li${open ? ' class="open"' : ''}><a href="${chapter.intro.url}"${current(chapter.intro === page)}><span>${pad(chapter.number)}</span>${navLabel(chapter.intro)}${draftBadge(chapter.intro)}</a>${pages}</li>`;
  }).join('');
  return `<nav id="chapters" aria-label="Chapters"><a class="home" href="/help/"${current(page.kind === 'home')}>Contents</a><ol>${chapters}</ol></nav>`;
}

// The right column: the outline, when the page has headings, then the page's
// Markdown actions, which every page has.
function outline(page: HelpPage, headings: HelpHeading[]): string {
  const actions = `<div class="actions"><button type="button" data-copy-page hidden>Copy page as Markdown</button><a href="${page.markdownUrl}">View as Markdown</a></div>`;
  if (headings.length === 0) return `<aside class="toc" aria-label="Page actions">${actions}</aside>`;
  const items = headings.map((heading) =>
    `<li${heading.depth > 1 ? ` class="d${heading.depth}"` : ''}><a href="#${heading.id}">${escapeHtml(heading.text)}</a></li>`).join('');
  return `<aside class="toc" aria-label="On this page"><p>On this page</p><ol><li><a href="#top">${escapeHtml(page.frontMatter.title)}</a></li>${items}</ol>${actions}</aside>`;
}

function chapterContents(chapter: HelpChapter): string {
  if (chapter.pages.length === 0) return '';
  const items = chapter.pages.map((page) =>
    `<li><a href="${page.url}"><span>${pageNumber(page)}</span>${escapeHtml(page.frontMatter.title)}${draftBadge(page)}</a><p>${escapeHtml(page.frontMatter.description)}</p></li>`).join('');
  return `<section class="contents" aria-labelledby="in-this-chapter"><h2 id="in-this-chapter">In this chapter</h2><ol class="leaders">${items}</ol></section>`;
}

function homeContents(site: HelpSite): string {
  const chapters = site.chapters.map((chapter) => {
    const pages = chapter.pages.length
      ? `<ol>${chapter.pages.map((page) => `<li><a href="${page.url}"><span>${pageNumber(page)}</span>${navLabel(page)}${draftBadge(page)}</a></li>`).join('')}</ol>`
      : '';
    return `<li><a class="ch" href="${chapter.intro.url}"><span>${pad(chapter.number)}</span>${escapeHtml(chapter.intro.frontMatter.title)}${draftBadge(chapter.intro)}</a>`
      + `<p>${escapeHtml(chapter.intro.frontMatter.description)}</p>${pages}</li>`;
  }).join('');
  return `<section class="contents" aria-labelledby="contents"><h2 id="contents">Contents</h2><ol class="book">${chapters}</ol></section>`;
}

function pager(site: HelpSite, page: HelpPage): string {
  const index = site.pages.indexOf(page);
  const link = (target: HelpPage | undefined, rel: 'prev' | 'next'): string => {
    if (!target) return '';
    const number = pageNumber(target);
    return `<a rel="${rel}" href="${target.url}"><span>${rel === 'prev' ? 'Previous' : 'Next'}${number ? ` · ${number}` : ''}</span>${escapeHtml(target.frontMatter.title)}</a>`;
  };
  return `<nav class="pager" aria-label="Previous and next">${link(site.pages[index - 1], 'prev')}${link(site.pages[index + 1], 'next')}</nav>`;
}

function articleHeader(page: HelpPage): string {
  const { title, description } = page.frontMatter;
  const chapter = page.chapter;
  let eyebrow = 'Rally Help Center';
  let numeral = '';
  if (page.kind === 'chapter' && chapter) {
    eyebrow = `Chapter ${chapter.number}`;
    numeral = `<p class="numeral" aria-hidden="true">${pad(chapter.number)}</p>`;
  } else if (page.kind === 'page' && chapter) {
    eyebrow = `<a href="${chapter.intro.url}">Chapter ${chapter.number} · ${navLabel(chapter.intro)}</a> / ${pageNumber(page)}`;
  }
  return `<header>${numeral}<p class="eyebrow">${eyebrow}${draftBadge(page)}</p><h1 id="top">${escapeHtml(title)}</h1><p class="lede">${escapeHtml(description)}</p></header>`;
}

export const documentTitle = (page: HelpPage): string => `${page.frontMatter.title} · Rally Help`;

/** schema.org data for search engines and answer engines: the page and where it sits. */
function structuredData(page: HelpPage): string {
  const crumbs = [{ name: 'Help Center', url: '/help/' }];
  if (page.chapter && page.kind === 'page') crumbs.push({ name: page.chapter.intro.frontMatter.title, url: page.chapter.intro.url });
  if (page.kind !== 'home') crumbs.push({ name: page.frontMatter.title, url: page.url });
  const data = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': page.kind === 'home' ? 'WebPage' : 'TechArticle',
        'headline': page.frontMatter.title,
        'description': page.frontMatter.description,
        'url': `${SITE_ORIGIN}${page.url}`,
        'inLanguage': 'en',
        'isPartOf': { '@type': 'WebSite', 'name': 'Rally Help Center', 'url': `${SITE_ORIGIN}/help/` },
        'about': { '@type': 'SoftwareApplication', 'name': 'Rally', 'operatingSystem': 'macOS', 'applicationCategory': 'BusinessApplication' },
        'publisher': { '@type': 'Organization', 'name': 'Juno AI Labs', 'url': SITE_ORIGIN },
        'encoding': { '@type': 'MediaObject', 'encodingFormat': 'text/markdown', 'contentUrl': `${SITE_ORIGIN}${page.markdownUrl}` },
      },
      {
        '@type': 'BreadcrumbList',
        'itemListElement': crumbs.map((crumb, index) => ({ '@type': 'ListItem', 'position': index + 1, 'name': crumb.name, 'item': `${SITE_ORIGIN}${crumb.url}` })),
      },
    ],
  };
  // `<` cannot appear raw inside a script element's text.
  return JSON.stringify(data).replace(/</gu, '\\u003c');
}

export function renderLayout({ site, page, html, headings, assets }: LayoutInput): string {
  const { title, description } = page.frontMatter;
  const canonical = `${SITE_ORIGIN}${page.url}`;
  const extras = page.kind === 'chapter' && page.chapter ? chapterContents(page.chapter) : page.kind === 'home' ? homeContents(site) : '';
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${escapeHtml(documentTitle(page))}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<link rel="canonical" href="${canonical}">`,
    `<link rel="alternate" type="text/markdown" href="${page.markdownUrl}">`,
    '<link rel="help" type="text/plain" href="/help/llms.txt">',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    '<link rel="icon" href="/favicon.png" type="image/png">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${canonical}">`,
    '<meta property="og:type" content="article">',
    '<meta property="og:site_name" content="Rally Help Center">',
    `<meta property="og:image" content="${SITE_ORIGIN}${ogImagePath(page)}">`,
    `<meta property="og:image:width" content="${OG_WIDTH}">`,
    `<meta property="og:image:height" content="${OG_HEIGHT}">`,
    `<meta property="og:image:alt" content="${escapeHtml(`${title}: ${description}`)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`,
    `<meta name="twitter:image" content="${SITE_ORIGIN}${ogImagePath(page)}">`,
    ...(assets.meta ?? []).map(({ name, content }) => `<meta name="${escapeHtml(name)}" content="${escapeHtml(content)}">`),
    ...assets.styles.map((href) => `<link rel="stylesheet" href="${href}">`),
    ...assets.scripts.map((src) => `<script type="module" src="${src}"></script>`),
    `<script type="application/ld+json">${structuredData(page)}</script>`,
  ].join('\n');

  return `<!doctype html>
<html lang="en">
<head>
${head}
</head>
<body class="help">
<a class="skip" href="#content">Skip to content</a>
<header class="top"><button class="menu" type="button" aria-controls="chapters" aria-expanded="false" aria-label="Chapters"><i></i></button><a class="brand" href="/"><img src="/brand/rally-mark-ink.svg" width="22" height="22" alt="">rally</a><a class="section" href="/help/">Help</a><button class="find" type="button" data-search>Search the manual<kbd>/</kbd></button><nav class="links" aria-label="Rally"><a href="mailto:help@rallywith.ai?subject=Rally%20support">Contact support</a><a class="cta" href="/">rallywith.ai</a></nav></header>
<div class="shell">
<main id="content" tabindex="-1">
<article class="${page.kind}" data-md="${page.markdownUrl}">
${articleHeader(page)}
<div class="prose">${html}</div>
${extras}
<footer>${pager(site, page)}</footer>
</article>
</main>
${sidebar(site, page)}
${outline(page, headings)}
</div>
<footer class="foot"><a class="brand" href="/"><img src="/brand/rally-mark-ink.svg" width="18" height="18" alt="">rally</a><nav aria-label="More"><a href="/help/">Help Center</a><a href="/trust/">Trust Center</a><a href="/trust/privacy/">Privacy</a><a data-site-action="support-contact-footer" href="mailto:help@rallywith.ai?subject=Rally%20support">Contact</a><a href="/help/llms.txt">llms.txt</a></nav><p>© 2026 Juno AI Labs · Rally</p></footer>
</body>
</html>
`;
}
