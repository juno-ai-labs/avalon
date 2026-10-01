import GithubSlugger from 'github-slugger';
import type { Element, ElementContent, Root as HastRoot } from 'hast';
import { toString } from 'hast-util-to-string';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { SKIP, visit } from 'unist-util-visit';

export interface HelpHeading {
  depth: 1 | 2 | 3;
  id: string;
  text: string;
}

export type HrefResolution = { href: string } | { error: string };

export interface RenderMarkdownOptions {
  /** Maps an author's relative link or image source to its published URL. */
  resolveHref: (href: string, kind: 'link' | 'image') => HrefResolution;
}

export interface RenderedMarkdown {
  html: string;
  headings: HelpHeading[];
  /** Plain text of the body, for search. */
  text: string;
  problems: string[];
}

const ALERTS: Record<string, string> = { NOTE: 'Note', TIP: 'Tip', IMPORTANT: 'Important', WARNING: 'Warning', CAUTION: 'Caution' };
const ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\n?/u;
const BLOCKS = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th', 'pre', 'blockquote', 'div', 'dt', 'dd', 'summary', 'figcaption']);
const PLAIN_LANGUAGES = ['mermaid', 'text', 'txt', 'plain', 'plaintext'];

// GitHub's own sanitizer schema: the HTML an author may write in Markdown is
// exactly what github.com would render. Ids keep the author's spelling because
// the content is ours and links to it must match what the author typed.
const schema = { ...defaultSchema, clobberPrefix: '' };

const element = (tagName: string, properties: Element['properties'], children: ElementContent[]): Element =>
  ({ type: 'element', tagName, properties, children });

const isElement = (node: unknown, tagName?: string): node is Element =>
  typeof node === 'object' && node !== null && (node as Element).type === 'element'
  && (tagName === undefined || (node as Element).tagName === tagName);

function className(node: Element): string[] {
  const value = node.properties.className;
  return Array.isArray(value) ? value.map(String) : [];
}

/** The body as plain text for search, with a space wherever a block ends. */
function plainText(tree: HastRoot): string {
  const parts: string[] = [];
  const walk = (node: HastRoot | ElementContent): void => {
    if (node.type === 'text') parts.push(node.value);
    if (node.type !== 'root' && node.type !== 'element') return;
    const block = node.type === 'element' && BLOCKS.has(node.tagName);
    if (block) parts.push(' ');
    for (const child of node.children) walk(child as ElementContent);
    if (block) parts.push(' ');
  };
  walk(tree);
  return parts.join('').replace(/\s+/gu, ' ').trim();
}

/** GitHub's `> [!NOTE]` callouts, from the blockquote GFM leaves behind. */
function alerts(tree: HastRoot): void {
  visit(tree, 'element', (node) => {
    if (node.tagName !== 'blockquote') return;
    const first = node.children.find((child) => isElement(child));
    if (!isElement(first, 'p') || first.children[0]?.type !== 'text') return;
    const marker = ALERT_MARKER.exec(first.children[0].value);
    const kind = marker?.[1];
    if (!marker || !kind) return;
    first.children[0].value = first.children[0].value.slice(marker[0].length);
    if (first.children.length === 1 && !first.children[0].value.trim()) node.children.splice(node.children.indexOf(first), 1);
    node.tagName = 'div';
    node.properties = { className: ['markdown-alert', `markdown-alert-${kind.toLowerCase()}`] };
    node.children.unshift(element('p', { className: ['markdown-alert-title'] }, [{ type: 'text', value: ALERTS[kind] ?? kind }]));
  });
}

function rewriteLinks(tree: HastRoot, options: RenderMarkdownOptions, problems: string[]): void {
  visit(tree, 'element', (node) => {
    const attribute = node.tagName === 'a' ? 'href' : node.tagName === 'img' ? 'src' : undefined;
    if (!attribute) return;
    const value = node.properties[attribute];
    if (typeof value !== 'string' || !value) return;
    const remote = /^[a-z][a-z0-9+.-]*:/iu.test(value) || value.startsWith('//');
    if (remote && node.tagName === 'img') {
      // The site CSP allows images from 'self' and data: only, so the resolver
      // decides whether a remote image can ship at all.
      const resolved = options.resolveHref(value, 'image');
      if ('error' in resolved) problems.push(resolved.error);
    } else if (remote) {
      if (node.tagName === 'a' && /^https?:/iu.test(value)) {
        node.properties.rel = ['noopener'];
        node.properties.className = [...className(node), 'external'];
      }
    } else {
      // Same-page `#anchor` links go through the resolver too, so they are
      // checked against this page's headings like any other fragment.
      const resolved = options.resolveHref(value, node.tagName === 'a' ? 'link' : 'image');
      if ('error' in resolved) problems.push(resolved.error);
      else if (!value.startsWith('#')) node.properties[attribute] = resolved.href;
    }
    if (node.tagName === 'img') {
      node.properties.loading = 'lazy';
      node.properties.decoding = 'async';
    }
  });
}

function headings(tree: HastRoot): HelpHeading[] {
  const slugger = new GithubSlugger();
  const found: HelpHeading[] = [];
  visit(tree, 'element', (node) => {
    const level = /^h([1-6])$/u.exec(node.tagName)?.[1];
    if (!level) return;
    // Footnotes bring their own visually hidden heading; it is not a section.
    if (className(node).includes('sr-only')) return SKIP;
    const text = toString(node).trim();
    const id = typeof node.properties.id === 'string' && node.properties.id ? slugger.slug(node.properties.id, true) : slugger.slug(text);
    node.properties.id = id;
    node.children.push(element('a', { className: ['anchor'], href: `#${id}`, ariaHidden: 'true', tabIndex: -1 }, [{ type: 'text', value: '#' }]));
    const depth = Number(level);
    if (depth <= 3) found.push({ depth: depth as 1 | 2 | 3, id, text });
    return SKIP;
  });
  return found;
}

/**
 * Wraps tables so they scroll on their own, and code blocks so the script can
 * add a copy button. The language label is drawn from `data-lang` in CSS.
 */
function chrome(tree: HastRoot): void {
  visit(tree, 'element', (node, index, parent) => {
    if (!parent || index === undefined) return;
    if (node.tagName === 'table') {
      parent.children[index] = element('div', { className: ['table'] }, [node]);
      return SKIP;
    }
    if (node.tagName !== 'pre' || !isElement(node.children[0], 'code')) return;
    const language = className(node.children[0]).find((name) => name.startsWith('language-'))?.slice('language-'.length);
    const properties: Element['properties'] = { className: ['code'] };
    if (language) properties.dataLang = language;
    parent.children[index] = element('div', properties, [node]);
    return SKIP;
  });
}

export function renderMarkdown(source: string, options: RenderMarkdownOptions): RenderedMarkdown {
  const problems: string[] = [];
  let found: HelpHeading[] = [];
  let text = '';
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, schema)
    .use(rehypeHighlight, { detect: false, plainText: PLAIN_LANGUAGES, prefix: 'hl-' })
    .use(() => (tree: HastRoot) => {
      alerts(tree);
      rewriteLinks(tree, options, problems);
      text = plainText(tree);
      found = headings(tree);
      chrome(tree);
    })
    .use(rehypeStringify);
  const html = String(processor.processSync(source));
  return { html, headings: found, text, problems };
}
