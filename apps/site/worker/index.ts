// The public site is static assets. This Worker runs only for /help/ and
// /marks/ (see `run_worker_first` in wrangler.jsonc): an agent that asks for
// Markdown gets the help page's Markdown copy at the same URL, every help
// response tells an agent where the manual's index is, and `/marks/` draws a
// mark as a PNG (`marks.ts`). Everything else is served by the asset layer
// without this script running.

import { initWasm } from '@resvg/resvg-wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';

import { markdownPathFor, prefersMarkdown } from './help';
import { serveMark } from './marks';

interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

const INDEX_LINKS = '</help/llms.txt>; rel="llms-txt", </help/llms-full.txt>; rel="llms-full-txt"';

function withHeaders(response: Response, headers: Record<string, string>): Response {
  const result = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) result.headers.set(name, value);
  return result;
}

/** The one part of the Workers context this script uses. */
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

let resvgReady: Promise<void> | null = null;
/** Once per isolate; a failed start is retried by the next request rather than kept. */
function ensureResvg(): Promise<void> {
  resvgReady ??= initWasm(resvgWasm).catch((error: unknown) => {
    resvgReady = null;
    throw error;
  });
  return resvgReady;
}

async function cachedMark(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  // A Worker's response is not cached by the CDN on its own; the Cache API is
  // what makes each mark drawn about once per location.
  const cache = (caches as unknown as { default: Cache }).default;
  const hit = request.method === 'GET' ? await cache.match(request) : undefined;
  if (hit) return hit;
  const response = await serveMark(request, env, ensureResvg);
  if (request.method === 'GET' && response.ok && response.headers.get('Content-Type') === 'image/png') {
    context.waitUntil(cache.put(request, response.clone()));
  }
  return response;
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/marks/')) return cachedMark(request, env, context);
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
