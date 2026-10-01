/**
 * Builds the blog from GitHub-flavored Markdown at build time: one file per
 * post in `content/blog/`, front matter plus a plain Markdown body, rendered
 * to `/blog/<slug>/`, and a `/blog/` page listing every post, newest first.
 * Node only: Vite and the tests call it, the browser never does.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { marked } from 'marked';
import { parse as parseYaml } from 'yaml';
import { escapeHtml } from './comparison-pages';

export interface BlogPost {
  /** Path segment under `/blog/`, and the Markdown file's name. */
  slug: string;
  title: string;
  description: string;
  /** `YYYY-MM-DD`: the day the post was published. */
  date: string;
  author: string;
  body: string;
  /** The whole file, front matter included, as published beside the page. */
  source: string;
}

const ORIGIN = 'https://rallywith.ai';
/** The index shares the home page's card; each post has its own, drawn at build time. */
const HOME_IMAGE = `${ORIGIN}/rally-social-v01.jpg`;
const FIELDS = ['slug', 'title', 'description', 'date', 'author'] as const;

export function parseBlogPost(source: string, file: string): BlogPost {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(source);
  if (!match) throw new Error(`${file}: missing front matter`);
  const data = parseYaml(match[1] ?? '') as Record<string, unknown>;
  for (const field of FIELDS) {
    if (data[field] === undefined || data[field] === '') throw new Error(`${file}: front matter is missing "${field}"`);
  }
  // YAML reads an unquoted date as a Date; keep the day as written.
  const date = data.date instanceof Date ? data.date.toISOString().slice(0, 10) : String(data.date);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error(`${file}: date "${date}" is not YYYY-MM-DD`);
  return {
    slug: String(data.slug), title: String(data.title), description: String(data.description),
    date, author: String(data.author), body: match[2] ?? '', source,
  };
}

export function loadBlogPosts(directory: URL): BlogPost[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const post = parseBlogPost(readFileSync(new URL(name, directory), 'utf8'), name);
      if (`${post.slug}.md` !== name) throw new Error(`${name}: slug "${post.slug}" does not match the file name`);
      return post;
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}

const longDate = (date: string): string =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

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

export function renderBlogIndex(posts: readonly BlogPost[]): string {
  const items = posts.map(({ slug, title, description, date }) =>
    `<li><a class="blog-entry" href="/blog/${slug}/"><time datetime="${date}">${longDate(date)}</time>`
    + `<span class="blog-entry-title">${escapeHtml(title)}</span><span class="blog-entry-summary">${escapeHtml(description)}</span></a></li>`).join('');
  return page({
    path: '/blog/', title: 'Blog · Rally', description: 'News and writing from the team building Rally.', type: 'website', image: HOME_IMAGE, extraHead: '',
    main: `<div class="blog">\n<p class="eyebrow">Blog</p>\n<h1 class="display blog-title">From the Rally team</h1>\n<ol class="blog-list">${items}</ol>\n</div>`,
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
      + `<div class="blog-body">${marked.parse(post.body, { async: false })}</div>\n</article>`,
  });
}
