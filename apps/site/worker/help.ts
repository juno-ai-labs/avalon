// The help center's content negotiation, apart from the Worker entry so it can be
// tested without loading the entry's WebAssembly.

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
