// The renderer's real stylesheet, as Vite builds it: `@rally/ui`'s `app.css`
// with its imports inlined. The renderer project's `css.include` is what makes
// `?inline` hand back the text rather than an empty string.
import appStylesheet from '@rally/ui/styles/app.css?inline';

/** The window the stylesheet's media queries are evaluated against. */
export interface StylesheetViewport {
  width: number;
  height: number;
}

/**
 * The media features other than size, at the values a desktop with no
 * accessibility preferences reports. A query naming a feature this does not
 * list throws, so a new query is evaluated deliberately rather than skipped.
 */
const PREFERENCES: Readonly<Record<string, string>> = {
  hover: 'hover',
  pointer: 'fine',
  'prefers-color-scheme': 'light',
  'prefers-contrast': 'no-preference',
  'prefers-reduced-motion': 'no-preference',
  'prefers-reduced-transparency': 'no-preference',
};

function featureMatches(feature: string, viewport: StylesheetViewport, mediaText: string): boolean {
  const pair = /^\(\s*([a-z-]+)\s*:\s*([^)]+?)\s*\)$/u.exec(feature);
  if (pair) {
    const [, name = '', value = ''] = pair;
    const size = /^(min|max)-(width|height)$/u.exec(name);
    if (size) {
      const pixels = /^(\d+(?:\.\d+)?)px$/u.exec(value);
      if (!pixels) throw new Error(`app-stylesheet: unsupported length in "${mediaText}"`);
      const actual = viewport[size[2] as 'width' | 'height'];
      return size[1] === 'min' ? actual >= Number(pixels[1]) : actual <= Number(pixels[1]);
    }
    if (name in PREFERENCES) return PREFERENCES[name] === value;
  }
  const range = /^\(\s*(width|height)\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)px\s*\)$/u.exec(feature);
  if (range) {
    const actual = viewport[range[1] as 'width' | 'height'];
    const limit = Number(range[3]);
    switch (range[2]) {
      case '<': return actual < limit;
      case '<=': return actual <= limit;
      case '>': return actual > limit;
      default: return actual >= limit;
    }
  }
  throw new Error(`app-stylesheet: unsupported media feature "${feature}" in "${mediaText}"`);
}

function queryMatches(mediaText: string, viewport: StylesheetViewport): boolean {
  return mediaText.split(',').some((query) => query.trim().split(/\s+and\s+/u)
    .every((feature) => featureMatches(feature.trim(), viewport, mediaText)));
}

/**
 * Mount the renderer's stylesheet into the jsdom document as a window of the
 * given size would apply it, so `getComputedStyle` runs the real cascade:
 * specificity, source order and which media blocks apply. jsdom evaluates a
 * media query only as `all` or `screen`, so each block is resolved here and
 * rewritten to one of those or to `not all`. Container queries, layout and
 * pseudo-elements are still outside what jsdom computes.
 *
 * Returns the function that removes it again.
 */
export function mountAppStylesheet(viewport: StylesheetViewport): () => void {
  const style = document.createElement('style');
  style.textContent = appStylesheet;
  document.head.append(style);
  const sheet = style.sheet;
  if (!sheet) throw new Error('app-stylesheet: the stylesheet did not parse');
  for (const rule of Array.from(sheet.cssRules)) {
    if (rule instanceof CSSMediaRule) {
      rule.media.mediaText = queryMatches(rule.media.mediaText, viewport) ? 'all' : 'not all';
    }
  }
  mounted = sheet;
  return () => {
    style.remove();
    if (mounted === sheet) mounted = null;
  };
}

let mounted: CSSStyleSheet | null = null;

/**
 * A selector's specificity as [ids, classes, types], counted the way the
 * stylesheet's own selectors are written: `#id`; `.class`, `[attribute]` and
 * a pseudo-class; an element name. Enough to order this stylesheet's
 * `::placeholder` rules, which use nothing else.
 */
function specificity(selector: string): [number, number, number] {
  const ids = selector.match(/#[\w-]+/gu)?.length ?? 0;
  const classes = selector.match(/\.[\w-]+|\[[^\]]+\]|(?<!:):[\w-]+/gu)?.length ?? 0;
  const types = selector.replace(/\[[^\]]+\]|::?[\w-]+(?:\([^)]*\))?|[#.][\w-]+/gu, ' ').match(/[a-z][\w-]*/giu)?.length ?? 0;
  return [ids, classes, types];
}

function outranks(a: [number, number, number], b: [number, number, number]): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! > b[index]!;
  }
  return true;
}

/**
 * The value the mounted stylesheet gives `property` on `element`'s
 * placeholder, which `getComputedStyle` cannot read: jsdom computes no
 * pseudo-element. Each `::placeholder` selector is matched against its
 * element, and the winner is the most specific, then the latest, of the
 * media blocks that apply. `undefined` when no rule sets it.
 */
export function placeholderDeclaration(element: Element, property: string): string | undefined {
  if (!mounted) throw new Error('app-stylesheet: mount the stylesheet first');
  let winner: { value: string; rank: [number, number, number] } | undefined;
  const visit = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) {
        if (rule.media.mediaText === 'all') visit(rule.cssRules);
      } else if (rule instanceof CSSStyleRule && rule.selectorText.includes('::placeholder')) {
        const value = rule.style.getPropertyValue(property);
        if (!value) continue;
        for (const selector of rule.selectorText.split(',')) {
          const subject = selector.trim();
          if (!subject.endsWith('::placeholder')) continue;
          const rank = specificity(subject);
          if (element.matches(subject.slice(0, -'::placeholder'.length)) && (!winner || outranks(rank, winner.rank))) {
            winner = { value, rank };
          }
        }
      }
    }
  };
  visit(mounted.cssRules);
  return winner?.value;
}
