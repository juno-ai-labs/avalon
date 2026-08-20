#!/usr/bin/env node
/**
 * Generates the desktop renderer's `themes.css` from the design-token JSON.
 *
 * The JSON under `config/design-tokens/` is the source of truth: `registry.json`
 * says which tokens exist and what each one means, and one file per theme under
 * `themes/` supplies the values. This script is the only thing that writes
 * `themes.css`, and `pnpm tokens:check` fails if the committed CSS has drifted
 * from the JSON — so the two cannot disagree.
 *
 *   pnpm tokens:build    rewrite themes.css from the JSON
 *   pnpm tokens:check    fail if themes.css is not what the JSON produces
 *
 * A token path becomes a custom property by prefixing the namespace and
 * swapping dots for hyphens: `sys.color.text.default` is
 * `--av-sys-color-text-default`. A value of `{some.other.token}` becomes a
 * `var()` reference to that token, which is how a theme aliases rather than
 * repeats a value.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tokensDirectory = join(root, 'config', 'design-tokens');
const themesDirectory = join(tokensDirectory, 'themes');
export const stylesheetPath = join(
  root, 'apps', 'desktop', 'src', 'renderer', 'styles', 'themes.css',
);

/** The custom property a token path is written to. */
export function customProperty(path) {
  return `--av-${path.replace(/\./gu, '-')}`;
}

/** The selector a theme's block is written under. `dark` is also the default. */
export function selectorFor(id) {
  return id === 'dark' ? `:root,\n[data-theme='${id}']` : `[data-theme='${id}']`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readTokenSources() {
  const registry = readJson(join(tokensDirectory, 'registry.json'));
  const themes = readdirSync(themesDirectory)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => readJson(join(themesDirectory, entry)));
  // `dark` first: it is emitted as `:root` as well, so it has to be the block
  // every other theme's omissions fall through to.
  themes.sort((a, b) => (a.id === 'dark' ? -1 : b.id === 'dark' ? 1 : a.id.localeCompare(b.id)));
  return { registry, themes };
}

/**
 * The characters a `url()` in a stylesheet cannot carry unencoded, plus the ones
 * strict URL parsers reject. Everything else is left alone so artwork written in
 * a theme file is still readable in the generated CSS. The shortlist, and the
 * double-to-single quote swap that lets the `url()` keep double quotes, are
 * `mini-svg-data-uri`'s — settled there after a long tail of browser-specific
 * breakage that is not worth rediscovering.
 */
const URL_UNSAFE = /[%#<>?[\]^`{|}\\]/gu;

function svgDataUri(svg, theme, path) {
  if (!/\sxmlns\s*=\s*(['"])http:\/\/www\.w3\.org\/2000\/svg\1/u.test(svg)) {
    throw new Error(
      `${theme.id}: ${path} is inline SVG without xmlns="http://www.w3.org/2000/svg", `
      + 'which a data URI will not render',
    );
  }
  // A data URI is its own document, so a custom property declared on `:root`
  // is not in scope inside it. Without this the braces would just be encoded
  // and the artwork would draw in whatever colour it named as a fallback.
  if (/\{[a-z0-9.-]+\}/iu.test(svg)) {
    throw new Error(`${theme.id}: ${path} aliases a token inside inline SVG, which cannot read one`);
  }
  const encoded = svg
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/"/gu, "'")
    .replace(URL_UNSAFE, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `data:image/svg+xml,${encoded}`;
}

/**
 * One background layer. A theme names the kind of source it has rather than
 * assembling the CSS function itself, because `url()` around a data URI is the
 * one piece of this that has a wrong answer.
 */
function layerToCss(layer, theme, path) {
  if (layer === null || typeof layer !== 'object') return String(layer);
  const [kind, value] = Object.entries(layer)[0] ?? [];
  if (kind === 'svg') return `url("${svgDataUri(value, theme, path)}")`;
  if (kind === 'url') return `url("${value}")`;
  if (kind === 'gradient') return value;
  throw new Error(`${theme.id}: ${path} names ${kind ?? 'nothing'}, not svg, url or gradient`);
}

/**
 * A value becomes CSS: an array is a comma-separated layer stack, an object is
 * one layer, and `{a.b.c}` anywhere in the result is `var(--av-a-b-c)`.
 */
function resolveValue(value, registry, theme, path) {
  const css = Array.isArray(value)
    ? value.map((layer) => layerToCss(layer, theme, path)).join(', ')
    : layerToCss(value, theme, path);
  return css.replace(/\{([a-z0-9.-]+)\}/giu, (_match, reference) => {
    if (!registry.tokens[reference]) {
      throw new Error(`${theme.id}: ${path} references unknown token ${reference}`);
    }
    return `var(${customProperty(reference)})`;
  });
}

function wrapComment(text, indent = '  ') {
  const words = text.split(/\s+/u);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && `${line} ${word}`.length > 74) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.length === 1
    ? `${indent}/* ${lines[0]} */`
    : [`${indent}/* ${lines[0]}`, ...lines.slice(1).map((rest) => `${indent} * ${rest}`)]
        .join('\n') + ' */';
}

function groupOf(path, groups) {
  return Object.keys(groups)
    .sort((a, b) => b.length - a.length)
    .find((prefix) => path === prefix || path.startsWith(`${prefix}.`));
}

export function generate({ registry, themes }) {
  const order = Object.keys(registry.tokens);
  // Every block declares every token, including the ones a theme was content to
  // inherit. Falling through to `:root` works only while `data-theme` is on the
  // document: an alias declared on `:root` — `--av-cmp-pane-background:
  // var(--av-sys-color-surface-default)` — is substituted where it is declared,
  // so a nested element carrying a different `data-theme` inherits the *default*
  // theme's resolved colour and redeclaring the ramp beneath it changes nothing.
  // The Settings miniature is exactly that element. Filling the blocks out here
  // costs a few kilobytes and makes `data-theme` mean the same thing anywhere in
  // the tree.
  const inherited = themes.find((theme) => theme.id === 'dark')?.tokens ?? {};
  const blocks = themes.map((theme) => {
    const values = { ...inherited, ...theme.tokens };
    const lines = [];
    let lastGroup = null;
    for (const path of order) {
      if (!(path in values)) continue;
      const group = groupOf(path, registry.groups);
      if (group !== lastGroup) {
        if (lines.length) lines.push('');
        // Only the default theme carries the prose. Repeating it under every
        // theme would triple the file and put three copies of one explanation
        // where a reader has to check whether they still agree.
        if (theme.id === 'dark') lines.push(wrapComment(registry.groups[group]));
        lastGroup = group;
      }
      lines.push(`  ${customProperty(path)}: ${resolveValue(values[path], registry, theme, path)};`);
    }
    return [
      `/* ${theme.name} — ${theme.description} */`,
      `${selectorFor(theme.id)} {`,
      `  color-scheme: ${theme.appearance};`,
      '',
      ...lines,
      '}',
    ].join('\n');
  });

  return [
    '/*',
    ' * GENERATED FILE — do not edit.',
    ' *',
    ' * Written by `scripts/build-theme-css.mjs` from the design-token JSON under',
    ' * `config/design-tokens/`. Edit a theme there and run `pnpm tokens:build`;',
    ' * `pnpm tokens:check` fails if this file and that JSON disagree.',
    ' *',
    ' * See `docs/theming.md` for the token taxonomy and what each tier means.',
    ' */',
    '',
    ...blocks,
    '',
  ].join('\n');
}

function main() {
  const sources = readTokenSources();
  const css = generate(sources);
  if (process.argv.includes('--check')) {
    const committed = readFileSync(stylesheetPath, 'utf8');
    if (committed !== css) {
      process.stderr.write(
        'themes.css does not match the design-token JSON.\n'
        + 'Run `pnpm tokens:build` and commit the result.\n',
      );
      process.exit(1);
    }
    process.stdout.write(`themes.css matches the JSON (${Object.keys(sources.registry.tokens).length} tokens).\n`);
    return;
  }
  writeFileSync(stylesheetPath, css);
  process.stdout.write(
    `Wrote themes.css from ${sources.themes.length} themes `
    + `(${Object.keys(sources.registry.tokens).length} tokens).\n`,
  );
}

if (isEntryPoint(import.meta.url)) {
  main();
}
