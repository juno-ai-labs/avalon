/**
 * Builds the "Rally vs X" pages from GitHub-flavored Markdown at build time.
 * Each rival is one file in `content/compare/`, front matter plus a body with
 * fixed `##` headings, so the file reads well on GitHub and renders here into
 * the landing page's section layout. Node only: Vite and the tests call it,
 * the browser never does.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { marked, type Token, type Tokens } from 'marked';
import { parse as parseYaml } from 'yaml';

export interface Comparison {
  /** Path segment under `/compare/`, and the Markdown file's name. */
  slug: string;
  name: string;
  maker: string;
  /** Position in the footer, the table, and the build. */
  order: number;
  title: string;
  description: string;
  /** `YYYY-MM-DD`: when the claims were last checked against the rival. */
  updated: string;
  /** What the product is, in one plain line. */
  kind: string;
  /** Why a team would pick Rally instead, in one plain line. */
  edge: string;
  body: string;
  /** The whole file, front matter included, as published beside the page. */
  source: string;
}

const ORIGIN = 'https://rallywith.ai';
const DOWNLOAD = 'https://downloads.rallywith.ai/stable/darwin/arm64/Rally.dmg';
const FIELDS = ['slug', 'name', 'maker', 'order', 'title', 'description', 'updated', 'kind', 'edge'] as const;

export function parseComparison(source: string, file: string): Comparison {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(source);
  if (!match) throw new Error(`${file}: missing front matter`);
  const data = parseYaml(match[1] ?? '') as Record<string, unknown>;
  for (const field of FIELDS) {
    if (data[field] === undefined || data[field] === '') throw new Error(`${file}: front matter is missing "${field}"`);
  }
  return {
    slug: String(data.slug), name: String(data.name), maker: String(data.maker), order: Number(data.order),
    title: String(data.title), description: String(data.description),
    updated: String(data.updated),
    kind: String(data.kind), edge: String(data.edge), body: match[2] ?? '', source,
  };
}

export function loadComparisons(directory: URL): Comparison[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const comparison = parseComparison(readFileSync(new URL(name, directory), 'utf8'), name);
      if (`${comparison.slug}.md` !== name) throw new Error(`${name}: slug "${comparison.slug}" does not match the file name`);
      return comparison;
    })
    .sort((a, b) => a.order - b.order);
}

export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);

const inline = (text: string): string => marked.parseInline(text, { async: false });
const blocks = (tokens: Token[]): string => marked.parser(tokens, { async: false });
const plain = (html: string): string =>
  html.replace(/<[^>]+>/gu, '').replace(/&(amp|lt|gt|quot|#39);/gu, (_m, entity: string) =>
    ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[entity] ?? '');
const anchor = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '');

/** A heading and the tokens under it, up to the next heading of the same depth. */
interface Part { heading: string; tokens: Token[] }

/** Splits tokens at each heading of the given depth. */
function splitAt(tokens: Token[], depth: number): { before: Token[]; parts: Part[] } {
  const before: Token[] = [];
  const parts: Part[] = [];
  for (const token of tokens) {
    if (token.type === 'heading' && (token as Tokens.Heading).depth === depth) {
      parts.push({ heading: (token as Tokens.Heading).text, tokens: [] });
    } else if (parts.length > 0) {
      parts[parts.length - 1]?.tokens.push(token);
    } else if (token.type !== 'space') {
      before.push(token);
    }
  }
  return { before, parts };
}

function renderTable(token: Token | undefined, name: string, file: string): string {
  if (token?.type !== 'table') throw new Error(`${file}: "Side by side" must hold a table`);
  const table = token as Tokens.Table;
  const rows = table.rows.map(([label, rally, rival]) =>
    `<tr><th scope="row">${inline(label?.text ?? '')}</th>`
    + `<td class="versus-rally" data-label="Rally">${inline(rally?.text ?? '')}</td>`
    + `<td data-label="${escapeHtml(name)}">${inline(rival?.text ?? '')}</td></tr>`).join('');
  return `<div class="versus-table-wrap"><table class="versus-table">`
    + `<caption class="visually-hidden">Rally compared with ${escapeHtml(name)}</caption>`
    + `<thead><tr><th scope="col"><span class="visually-hidden">Question</span></th><th scope="col" class="versus-rally">Rally</th><th scope="col">${escapeHtml(name)}</th></tr></thead>`
    + `<tbody>${rows}</tbody></table></div>`;
}

function renderPoints(tokens: Token[]): string {
  const { parts } = splitAt(tokens.filter((token) => token.type !== 'blockquote'), 3);
  const asides = tokens.filter((token): token is Tokens.Blockquote => token.type === 'blockquote');
  return `<ul class="points">${parts.map(({ heading, tokens: body }) =>
    `<li><h3>${inline(heading)}</h3>${blocks(body)}</li>`).join('')}</ul>`
    + asides.map((aside) => `<div class="compare-aside">${blocks(aside.tokens)}</div>`).join('');
}

function renderVerdicts(tokens: Token[], file: string): string {
  const { parts } = splitAt(tokens, 3);
  if (!parts.some(({ heading }) => heading === 'Pick Rally if')) throw new Error(`${file}: "Which one should you pick?" needs a "### Pick Rally if"`);
  return `<div class="verdicts">${parts.map(({ heading, tokens: body }) =>
    `<div class="verdict${heading === 'Pick Rally if' ? ' verdict-rally' : ''}"><h3>${inline(heading)}</h3>${blocks(body)}</div>`).join('')}</div>`
    + `<div class="compare-cta"><a class="button" href="/#pricing">See Rally pricing</a><a class="button button-outline" href="/compare/">Compare Rally with other tools</a></div>`;
}

function questions(tokens: Token[]): { question: string; answer: string }[] {
  return splitAt(tokens, 3).parts.map(({ heading, tokens: body }) => ({ question: heading, answer: blocks(body) }));
}

/** The section types a comparison page is built from, keyed by `##` heading. */
function sectionKind(heading: string): { eyebrow: string; nav: string; kind: 'table' | 'points' | 'verdicts' | 'faq' | 'sources' } {
  if (heading === 'Side by side') return { eyebrow: 'Side by side', nav: 'Side by side', kind: 'table' };
  if (heading === 'Where Rally wins') return { eyebrow: 'Our side of the story', nav: 'Where Rally wins', kind: 'points' };
  if (heading.startsWith('Where ')) return { eyebrow: 'Credit where due', nav: heading, kind: 'points' };
  if (heading.startsWith('Which one')) return { eyebrow: 'Verdict', nav: 'Which to pick', kind: 'verdicts' };
  if (heading === 'Questions') return { eyebrow: 'Questions', nav: 'Questions', kind: 'faq' };
  if (heading === 'Sources') return { eyebrow: 'Sources', nav: 'Sources', kind: 'sources' };
  throw new Error(`Unknown comparison section "${heading}"`);
}

export function renderComparisonPage(comparison: Comparison): string {
  const { slug, name, maker, title, description, updated } = comparison;
  const file = `${slug}.md`;
  const path = `/compare/${slug}/`;
  const { before, parts } = splitAt(marked.lexer(comparison.body), 2);
  if (before.length === 0) throw new Error(`${file}: the short answer must come before the first heading`);
  const required = ['Side by side', `Where ${name} shines`, 'Where Rally wins', 'Which one should you pick?', 'Questions', 'Sources'];
  for (const heading of required) {
    if (!parts.some((part) => part.heading === heading)) throw new Error(`${file}: missing "## ${heading}"`);
  }

  let faq: { question: string; answer: string }[] = [];
  const sections = parts.map(({ heading, tokens }, index) => {
    const { eyebrow, nav, kind } = sectionKind(heading);
    const id = anchor(nav);
    let body: string;
    if (kind === 'table') body = renderTable(tokens.find((token) => token.type !== 'space'), name, file);
    else if (kind === 'points') body = renderPoints(tokens);
    else if (kind === 'verdicts') body = renderVerdicts(tokens, file);
    else if (kind === 'faq') {
      faq = questions(tokens);
      body = `<div class="faq">${faq.map(({ question, answer }) =>
        `<details><summary>${inline(question)}</summary>${answer}</details>`).join('')}</div>`;
    } else body = `<div class="sources">${blocks(tokens)}</div>`;
    return {
      id, nav,
      html: `<section class="section${index % 2 === 0 ? ' raised' : ''}" id="${id}" aria-labelledby="${id}-title">\n`
        + `<p class="eyebrow">${escapeHtml(eyebrow)}</p>\n<h2 id="${id}-title" class="display">${inline(heading)}</h2>\n${body}\n</section>`,
    };
  });

  const answer = blocks(before).replace(/^<p>/u, '<p class="compare-answer">');
  const date = new Date(`${updated}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const rally = {
    '@type': 'SoftwareApplication', '@id': `${ORIGIN}/#rally`, name: 'Rally', url: `${ORIGIN}/`,
    applicationCategory: 'BusinessApplication', operatingSystem: 'macOS',
    publisher: { '@type': 'Organization', name: 'Juno AI Labs Inc', url: `${ORIGIN}/` },
    offers: [
      { '@type': 'Offer', name: 'Start', price: '100', priceCurrency: 'USD', description: 'Per organization per month, no seat limit' },
      { '@type': 'Offer', name: 'Grow', price: '250', priceCurrency: 'USD', description: 'Per organization per month, no seat limit' },
    ],
  };
  const structured = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage', '@id': ORIGIN + path, url: ORIGIN + path, name: title, description, dateModified: updated,
        primaryImageOfPage: { '@type': 'ImageObject', url: `${ORIGIN}${path}social.png`, width: 1200, height: 630 },
        inLanguage: 'en', author: { '@type': 'Organization', name: 'Juno AI Labs Inc' },
        isPartOf: { '@type': 'WebSite', name: 'Rally', url: `${ORIGIN}/` },
        about: [{ '@id': `${ORIGIN}/#rally` }, { '@type': 'SoftwareApplication', name, publisher: { '@type': 'Organization', name: maker } }],
      },
      rally,
      {
        '@type': 'BreadcrumbList', itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Rally', item: `${ORIGIN}/` },
          { '@type': 'ListItem', position: 2, name: 'Compared to', item: `${ORIGIN}/compare/` },
          { '@type': 'ListItem', position: 3, name: `Rally vs ${name}`, item: ORIGIN + path },
        ],
      },
      {
        '@type': 'FAQPage', mainEntity: faq.map(({ question, answer: text }) => ({
          '@type': 'Question', name: plain(question), acceptedAnswer: { '@type': 'Answer', text: plain(text).trim() },
        })),
      },
    ],
  };
  // `<` cannot appear raw inside a script element's JSON.
  const json = JSON.stringify(structured).replace(/</gu, '\\u003c');

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
    <link rel="alternate" type="text/markdown" href="${ORIGIN}${path}index.md" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="Rally" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${ORIGIN}${path}" />
    <meta property="og:image" content="${ORIGIN}${path}social.png" />
    <meta property="og:image:secure_url" content="${ORIGIN}${path}social.png" />
    <meta property="og:image:type" content="image/png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="Rally vs ${escapeHtml(name)}: ${escapeHtml(comparison.edge)}" />
    <meta property="article:modified_time" content="${updated}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${ORIGIN}${path}social.png" />
    <meta name="twitter:image:alt" content="Rally vs ${escapeHtml(name)}: ${escapeHtml(comparison.edge)}" />
    <link rel="stylesheet" href="/src/landing.css" />
    <script type="module" src="/src/section-nav.ts"></script>
    <script type="application/ld+json">${json}</script>
  </head>
<body>
<a class="skip-link" href="#content">Skip to content</a>
<header class="site-header"><div class="site-header-inner">
<a class="wordmark" href="/" aria-label="Rally home"><img class="rally-symbol" src="/brand/rally-mark-ink.svg" width="24" height="24" alt="">rally</a>
<nav aria-label="Primary"><a class="header-link" href="/#features">Features</a><a class="header-link" href="/#pricing">Pricing</a><a class="header-link" href="/compare/">Compare</a><a class="button button-small" data-site-action="download-header" href="${DOWNLOAD}" download>Download for Mac</a></nav>
</div></header>
<main id="content">
<article class="compare-page">
<header class="compare-hero">
<nav class="breadcrumbs" aria-label="Breadcrumb"><ol><li><a href="/">Rally</a></li><li><a href="/compare/">Compared to</a></li><li aria-current="page">Rally vs ${escapeHtml(name)}</li></ol></nav>
<h1 class="display compare-title">Rally <span class="compare-versus">vs</span> ${escapeHtml(name)}</h1>
${answer}
<p class="compare-meta">Updated <time datetime="${updated}">${date}</time> · Written by the Rally team. Yes, we’re biased. We tried to keep it fair anyway.</p>
</header>
<div class="sections">
<nav class="section-nav" aria-label="On this page" data-section-nav><ol>${sections.map(({ id, nav }, index) =>
    `<li><a href="#${id}"><span>${String(index + 1).padStart(2, '0')}</span>${escapeHtml(nav)}</a></li>`).join('')}</ol></nav>
<div class="section-list">
${sections.map(({ html }) => html).join('\n\n')}
</div>
</div>
</article>
</main>
<!-- rally:site-footer -->
</body></html>
`;
}
