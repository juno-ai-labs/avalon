/**
 * Builds the blog from GitHub-flavored Markdown at build time: one file per
 * post in `content/blog/`, named `YYYY-MM-DD-<slug>.md`, front matter plus a
 * Markdown body, rendered to `/blog/<slug>/`, and a `/blog/` changelog that
 * shows the newest post in full and every older one as its first paragraph.
 * Node only: Vite and the tests call it, the browser never does.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { marked } from 'marked';
import { parse as parseYaml } from 'yaml';
import { escapeHtml, longDate } from './comparison-pages';

export interface BlogPost {
  /** Path segment under `/blog/`: the file name after its date. */
  slug: string;
  title: string;
  description: string;
  /** `YYYY-MM-DD`: the day the post was published, from the file name. */
  date: string;
  author: string;
  body: string;
  /** The whole file, front matter included, as published beside the page. */
  source: string;
}

const ORIGIN = 'https://rallywith.ai';
/** The index shares the home page's card; each post has its own, drawn at build time. */
const HOME_IMAGE = `${ORIGIN}/rally-social-v01.jpg`;
const FIELDS = ['title', 'description', 'author'] as const;

/**
 * Parses one post. The file name, `YYYY-MM-DD-<slug>.md`, is the only place
 * the date and slug live, so front matter that repeats either is refused
 * rather than left to drift from the name.
 */
export function parseBlogPost(source: string, file: string): BlogPost {
  const name = /^(\d{4}-\d{2}-\d{2})-([a-z0-9-]+)\.md$/u.exec(file);
  // The slug is the URL segment, so it keeps to what a path and the dev server accept.
  if (!name) throw new Error(`${file}: file name must be YYYY-MM-DD-<slug>.md, the slug in lowercase letters, digits and hyphens`);
  const date = name[1] ?? '';
  // The day must exist: `Date` would quietly turn 2026-02-30 into March 2.
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error(`${file}: date "${date}" is not a real YYYY-MM-DD day`);
  }
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(source);
  if (!match) throw new Error(`${file}: missing front matter`);
  const data = parseYaml(match[1] ?? '') as Record<string, unknown>;
  for (const field of FIELDS) {
    if (data[field] === undefined || data[field] === '') throw new Error(`${file}: front matter is missing "${field}"`);
  }
  for (const field of ['date', 'slug']) {
    if (field in data) throw new Error(`${file}: "${field}" comes from the file name, not the front matter`);
  }
  return {
    slug: name[2] ?? '', title: String(data.title), description: String(data.description),
    date, author: String(data.author), body: match[2] ?? '', source,
  };
}

export function loadBlogPosts(directory: URL): BlogPost[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.md'))
    .map((name) => parseBlogPost(readFileSync(new URL(name, directory), 'utf8'), name))
    .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}

/** The document both blog pages share: head, site header, and footer. */
function page({ path, title, description, type, image, extraHead, main }: {
  path: string; title: string; description: string; type: 'website' | 'article'; image: string; extraHead: string; main: string;
}): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#0a0a0a" />
    <link rel="icon" href="/favicon.png" type="image/png" sizes="64x64" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180" />
    <link rel="manifest" href="/site.webmanifest" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <link rel="canonical" href="${ORIGIN}${path}" />
    <meta property="og:type" content="${type}" />
    <meta property="og:site_name" content="Rally" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${ORIGIN}${path}" />
    <meta property="og:image" content="${image}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${image}" />
${extraHead}    <link rel="stylesheet" href="/src/landing.css" />
  </head>
<body>
<a class="skip-link" href="#content">Skip to content</a>
<header class="site-header"><div class="site-header-inner">
<a class="wordmark" href="/" aria-label="Rally home"><img class="rally-symbol" src="/brand/rally-mark-ink.svg" width="24" height="24" alt="">rally</a>
<!-- rally:site-nav -->
</div></header>
<main id="content">
${main}
</main>
<!-- rally:site-footer -->
</body></html>
`;
}

const renderMarkdown = (markdown: string): string => marked.parse(markdown, { async: false });

/** The post's first paragraph as Markdown, or nothing if the body has none. */
function firstParagraph(body: string): string {
  return marked.lexer(body).find((token) => token.type === 'paragraph')?.raw ?? '';
}

/**
 * `/blog/` as a changelog: a date rail on the left and the posts on the right,
 * newest first. The newest post shows in full; each older one shows its first
 * paragraph and a link to the rest.
 */
export function renderBlogIndex(posts: readonly BlogPost[]): string {
  const entries = posts.map((post, index) => {
    const { slug, title, date, body } = post;
    const href = `/blog/${slug}/`;
    const content = index === 0
      ? `<div class="blog-body">${renderMarkdown(body)}</div>`
      : `<div class="blog-body">${renderMarkdown(firstParagraph(body))}</div>`
        + `<a class="changelog-more" href="${href}" aria-label="Read more: ${escapeHtml(title)}">Read more <span aria-hidden="true">→</span></a>`;
    return `<article class="changelog-entry"><div class="changelog-date"><time datetime="${date}">${longDate(date)}</time></div>`
      + `<div class="changelog-content"><h2 class="changelog-title"><a href="${href}">${escapeHtml(title)}</a></h2>${content}</div></article>`;
  }).join('\n');
  return page({
    path: '/blog/', title: 'Blog · Rally', description: 'News and writing from the team building Rally.', type: 'website', image: HOME_IMAGE, extraHead: '',
    main: `<div class="changelog">\n<h1 class="display changelog-heading">Blog</h1>\n<div class="changelog-entries">\n${entries}\n</div>\n</div>`,
  });
}

export function renderBlogPost(post: BlogPost): string {
  const { slug, title, description, date, author } = post;
  const path = `/blog/${slug}/`;
  const image = `${ORIGIN}${path}social.png`;
  const structured = {
    '@context': 'https://schema.org', '@type': 'BlogPosting', headline: title, description, datePublished: date,
    url: ORIGIN + path, image, inLanguage: 'en',
    author: { '@type': 'Organization', name: author },
    publisher: { '@type': 'Organization', name: 'Juno AI Labs Inc', url: `${ORIGIN}/` },
  };
  // `<` cannot appear raw inside a script element's JSON.
  const json = JSON.stringify(structured).replace(/</gu, '\\u003c');
  return page({
    path, title: `${title} · Rally`, description, type: 'article', image,
    extraHead: `    <link rel="alternate" type="text/markdown" href="${ORIGIN}${path}index.md" />\n`
      + `    <meta property="article:published_time" content="${date}" />\n`
      + `    <script type="application/ld+json">${json}</script>\n`,
    main: `<article class="blog">\n<nav class="breadcrumbs" aria-label="Breadcrumb"><ol><li><a href="/">Rally</a></li><li><a href="/blog/">Blog</a></li><li aria-current="page">${escapeHtml(title)}</li></ol></nav>\n`
      + `<h1 class="display blog-title">${escapeHtml(title)}</h1>\n`
      + `<p class="blog-meta"><time datetime="${date}">${longDate(date)}</time> · ${escapeHtml(author)}</p>\n`
      + `<div class="blog-body">${renderMarkdown(post.body)}</div>\n</article>`,
  });
}
