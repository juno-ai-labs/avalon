export interface MatchRange { start: number; end: number }

/** Literal Unicode case-insensitive matches, with offsets into unchanged text. */
export function literalMatchRanges(text: string, query: string): MatchRange[] {
  if (!query) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...text.matchAll(new RegExp(escaped, 'giu'))].map((match) => ({
    start: match.index, end: match.index + match[0].length,
  }));
}

/** The caller chooses the preview size for its surface; offsets stay canonical. */
export function matchingPassage(text: string, ranges: readonly MatchRange[], contextCharacters: number) {
  const first = ranges[0];
  if (!first) return null;
  let start = Math.max(0, first.start - contextCharacters);
  let end = Math.min(text.length, first.end + contextCharacters);
  // UTF-16 offsets are shared with the renderer, but never cut a surrogate pair.
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]!)) start -= 1;
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end]!)) end += 1;
  const leading = start > 0 ? '…' : '';
  return {
    excerpt: leading + text.slice(start, end) + (end < text.length ? '…' : ''),
    excerptStart: start,
    highlights: ranges.filter((range) => range.start >= start && range.end <= end).map((range) => ({
      start: range.start - start + leading.length, end: range.end - start + leading.length,
    })),
    range: first,
  };
}
