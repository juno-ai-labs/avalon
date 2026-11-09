import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import type { Definition, Image, Link, Root as MdastRoot } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { HelpContentError, loadHelpSite, pageNumber, type HelpChapter, type HelpPage, type HelpSite } from './content';
import { escapeHtml, renderLayout, SITE_ORIGIN, type HelpPageAssets } from './layout';
import { renderMarkdown, type HelpHeading, type HrefResolution } from './markdown';

/** Output path relative to the published root (no leading slash) to its body. */
export type HelpOutputs = Map<string, string | Buffer>;

export interface BuildHelpOptions {
  includeDrafts?: boolean;
  assets: HelpPageAssets;
}

export interface SearchEntry {
  /** Title. */
  t: string;
  /** Chapter label, e.g. "Chapter 3 · Sidekicks". */
  c: string;
  /** URL. */
  u: string;
  /** Description. */
  d: string;
  /** Headings as [id, text]. */
  h: Array<[string, string]>;
  /** Body text. */
  x: string;
}

interface FragmentCheck {
  from: HelpPage;
  to: HelpPage;
  fragment: string;
  href: string;
}

const outputPathFor = (url: string): string => `${url.slice(1)}index.html`;

function splitHref(href: string): { path: string; suffix: string } {
  const at = href.search(/[?#]/u);
  return at === -1 ? { path: href, suffix: '' } : { path: href.slice(0, at), suffix: href.slice(at) };
}

function chapterLabel(page: HelpPage): string {
  const chapter = page.chapter;
  if (!chapter) return '';
  return `Chapter ${chapter.number} · ${chapter.intro.frontMatter.navTitle ?? chapter.intro.frontMatter.title}`;
}

/**
 * Every page's links are written as relative paths between Markdown files, the
 * way they work when browsing the folder on GitHub. This turns them into the
 * published URLs and fails on anything that points at nothing.
 */
function hrefResolver(site: HelpSite, byPath: Map<string, HelpPage>, byUrl: Map<string, HelpPage>,
  assets: Map<string, string>, fragments: FragmentCheck[], page: HelpPage, style: 'html' | 'markdown') {
  return (href: string, kind: 'link' | 'image'): HrefResolution => {
    const where = `${page.sourceName}: ${kind} "${href}"`;
    if (/^[a-z][a-z0-9+.-]*:/iu.test(href) || href.startsWith('//')) {
      if (kind === 'image' && !/^data:/iu.test(href)) {
        return { error: `${where} is on another site, which the site's Content-Security-Policy blocks; save the image in the help folder and link it relatively` };
      }
      return { href };
    }
    const { path, suffix } = splitHref(href);
    const fragment = suffix.startsWith('#') ? decodeURIComponent(suffix.slice(1)) : '';
    const pageHref = (target: HelpPage): HrefResolution => {
      if (fragment) fragments.push({ from: page, to: target, fragment, href });
      return { href: style === 'html' ? `${target.url}${suffix}` : `${SITE_ORIGIN}${target.markdownUrl}${suffix}` };
    };
    if (!path) {
      // Footnote links are generated, not written, and #top is the page title.
      if (fragment && fragment !== 'top' && !fragment.startsWith('user-content-')) fragments.push({ from: page, to: page, fragment, href });
      return { href };
    }
    if (path.startsWith('/')) {
      if (!path.startsWith('/help')) return { href: style === 'html' ? href : `${SITE_ORIGIN}${href}` };
      const target = byUrl.get(path.endsWith('/') ? path : `${path}/`);
      return target ? pageHref(target) : { error: `${where} is not a help page` };
    }
    let file: string;
    try {
      file = resolve(dirname(page.sourcePath), decodeURIComponent(path));
    } catch {
      return { error: `${where} is not a valid path` };
    }
    if (file !== site.root && !file.startsWith(`${site.root}${sep}`)) return { error: `${where} leaves the help folder` };
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.md');
    if (file.endsWith('.md')) {
      const target = byPath.get(file);
      if (target) return pageHref(target);
      return { error: existsSync(file) ? `${where} points at a draft or an unpublished file` : `${where} points at a page that does not exist` };
    }
    if (!existsSync(file)) return { error: `${where} points at a file that does not exist` };
    let published = assets.get(file);
    if (!published) {
      const hash = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 10);
      const extension = extname(file).toLowerCase();
      published = `/help/_assets/${basename(file, extname(file)).toLowerCase().replace(/[^a-z0-9]+/gu, '-')}-${hash}${extension}`;
      assets.set(file, published);
    }
    return { href: style === 'html' ? `${published}${suffix}` : `${SITE_ORIGIN}${published}${suffix}` };
  };
}

/**
 * The Markdown copy served beside each page, for agents and for "copy page".
 * The author's text is kept byte for byte except that each relative link is
 * replaced with the absolute URL of the target's own Markdown copy.
 */
function publishedMarkdown(page: HelpPage, resolveHref: (href: string, kind: 'link' | 'image') => HrefResolution): string {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(page.body) as MdastRoot;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  visit(tree, (node) => {
    if (node.type !== 'link' && node.type !== 'image' && node.type !== 'definition') return;
    const { url, position } = node as Link | Image | Definition;
    if (!position || /^[a-z][a-z0-9+.-]*:/iu.test(url) || url.startsWith('#') || url.startsWith('//')) return;
    const resolved = resolveHref(url, node.type === 'image' ? 'image' : 'link');
    if ('error' in resolved) return;
    const start = position.start.offset!;
    const end = position.end.offset!;
    const slice = page.body.slice(start, end);
    // The URL as written: the parsed `url` is decoded, the source may not be.
    const written = [url, encodeURI(url)].find((candidate) => slice.includes(candidate));
    if (!written) return;
    const at = start + slice.lastIndexOf(written);
    edits.push({ start: at, end: at + written.length, text: resolved.href });
  });
  let body = page.body;
  for (const edit of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  // The pointer comes first so an agent that truncates the page still learns
  // where the rest of the manual is.
  const chapterIndex = page.chapter ? `\n> This chapter's pages: ${SITE_ORIGIN}/help/${page.chapter.slug}/llms.txt` : '';
  return `> Rally Help Center. Index of every page: ${SITE_ORIGIN}/help/llms.txt${chapterIndex}\n\n`
    + `# ${page.frontMatter.title}\n\n> ${page.frontMatter.description}\n\n${body.trim()}\n`;
}

const llmsLine = (page: HelpPage): string =>
  `- [${page.kind === 'page' ? `${pageNumber(page)} ` : ''}${page.frontMatter.title}](${SITE_ORIGIN}${page.markdownUrl}): ${page.frontMatter.description}`;

function llmsIndex(site: HelpSite): string {
  const chapters = site.chapters.map((chapter) =>
    [`## Chapter ${chapter.number}: ${chapter.intro.frontMatter.title}`, '', `${chapter.intro.frontMatter.description} Index of this chapter: ${SITE_ORIGIN}/help/${chapter.slug}/llms.txt`, '', llmsLine(chapter.intro), ...chapter.pages.map(llmsLine)].join('\n'));
  return [
    '# Rally Help Center',
    '',
    `> ${site.home.frontMatter.description}`,
    '',
    'Rally is a desktop app where people and AI agents work together in Canvases and Sidekicks. This is its user manual, written as a book: chapters run from installing Rally to running Sidekicks across an Organization.',
    '',
    `Every page is Markdown at the URL listed below, and any page URL answers \`Accept: text/markdown\` with the same Markdown. Each chapter has its own index at /help/<chapter>/llms.txt. The whole manual in one file: ${SITE_ORIGIN}/help/llms-full.txt`,
    '',
    llmsLine(site.home),
    '',
    ...chapters.flatMap((chapter) => [chapter, '']),
  ].join('\n');
}

function chapterLlmsIndex(chapter: HelpChapter): string {
  return [
    `# Rally Help Center, Chapter ${chapter.number}: ${chapter.intro.frontMatter.title}`,
    '',
    `> ${chapter.intro.frontMatter.description}`,
    '',
    `Part of the Rally manual. The index of every chapter is ${SITE_ORIGIN}/help/llms.txt.`,
    '',
    llmsLine(chapter.intro),
    ...chapter.pages.map(llmsLine),
    '',
  ].join('\n');
}

function sitemap(site: HelpSite): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + site.pages.map((page) => `  <url>\n    <loc>${escapeHtml(`${SITE_ORIGIN}${page.url}`)}</loc>\n  </url>\n`).join('')
    + '</urlset>\n';
}

export function buildHelp(root: string, options: BuildHelpOptions): HelpOutputs {
  const site = loadHelpSite(root, { includeDrafts: options.includeDrafts });
  const byPath = new Map(site.pages.map((page) => [page.sourcePath, page]));
  const byUrl = new Map(site.pages.map((page) => [page.url, page]));
  const assets = new Map<string, string>();
  const fragments: FragmentCheck[] = [];
  const problems: string[] = [];
  const outputs: HelpOutputs = new Map();
  const headingsByPage = new Map<HelpPage, HelpHeading[]>();
  const search: SearchEntry[] = [];
  const markdownCopies: string[] = [];

  for (const page of site.pages) {
    const rendered = renderMarkdown(page.body, {
      resolveHref: hrefResolver(site, byPath, byUrl, assets, fragments, page, 'html'),
    });
    problems.push(...rendered.problems);
    headingsByPage.set(page, rendered.headings);
    outputs.set(outputPathFor(page.url), renderLayout({ site, page, html: rendered.html, headings: rendered.headings, assets: options.assets }));
    const markdown = publishedMarkdown(page, hrefResolver(site, byPath, byUrl, new Map(assets), [], page, 'markdown'));
    outputs.set(page.markdownUrl.slice(1), markdown);
    markdownCopies.push(markdown);
    search.push({
      t: page.frontMatter.title,
      c: chapterLabel(page),
      u: page.url,
      d: page.frontMatter.description,
      h: rendered.headings.map((heading) => [heading.id, heading.text]),
      x: rendered.text,
    });
  }

  for (const check of fragments) {
    const ids = headingsByPage.get(check.to)?.map((heading) => heading.id) ?? [];
    if (check.fragment !== 'top' && !ids.includes(check.fragment)) {
      problems.push(`${check.from.sourceName}: link "${check.href}" names a heading that ${check.to.sourceName} does not have (it has: ${ids.join(', ') || 'none'})`);
    }
  }
  if (problems.length > 0) throw new HelpContentError(problems);

  for (const [file, published] of assets) outputs.set(published.slice(1), readFileSync(file));
  outputs.set('help/llms.txt', llmsIndex(site));
  for (const chapter of site.chapters) outputs.set(`help/${chapter.slug}/llms.txt`, chapterLlmsIndex(chapter));
  outputs.set('help/llms-full.txt', `${llmsIndex(site)}\n${markdownCopies.join('\n---\n\n')}`);
  outputs.set('help/search-index.json', JSON.stringify(search));
  outputs.set('help/sitemap.xml', sitemap(site));
  return outputs;
}
