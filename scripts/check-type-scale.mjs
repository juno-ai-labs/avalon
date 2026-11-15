/**
 * Refuses a literal font size in the client's stylesheets.
 *
 * Every size names a role from the type scale (`var(--av-sys-type-body)`), or a
 * token built on one, so a density can move all of them together; one literal
 * is one size the phone's touch density silently leaves at its desktop value.
 * The scale and the densities are in `config/design-tokens/`; `docs/theming.md`
 * owns the reasoning.
 *
 * A declaration may opt out with a `/* type-scale: <reason> *\/` comment on its
 * line, for a size that is not reading text: a letter drawn inside a fixed
 * tile, or the 16px floor that stops iOS zooming into a focused field.
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

const LENGTH = /(?<![\w-])\d*\.?\d+(px|rem|pt)\b/u;
const ALLOW = /\/\*\s*type-scale:\s*\S/u;

/**
 * The declarations in `css` that set a size from a literal: `font-size`, or
 * the size in a `font` shorthand, holding a length and no `var()`.
 * Returns `{ line, declaration }` for each, one-based.
 */
export function typeLiterals(css) {
  const found = [];
  const lines = css.split('\n');
  lines.forEach((text, index) => {
    if (ALLOW.test(text)) return;
    const code = text.replace(/\/\*.*?\*\//gu, '');
    for (const match of code.matchAll(/(?<![\w-])(font-size|font)\s*:\s*([^;}]+)/gu)) {
      const value = match[2].trim();
      // The shorthand's size is the length before an optional `/line-height`;
      // a token in the line height does not excuse a literal size. A literal
      // beside a token in one expression, such as `max(16px, var(--av-sys-type-body))`,
      // is a floor on a role and passes.
      const size = match[1] === 'font' ? value.split('/')[0] : value;
      if (!size.includes('var(') && LENGTH.test(size)) found.push({ line: index + 1, declaration: `${match[1]}: ${value}` });
    }
  });
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
