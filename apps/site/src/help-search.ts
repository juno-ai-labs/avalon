// Ranking for the help center's search box. The index is built with the site
// (`build/help/site.ts`) and fetched the first time a reader opens search.

export interface SearchEntry {
  t: string;
  c: string;
  u: string;
  d: string;
  h: Array<[string, string]>;
  x: string;
}

export interface SearchHit {
  entry: SearchEntry;
  score: number;
  heading?: [string, string] | undefined;
  snippet: string;
}

export const words = (query: string): string[] =>
  query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);

function snippet(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  const at = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0).sort((a, b) => a - b)[0];
  if (at === undefined) return text.slice(0, 160);
  const start = Math.max(0, at - 60);
  return `${start > 0 ? '…' : ''}${text.slice(start, start + 180).trim()}…`;
}

export function searchEntries(entries: SearchEntry[], query: string): SearchHit[] {
  const terms = words(query);
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const entry of entries) {
    const title = entry.t.toLowerCase();
    const description = entry.d.toLowerCase();
    const text = entry.x.toLowerCase();
    let score = 0;
    let heading: [string, string] | undefined;
    let matchedAll = true;
    for (const term of terms) {
      const headingMatch = entry.h.find(([, label]) => label.toLowerCase().includes(term));
      const inTitle = title.includes(term);
      const inDescription = description.includes(term);
      const inText = text.includes(term);
      if (!inTitle && !headingMatch && !inDescription && !inText) { matchedAll = false; break; }
      score += (inTitle ? 12 : 0) + (title.split(/\s+/u).includes(term) ? 6 : 0) + (headingMatch ? 6 : 0) + (inDescription ? 4 : 0) + (inText ? 1 : 0);
      if (headingMatch && !heading && !inTitle) heading = headingMatch;
    }
    if (!matchedAll) continue;
    hits.push({ entry, score, heading, snippet: snippet(entry.x || entry.d, terms) });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 12);
}
