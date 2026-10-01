import type { HelpChapter, HelpPage, HelpSite } from './content';
import type { HelpHeading } from './markdown';

export const SITE_ORIGIN = 'https://rallywith.ai';

/** The built stylesheet and script each page links to. */
export interface HelpPageAssets {
  styles: string[];
  scripts: string[];
}

export interface LayoutInput {
  site: HelpSite;
  page: HelpPage;
  html: string;
  headings: HelpHeading[];
  assets: HelpPageAssets;
}

export const escapeHtml = (value: string): string =>
  value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');

const pad = (value: number): string => String(value).padStart(2, '0');

const current = (active: boolean): string => (active ? ' aria-current="page"' : '');

const navLabel = (page: HelpPage): string => escapeHtml(page.frontMatter.navTitle ?? page.frontMatter.title);

const draftBadge = (page: HelpPage): string => (page.frontMatter.draft ? ' <span class="help-draft">Draft</span>' : '');

/** "Chapter 3", or "3.2" for the second page of chapter three. */
export function pageNumber(page: HelpPage): string {
  const chapter = page.chapter;
  if (!chapter) return '';
  if (page.kind === 'chapter') return `Chapter ${chapter.number}`;
  return `${chapter.number}.${chapter.pages.indexOf(page) + 1}`;
}

function sidebar(site: HelpSite, page: HelpPage): string {
  const chapters = site.chapters.map((chapter) => {
    const open = page.chapter === chapter;
    const pages = chapter.pages.map((child) =>
      `<li><a href="${child.url}"${current(child === page)}>${navLabel(child)}${draftBadge(child)}</a></li>`).join('');
    return `<li class="help-nav-chapter${open ? ' is-current' : ''}">`
      + `<a class="help-nav-chapter-link" href="${chapter.intro.url}"${current(chapter.intro === page)}>`
      + `<span class="help-nav-number">${pad(chapter.number)}</span><span>${navLabel(chapter.intro)}</span></a>`
      + (pages ? `<ol class="help-nav-pages">${pages}</ol>` : '')
      + '</li>';
  }).join('');
  return `<nav id="help-sidebar" class="help-sidebar" aria-label="Chapters">`
    + `<a class="help-nav-home" href="/help/"${current(page.kind === 'home')}>Contents</a>`
    + `<ol class="help-nav-chapters">${chapters}</ol></nav>`;
}

function outline(page: HelpPage, headings: HelpHeading[]): string {
  const items = headings.map((heading) =>
    `<li class="help-toc-depth-${heading.depth}"><a href="#${heading.id}">${escapeHtml(heading.text)}</a></li>`).join('');
  if (!items) return '<aside class="help-toc" aria-hidden="true"></aside>';
  return '<aside class="help-toc" aria-labelledby="help-toc-title"><div class="help-toc-inner">'
    + '<p id="help-toc-title" class="help-toc-title">On this page</p>'
    + `<ol><li class="help-toc-depth-1"><a href="#top">${escapeHtml(page.frontMatter.title)}</a></li>${items}</ol>`
    + '</div></aside>';
}

/** A manual-style contents list: number, title, dotted leader, description. */
function contentsList(entries: Array<{ number: string; page: HelpPage }>, className: string): string {
  const items = entries.map(({ number, page }) =>
    `<li><a href="${page.url}"><span class="help-contents-number">${number}</span>`
    + `<span class="help-contents-title">${escapeHtml(page.frontMatter.title)}${draftBadge(page)}</span>`
    + '<span class="help-contents-leader" aria-hidden="true"></span>'
    + `<span class="help-contents-description">${escapeHtml(page.frontMatter.description)}</span></a></li>`).join('');
  return `<ol class="help-contents ${className}">${items}</ol>`;
}

function chapterContents(chapter: HelpChapter): string {
  if (chapter.pages.length === 0) return '';
  return '<section class="help-in-this-chapter" aria-labelledby="help-in-this-chapter">'
    + '<h2 id="help-in-this-chapter" class="help-section-label">In this chapter</h2>'
    + contentsList(chapter.pages.map((page) => ({ number: pageNumber(page), page })), 'help-contents-pages')
    + '</section>';
}

function homeContents(site: HelpSite): string {
  const chapters = site.chapters.map((chapter) =>
    '<li class="help-home-chapter">'
    + `<a class="help-home-chapter-link" href="${chapter.intro.url}">`
    + `<span class="help-home-chapter-number">${pad(chapter.number)}</span>`
    + `<span class="help-home-chapter-title">${escapeHtml(chapter.intro.frontMatter.title)}${draftBadge(chapter.intro)}</span>`
    + `<span class="help-home-chapter-description">${escapeHtml(chapter.intro.frontMatter.description)}</span></a>`
    + (chapter.pages.length
      ? `<ol class="help-home-pages">${chapter.pages.map((page) =>
        `<li><a href="${page.url}"><span>${pageNumber(page)}</span>${navLabel(page)}${draftBadge(page)}</a></li>`).join('')}</ol>`
      : '')
    + '</li>').join('');
  return '<section class="help-home-contents" aria-labelledby="help-contents-title">'
    + '<h2 id="help-contents-title" class="help-section-label">Contents</h2>'
    + `<ol class="help-home-chapters">${chapters}</ol></section>`;
}

function pager(site: HelpSite, page: HelpPage): string {
  const index = site.pages.indexOf(page);
  const link = (target: HelpPage | undefined, rel: 'prev' | 'next'): string => {
    if (!target) return '<span></span>';
    const label = rel === 'prev' ? 'Previous' : 'Next';
    const number = pageNumber(target);
    return `<a class="help-pager-${rel}" href="${target.url}" rel="${rel}"><span class="help-pager-label">${label}${number ? ` · ${number}` : ''}</span>`
      + `<span class="help-pager-title">${escapeHtml(target.frontMatter.title)}</span></a>`;
  };
  return `<nav class="help-pager" aria-label="Previous and next pages">${link(site.pages[index - 1], 'prev')}${link(site.pages[index + 1], 'next')}</nav>`;
}

function articleHeader(page: HelpPage): string {
  const { title, description } = page.frontMatter;
  const chapter = page.chapter;
  if (page.kind === 'chapter' && chapter) {
    return '<header class="help-article-header help-chapter-header">'
      + `<p class="help-chapter-numeral" aria-hidden="true">${pad(chapter.number)}</p>`
      + `<p class="help-eyebrow">Chapter ${chapter.number}${draftBadge(page)}</p>`
      + `<h1 id="top">${escapeHtml(title)}</h1><p class="help-lede">${escapeHtml(description)}</p></header>`;
  }
  if (page.kind === 'home') {
    return '<header class="help-article-header help-home-header">'
      + '<p class="help-eyebrow">Rally Help Center</p>'
      + `<h1 id="top">${escapeHtml(title)}</h1><p class="help-lede">${escapeHtml(description)}</p></header>`;
  }
  const eyebrow = chapter
    ? `<a href="${chapter.intro.url}">Chapter ${chapter.number} · ${escapeHtml(chapter.intro.frontMatter.navTitle ?? chapter.intro.frontMatter.title)}</a><span aria-hidden="true">/</span><span>${pageNumber(page)}</span>`
    : '';
  return '<header class="help-article-header">'
    + `<p class="help-eyebrow">${eyebrow}${draftBadge(page)}</p>`
    + `<h1 id="top">${escapeHtml(title)}</h1><p class="help-lede">${escapeHtml(description)}</p></header>`;
}

export function documentTitle(page: HelpPage): string {
  return `${page.frontMatter.title} · Rally Help`;
}

export function renderLayout({ site, page, html, headings, assets }: LayoutInput): string {
  const { title, description } = page.frontMatter;
  const canonical = `${SITE_ORIGIN}${page.url}`;
  const kindClass = page.kind === 'page' ? '' : ` help-article-${page.kind}`;
  const extras = page.kind === 'chapter' && page.chapter ? chapterContents(page.chapter) : page.kind === 'home' ? homeContents(site) : '';
  const head = [
    '<meta charset="UTF-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '<meta name="theme-color" content="#f7f7f7" media="(prefers-color-scheme: light)" />',
    '<meta name="theme-color" content="#0b0b0b" media="(prefers-color-scheme: dark)" />',
    '<meta name="color-scheme" content="light dark" />',
    `<meta name="description" content="${escapeHtml(description)}" />`,
    `<link rel="canonical" href="${canonical}" />`,
    `<link rel="alternate" type="text/markdown" href="${page.markdownUrl}" title="This page as Markdown" />`,
    '<link rel="alternate" type="text/plain" href="/help/llms.txt" title="Rally Help for language models" />',
    '<link rel="icon" href="/favicon.png" type="image/png" sizes="64x64" />',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180" />',
    '<link rel="manifest" href="/site.webmanifest" />',
    '<meta property="og:type" content="article" />',
    '<meta property="og:site_name" content="Rally" />',
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:url" content="${canonical}" />`,
    `<meta property="og:image" content="${SITE_ORIGIN}/og-2026.jpg" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
    ...assets.styles.map((href) => `<link rel="stylesheet" href="${href}" />`),
    ...assets.scripts.map((src) => `<script type="module" src="${src}"></script>`),
    `<title>${escapeHtml(documentTitle(page))}</title>`,
  ].join('\n    ');

  return `<!doctype html>
<html lang="en">
  <head>
    ${head}
  </head>
  <body class="help">
    <a class="help-skip-link" href="#content">Skip to content</a>
    <header class="help-header">
      <div class="help-header-inner">
        <button class="help-menu-button" type="button" aria-controls="help-sidebar" aria-expanded="false"><span class="help-menu-icon" aria-hidden="true"></span><span class="help-visually-hidden">Chapters</span></button>
        <a class="help-brand" href="/" aria-label="Rally home"><img class="help-brand-mark" src="/brand/rally-mark-ink.svg" width="22" height="22" alt="" /><span>rally</span></a>
        <a class="help-brand-section" href="/help/">Help</a>
        <button class="help-search-button" type="button" data-help-search-open><span class="help-search-icon" aria-hidden="true"></span><span class="help-search-label">Search the manual</span><kbd class="help-search-key">/</kbd></button>
        <nav class="help-header-links" aria-label="Rally"><a href="/support/contact/">Contact support</a><a class="help-header-cta" href="/">rallywith.ai</a></nav>
      </div>
    </header>
    <div class="help-shell">
      ${sidebar(site, page)}
      <main id="content" class="help-main" tabindex="-1">
        <article class="help-article${kindClass}" data-markdown-url="${page.markdownUrl}">
          ${articleHeader(page)}
          <div class="help-prose">${html}</div>
          ${extras}
          <footer class="help-article-footer">
            <div class="help-page-actions"><button class="help-copy-page" type="button" data-copy-markdown hidden>Copy page as Markdown</button><a href="${page.markdownUrl}">View as Markdown</a><a href="/help/llms.txt">llms.txt</a></div>
            ${pager(site, page)}
          </footer>
        </article>
      </main>
      ${outline(page, headings)}
    </div>
    <footer class="help-footer">
      <div class="help-footer-inner">
        <a class="help-brand" href="/"><img class="help-brand-mark" src="/brand/rally-mark-ink.svg" width="18" height="18" alt="" /><span>rally</span></a>
        <nav aria-label="More"><a href="/help/">Help Center</a><a href="/support/">Support</a><a href="/support/contact/">Contact</a><a href="/trust/">Trust Center</a><a href="/trust/privacy/">Privacy</a></nav>
        <p>© 2026 Juno AI Labs · Rally</p>
      </div>
    </footer>
    <dialog class="help-search" aria-label="Search the manual">
      <form method="dialog" class="help-search-form" role="search">
        <span class="help-search-icon" aria-hidden="true"></span>
        <input class="help-search-input" type="search" placeholder="Search the manual" aria-label="Search the manual" autocomplete="off" spellcheck="false" />
        <button class="help-search-close" type="submit" aria-label="Close search">Esc</button>
      </form>
      <ol class="help-search-results" role="listbox" aria-label="Results"></ol>
      <p class="help-search-empty" hidden>Nothing matched. Try fewer words, or a different one.</p>
    </dialog>
  </body>
</html>
`;
}
