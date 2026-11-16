/**
 * Refuses a literal font size in the client's stylesheets.
 *
 * Every size names a role from the type scale (`var(--av-sys-type-body)`), or a
 * token built on one, so a density can move all of them together; one literal
 * is one size the phone's touch density silently leaves at its desktop value.
 * The scale and the densities are in `config/design-tokens/`; `docs/theming.md`
 * owns the reasoning.
 *
 * A declaration may opt out with a `/* type-scale: <reason> *\/` comment
 * inside it or straight after its `;`, for a size that is not reading text: a
 * letter drawn inside a fixed tile, or the 16px floor that stops iOS zooming
 * into a focused field.
 *
 * Run by `pnpm lint`, ahead of ESLint, which has no CSS support here.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Where the client's hand-written stylesheets live. `themes.css` is generated from the tokens. */
const STYLESHEET_ROOTS = ['packages/ui/src', 'apps/browser/src', 'apps/desktop/src'];
const GENERATED = new Set(['packages/ui/src/styles/themes.css']);

const LENGTH = /(?<![\w-])\d*\.?\d+(?:px|rem|pt)\b/iu;
/** An opt-out: `/* type-scale: <reason> *\/`, with a reason. */
const MARK = /\/\*\s*type-scale:\s*[^\s*][^]*?\*\//u;

/** The top-level space-separated tokens of a value, keeping `fn(...)` whole. */
function tokens(value) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (/\s/u.test(char) && depth === 0) {
      if (current) out.push(current);
      current = '';
    } else current += char;
  }
  if (current) out.push(current);
  return out;
}

/** Whether a size expression is a literal: a length with no token, or a `var()` that names no `--av-` token. */
function literalSize(size) {
  const names = [...size.matchAll(/var\(\s*(--[\w-]+)/gu)].map((match) => match[1]);
  if (names.some((name) => !name.startsWith('--av-'))) return true;
  // A literal beside a token in one expression, such as
  // `max(16px, var(--av-sys-type-body))`, is a floor on a role and passes.
  return names.length === 0 && LENGTH.test(size);
}

/**
 * The size in a `font` shorthand: the token before `/line-height`, or else the
 * first token that is a length or an expression, past the style and weight
 * keywords and any weight token. Null for a keyword such as `inherit`.
 */
function shorthandSize(value) {
  const slash = value.indexOf('/');
  if (slash >= 0) return tokens(value.slice(0, slash)).at(-1) ?? null;
  return tokens(value).find((token) => (LENGTH.test(token) || /^(?:var|calc|max|min|clamp)\(/iu.test(token)) && !/--av-sys-font-(?:family|weight)/u.test(token)) ?? null;
}

/**
 * The declarations in `css` that set a size from a literal: `font-size`, or
 * the size in a `font` shorthand, holding a length and no `--av-` token, or a
 * `var()` that names something other than a token. Returns
 * `{ line, declaration }` for each, one-based.
 *
 * A declaration opts out with the mark inside it or straight after its `;`,
 * and the mark covers that declaration only.
 */
export function typeLiterals(css) {
  // Comments other than marks become spaces, keeping offsets and line numbers.
  const code = css.replace(/\/\*[^]*?\*\//gu, (comment) => (MARK.test(comment) ? comment : comment.replace(/[^\n]/gu, ' ')));
  const found = [];
  for (const match of code.matchAll(/(?<![\w(-])(font-size|font)\s*:\s*([^;}]*)([;}]?)/giu)) {
    const [whole, property, raw, end] = match;
    const after = end === ';' ? code.slice(match.index + whole.length).match(/^[ \t]*(\/\*[^]*?\*\/)/u)?.[1] ?? '' : '';
    if (MARK.test(raw) || MARK.test(after)) continue;
    const value = raw.replace(/\/\*[^]*?\*\//gu, ' ').replace(/\s+/gu, ' ').trim();
    const size = property.toLowerCase() === 'font' ? shorthandSize(value) : value;
    if (size !== null && literalSize(size)) {
      found.push({ line: code.slice(0, match.index).split('\n').length, declaration: `${property}: ${value}` });
    }
  }
  return found;
}

function stylesheets(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return stylesheets(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

function main() {
  const failures = STYLESHEET_ROOTS
    .flatMap((directory) => stylesheets(join(root, directory)))
    .map((path) => relative(root, path))
    .filter((path) => !GENERATED.has(path))
    .flatMap((path) => typeLiterals(readFileSync(join(root, path), 'utf8')).map((hit) => ({ path, ...hit })));
  if (!failures.length) return;
  for (const { path, line, declaration } of failures) {
    process.stderr.write(`${path}:${line}  ${declaration}\n`);
  }
  process.stderr.write(
    `\n${failures.length} literal font size(s). Use a role, var(--av-sys-type-<role>), from config/design-tokens/base.json, `
      + 'or mark a size that is not reading text with /* type-scale: <reason> */. See docs/theming.md.\n',
  );
  process.exit(1);
}

if (isEntryPoint(import.meta.url)) {
  main();
}
