// The public site is static assets. This Worker runs only for the homepage and
// /help/ (see `run_worker_first` in wrangler.jsonc). On the homepage it sets the
// landing CSP; under /help/ an agent that asks for Markdown gets the page's
// Markdown copy at the same URL, and every help response tells an agent where
// the manual's index is. Everything else is served by the asset layer without
// this script running.

import { LANDING_CSP } from './landing-csp';

interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

const INDEX_LINKS = '</help/llms.txt>; rel="llms-txt", </help/llms-full.txt>; rel="llms-full-txt"';

interface MediaRange {
  type: string;
  q: number;
  position: number;
}

function mediaRanges(accept: string): MediaRange[] {
  return accept.split(',').map((part, position) => {
    const [type = '', ...parameters] = part.trim().toLowerCase().split(';');
    const q = parameters.map((parameter) => /^\s*q=([\d.]+)\s*$/u.exec(parameter)?.[1]).find((value) => value !== undefined);
    return { type: type.trim(), q: q === undefined ? 1 : Number(q), position };
  }).filter((range) => range.type);
}

/**
 * True when the client ranks Markdown above HTML. Equal weights are broken by
 * the order the client listed them in, which is how Claude Code states its
 * preference; a browser's `text/html,...,*\/*` never names Markdown and so
 * always gets HTML.
 */
export function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  const ranges = mediaRanges(accept);
  const markdown = ranges.find((range) => range.type === 'text/markdown' || range.type === 'text/x-markdown');
  if (!markdown || markdown.q <= 0) return false;
  const html = ranges.find((range) => range.type === 'text/html')
    ?? ranges.find((range) => range.type === 'text/*')
    ?? ranges.find((range) => range.type === '*/*');
  if (!html || html.q < markdown.q) return true;
  return html.q === markdown.q && markdown.position < html.position;
}

/** `/help/sidekicks/schedules/` -> `/help/sidekicks/schedules.md`; files map to nothing. */
export function markdownPathFor(pathname: string): string | null {
  if (pathname === '/help' || pathname === '/help/') return '/help/index.md';
  if (!pathname.startsWith('/help/') || /\.[a-z0-9]+$/iu.test(pathname)) return null;
  return `${pathname.replace(/\/+$/u, '')}.md`;
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  const result = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) result.headers.set(name, value);
  return result;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/') return withHeaders(await env.ASSETS.fetch(request), { 'Content-Security-Policy': LANDING_CSP });
    const markdownPath = markdownPathFor(url.pathname);
    const negotiable = markdownPath !== null && (request.method === 'GET' || request.method === 'HEAD');

    if (negotiable && prefersMarkdown(request.headers.get('Accept'))) {
      const markdown = await env.ASSETS.fetch(new Request(new URL(markdownPath, url), { method: request.method, headers: request.headers }));
      if (markdown.ok) {
        return withHeaders(markdown, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Vary': 'Accept',
          'X-Robots-Tag': 'noindex',
          'Link': INDEX_LINKS,
        });
      }
    }

    const response = await env.ASSETS.fetch(request);
    const headers: Record<string, string> = { 'Link': INDEX_LINKS, 'X-Llms-Txt': '/help/llms.txt' };
    if (negotiable) {
      headers.Vary = 'Accept';
      headers.Link = `<${markdownPath}>; rel="alternate"; type="text/markdown", ${INDEX_LINKS}`;
    }
    if (url.pathname.endsWith('.md')) {
      headers['Content-Type'] = 'text/markdown; charset=utf-8';
      headers['X-Robots-Tag'] = 'noindex';
    }
    if (url.pathname.endsWith('.txt')) headers['Content-Type'] = 'text/plain; charset=utf-8';
    return withHeaders(response, headers);
  },
};
