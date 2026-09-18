#!/usr/bin/env node
/**
 * Generates every build artefact a theme has, from the design-token JSON.
 *
 * The JSON under `config/design-tokens/` is the source of truth: `registry.json`
 * says which tokens exist and what each one means, and one file per theme under
 * `themes/` supplies the values and font faces it needs. This script is the only thing that writes any of the files
 * below, and `pnpm tokens:check` fails if a committed one has drifted, so the
 * JSON and the build cannot disagree.
 *
 *   pnpm tokens:build    rewrite every artefact from the JSON
 *   pnpm tokens:check    fail if an artefact is not what the JSON produces
 *
 * | Artefact | What reads it |
 * | --- | --- |
 * | `packages/ui/src/styles/themes.css` | The renderer: `@font-face` rules and one custom-property block per theme. |
 * | `common/theme-assets.ts` | The cached remote-font manifest and fixed export syntax palette. |
 *
 * A token path becomes a custom property by prefixing the namespace and
 * swapping dots for hyphens: `sys.color.text.default` is
 * `--av-sys-color-text-default`. A value of `{some.other.token}` becomes a
 * `var()` reference to that token, which is how a theme aliases rather than
 * repeats a value.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tokensDirectory = join(root, 'config', 'design-tokens');
const themesDirectory = join(tokensDirectory, 'themes');
const desktopSource = join(root, 'apps', 'desktop', 'src');
const sharedUiSource = join(root, 'packages', 'ui', 'src');
export const stylesheetPath = join(sharedUiSource, 'styles', 'themes.css');
export const manifestPath = join(desktopSource, 'common', 'theme-assets.ts');
/** Where a `bundled` font source resolves to, and what `themes.css` points at. */
export const fontsDirectory = join(sharedUiSource, 'fonts');
const fontsHrefPrefix = '../fonts/';

/** The custom property a token path is written to. */
export function customProperty(path) {
  return `--av-${path.replace(/\./gu, '-')}`;
}

/**
 * The selector a theme's block is written under.
 *
 * The default theme is emitted as `:root` as well, so it is what an element
 * carrying no `data-theme` gets. Which theme that is comes from the JSON — a
 * generator that knew one by name would have to be edited every time a theme is
 * renamed, which is exactly what happened when `dark` became `neu`.
 */
export function selectorFor(id, themes = []) {
  const isDefault = themes.some((theme) => theme.id === id && theme.default);
  return isDefault ? `:root,\n[data-theme='${id}']` : `[data-theme='${id}']`;
}

/** The theme every other theme's omissions fall through to. */
export function defaultTheme(themes) {
  const found = themes.filter((theme) => theme.default);
  if (found.length !== 1) {
    throw new Error(`expected exactly one theme to set "default": true, found ${found.length}`);
  }
  return found[0];
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readTokenSources() {
  const registry = readJson(join(tokensDirectory, 'registry.json'));
  // What does not change with the appearance. Merged under every appearance
  // at build time rather than emitted once on `:root`: an alias declared on
  // `:root` is substituted there, so a base token that pointed at an
  // appearance token would freeze the default appearance's value under a
  // nested `data-theme`. Keeping the split in the sources and the merge in the
  // output means the stylesheet keeps its one shape, every block whole.
  const base = readJson(join(tokensDirectory, 'base.json'));
  const themes = readdirSync(themesDirectory)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => readJson(join(themesDirectory, entry)));
  // The default theme first: it is emitted as `:root` as well, so it has to be
  // the block every other theme's omissions fall through to.
  themes.sort((a, b) => (a.default ? -1 : b.default ? 1 : a.id.localeCompare(b.id)));
  return { registry, base, themes };
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

/**
 * The cache id a remote font file is stored and served under.
 *
 * Content-addressed by its URL rather than by the bytes, because the id has to
 * be computable at build time — `themes.css` names it before anything has been
 * fetched. A font file at a URL is immutable in practice; a theme that wants
 * different bytes changes the URL, which changes the id, which misses the cache.
 */
export function fontCacheId(url) {
  return createHash('sha256').update(url).digest('hex').slice(0, 32);
}

/**
 * Every font face across every theme, deduplicated.
 *
 * Emitted once for all themes rather than per theme: `@font-face` costs nothing
 * until something uses the family, and declaring them together means switching a
 * theme never waits on a font that a stylesheet has only just introduced.
 */
export function fontFaces(themes) {
  const seen = new Map();
  for (const theme of themes) {
    for (const font of theme.fonts ?? []) {
      const key = JSON.stringify([font.family, font.style ?? 'normal', font.weight ?? '400', font.src]);
      if (!seen.has(key)) seen.set(key, font);
    }
  }
  return [...seen.values()];
}

function fontHref(font, theme) {
  if (font.src.bundled) {
    const file = join(fontsDirectory, font.src.bundled);
    if (!existsSync(file)) {
      throw new Error(
        `${theme}: ${font.family} names the bundled font ${font.src.bundled}, `
        + 'which is not in packages/ui/src/fonts',
      );
    }
    return `${fontsHrefPrefix}${font.src.bundled}`;
  }
  // Never the remote URL. The renderer asking `fonts.example.com` for a file
  // announces the reader to whoever runs it, on every cold start, for as long as
  // the theme is in use. The main process fetches it once instead and serves the
  // bytes back from here.
  return `${FONT_SCHEME}://cache/${fontCacheId(font.src.url)}.woff2`;
}

function fontFaceRule(font, theme) {
  const lines = [
    `  font-family: '${font.family}';`,
    `  font-style: ${font.style ?? 'normal'};`,
    `  font-weight: ${font.weight ?? '400'};`,
    `  font-display: ${font.display ?? (font.src.bundled ? 'block' : 'swap')};`,
    `  src: url('${fontHref(font, theme)}') format('woff2');`,
  ];
  if (font.unicodeRange) lines.push(`  unicode-range: ${font.unicodeRange};`);
  return ['@font-face {', ...lines, '}'].join('\n');
}

/** The scheme the main process serves cached remote font files from. */
export const FONT_SCHEME = 'rally-font';

/**
 * What the application needs to know about appearance assets that are not CSS
 * values. Generated rather than parsed from design-token files at runtime.
 */
export function assetManifest(themes, base) {
  const syntax = exportSyntaxPalette(themes, base);
  const remote = fontFaces(themes).filter((font) => font.src.url);

  const entries = remote.map((font) => [
    `  '${fontCacheId(font.src.url)}': {`,
    `    url: '${font.src.url}',`,
    ...(font.src.integrity ? [`    integrity: '${font.src.integrity}',`] : []),
    '  },',
  ].join('\n'));

  return [
    '/*',
    ' * GENERATED FILE — do not edit.',
    ' *',
    ' * Written by `scripts/build-theme-assets.mjs` from the design-token JSON',
    ' * under `config/design-tokens/`. Run `pnpm tokens:build` after editing a',
    ' * theme; `pnpm tokens:check` fails if this file and that JSON disagree.',
    ' */',
    '',
    '/** The scheme cached remote font files are served from. */',
    `export const fontScheme = '${FONT_SCHEME}';`,
    '',
    '/**',
    ' * Remote font files, by the cache id `themes.css` asks for. The main process',
    ' * fetches a miss once and keeps it; `integrity`, when a theme declares it, is',
    ' * checked before the bytes are allowed into the cache.',
    ' */',
    'export const cachedFonts: Record<string, { url: string; integrity?: string }> = {',
    ...entries,
    '};',
    '',
    '/**',
    ' * The syntax colours a document *outside* the application has to declare for',
    ' * itself.',
    ' *',
    ' * `MarkdownBody` colours highlighted code with `var(--av-sys-color-syntax-*)`',
    ' * in inline styles, which resolve against the cascade — everywhere except the',
    ' * one place that markup is re-hosted. The message exporter serializes it into',
    ' * a standalone document that loads no stylesheet of ours, where every one of',
    ' * those references is invalid at computed-value time and `color` falls back',
    ' * to the inherited near-black, on a near-black code block.',
    ' *',
    ' * These are the dark appearance\'s values because the exported card is',
    ' * deliberately not themed: a fixed light sheet with a fixed dark code block,',
    ' * so that a saved file looks the same whoever saved it. Generated rather than',
    ' * copied so the two cannot drift.',
    ' */',
    'export const exportSyntaxPalette: Record<string, string> = {',
    ...syntax,
    '};',
    '',
  ].join('\n');
}

/**
 * The dark appearance's syntax tokens, fully resolved.
 *
 * An alias would be meaningless in a document that declares none of the ramp it
 * points at, so anything still shaped like `{ref.…}` is followed here rather
 * than emitted.
 */
export function exportSyntaxPalette(themes, base) {
  const darkAppearances = themes.filter((theme) => theme.appearance === 'dark');
  if (darkAppearances.length !== 1) {
    throw new Error(`expected exactly one dark appearance, found ${darkAppearances.length}`);
  }
  const theme = darkAppearances[0];
  const values = resolvedTokens(theme, base);
  return Object.keys(values)
    .filter((path) => path.startsWith('sys.color.syntax.'))
    .map((path) => {
      let value = values[path];
      const seen = new Set();
      while (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
        const target = value.slice(1, -1);
        if (seen.has(target)) throw new Error(`${theme.id}: ${path} aliases in a cycle`);
        seen.add(target);
        if (!(target in values)) throw new Error(`${theme.id}: ${path} aliases ${target}, which no theme sets`);
        value = values[target];
      }
      return `  '${customProperty(path)}': '${value}',`;
    });
}

export function generate({ registry, base, themes }) {
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
  const blocks = themes.map((theme) => {
    const values = resolvedTokens(theme, base);
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
        if (theme.default) lines.push(wrapComment(registry.groups[group]));
        lastGroup = group;
      }
      lines.push(`  ${customProperty(path)}: ${resolveValue(values[path], registry, theme, path)};`);
    }
    return [
      `/* ${theme.name} — ${theme.description} */`,
      `${selectorFor(theme.id, themes)} {`,
      `  color-scheme: ${theme.appearance};`,
      '',
      ...lines,
      '}',
    ].join('\n');
  });

  const faces = fontFaces(themes).map((font) => fontFaceRule(font, 'themes'));

  return [
    '/*',
    ' * GENERATED FILE — do not edit.',
    ' *',
    ' * Written by `scripts/build-theme-assets.mjs` from the design-token JSON',
    ' * under `config/design-tokens/`. Edit a theme there and run',
    ' * `pnpm tokens:build`; `pnpm tokens:check` fails if the two disagree.',
    ' *',
    ' * See `docs/theming.md` for the token taxonomy and what each tier means.',
    ' */',
    '',
    ...(faces.length ? [...faces, ''] : []),
    ...blocks,
    '',
  ].join('\n');
}

/**
 * A theme's tokens with the base tokens under them.
 *
 * Nothing falls through to the default appearance: every appearance sets the
 * same keys (`build-theme-assets.test.mjs` holds that line), so a value
 * missing here is a defect in the file rather than something to fill from
 * light. The base is merged under each appearance rather than emitted once on
 * `:root` because an alias declared on `:root` is substituted where it is
 * declared, so a nested element carrying a different `data-theme` would inherit
 * the default theme's already resolved colour and redeclaring the ramp beneath
 * it would change nothing. The Settings miniatures are exactly that element.
 */
export function resolvedTokens(theme, base) {
  if (!base?.tokens) throw new Error('resolvedTokens needs the base token file: without it every base token is missing from the output');
  return { ...base.tokens, ...theme.tokens };
}

/**
 * Every file the JSON produces, as `{ path, contents }`.
 *
 * One list so that writing them and checking them for drift are the same
 * traversal. An artefact that is generated but not listed here is one nothing
 * checks, which over a few months is an artefact that no longer matches its
 * source.
 */
export function outputs(sources) {
  return [
    { path: stylesheetPath, contents: generate(sources) },
    { path: manifestPath, contents: assetManifest(sources.themes, sources.base) },
  ];
}

function main() {
  const sources = readTokenSources();
  const files = outputs(sources);
  const tokens = Object.keys(sources.registry.tokens).length;

  if (process.argv.includes('--check')) {
    const stale = files.filter(({ path, contents }) => {
      try {
        return readFileSync(path, 'utf8') !== contents;
      } catch {
        return true;
      }
    });
    if (stale.length) {
      for (const { path } of stale) process.stderr.write(`stale: ${path}\n`);
      process.stderr.write('Run `pnpm tokens:build` and commit the result.\n');
      process.exit(1);
    }
    process.stdout.write(`${files.length} theme artefacts match the JSON (${tokens} tokens).\n`);
    return;
  }

  for (const { path, contents } of files) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  process.stdout.write(
    `Wrote ${files.length} artefacts from ${sources.themes.length} themes (${tokens} tokens).\n`,
  );
}

if (isEntryPoint(import.meta.url)) {
  main();
}
