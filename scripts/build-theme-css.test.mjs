import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  customProperty,
  generate,
  readTokenSources,
  selectorFor,
  stylesheetPath,
} from './build-theme-css.mjs';

const { registry, themes } = readTokenSources();

/**
 * The JSON is the source of truth and `themes.css` is its output.
 *
 * Without this the generated file is just a file: someone edits the CSS because
 * that is where the value appeared in a search, the JSON keeps saying something
 * else, and the next `pnpm tokens:build` silently reverts them. This runs in CI
 * through `pnpm test:scripts`.
 */
test('the committed stylesheet is what the token JSON produces', () => {
  assert.equal(
    readFileSync(stylesheetPath, 'utf8'),
    generate({ registry, themes }),
    'themes.css has drifted from config/design-tokens — run `pnpm tokens:build`',
  );
});

test('a token path becomes a namespaced custom property', () => {
  assert.equal(customProperty('sys.color.text.default'), '--av-sys-color-text-default');
  assert.equal(customProperty('ref.color.neutral.1'), '--av-ref-color-neutral-1');
  assert.equal(customProperty('cmp.sidebar.background-solid'), '--av-cmp-sidebar-background-solid');
});

// The dark theme is the default as well as a choice, so it is the block every
// other theme's omissions fall through to.
test('the dark theme is emitted as the document default', () => {
  assert.equal(selectorFor('dark'), ":root,\n[data-theme='dark']");
  assert.equal(selectorFor('airy'), "[data-theme='airy']");
});

test('every theme sets only tokens the registry declares', () => {
  for (const theme of themes) {
    const unknown = Object.keys(theme.tokens).filter((path) => !registry.tokens[path]);
    assert.deepEqual(unknown, [], `${theme.id} sets tokens that are not in the registry`);
  }
});

test('every alias points at a token that exists', () => {
  for (const theme of themes) {
    for (const [path, value] of Object.entries(theme.tokens)) {
      for (const [, reference] of JSON.stringify(value).matchAll(/\{([a-z0-9.-]+)\}/giu)) {
        assert.ok(
          registry.tokens[reference],
          `${theme.id}: ${path} aliases ${reference}, which no token declares`,
        );
      }
    }
  }
});

/**
 * An alias may not lead back to itself.
 *
 * Two tokens in the first cut did: a legacy name that aliased another collapsed
 * onto the same path during the taxonomy rename, and the alias overwrote the
 * literal it pointed at. `var(--x)` inside `--x` is not a CSS error — the
 * property resolves to nothing and every rule that uses it is dropped — so it
 * would have shown up as an unstyled interface rather than as a failure.
 */
test('no alias resolves to itself, directly or through a chain', () => {
  for (const theme of themes) {
    const referencesOf = (path) => [...JSON.stringify(theme.tokens[path] ?? '')
      .matchAll(/\{([a-z0-9.-]+)\}/giu)].map(([, reference]) => reference);

    for (const path of Object.keys(theme.tokens)) {
      const seen = new Set([path]);
      const queue = referencesOf(path);
      while (queue.length) {
        const next = queue.shift();
        assert.ok(next !== path, `${theme.id}: ${path} resolves back to itself`);
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(...referencesOf(next));
      }
    }
  }
});

test('every registry group explains at least one token', () => {
  const prefixes = Object.keys(registry.groups);
  for (const prefix of prefixes) {
    const covered = Object.keys(registry.tokens)
      .some((path) => path === prefix || path.startsWith(`${prefix}.`));
    assert.ok(covered, `no token sits under the group ${prefix}`);
  }
  for (const path of Object.keys(registry.tokens)) {
    const group = prefixes.find((prefix) => path === prefix || path.startsWith(`${prefix}.`));
    assert.ok(group, `${path} belongs to no group, so nothing explains it`);
  }
});

/**
 * A theme that omits a colour inherits the dark theme's, because the dark block
 * is also `:root`. That failure is silent and specific to the omitted token: a
 * light theme missing the tooltip's foreground draws near-black on near-black,
 * nothing else looks wrong, and nobody finds it until a person hovers something.
 *
 * Lengths, font stacks and aliases are deliberately inherited — they mean the
 * same thing whatever the theme — so only colours are required.
 */
test('every theme restates every colour the default theme names', () => {
  const dark = themes.find((theme) => theme.id === 'dark');
  const required = Object.keys(dark.tokens).filter((path) => {
    const value = dark.tokens[path];
    return registry.tokens[path].$type === 'color' && !String(value).startsWith('{');
  });

  assert.ok(required.length > 60, 'expected the default theme to name many colours');
  for (const theme of themes.filter((candidate) => candidate.id !== 'dark')) {
    const missing = required.filter((path) => !(path in theme.tokens));
    assert.deepEqual(missing, [], `${theme.id} inherits colours it should restate`);
  }
});

/**
 * Both ramps run from the faintest mark a theme can make on its own surface to
 * its strongest, ordered by *contrast* rather than by lightness — which is what
 * lets one rule name a step without knowing which way round the theme runs.
 */
test('both ramps are ordered by contrast in every theme', () => {
  const luminance = (hex) => {
    const value = hex.trim().replace('#', '');
    const channel = (offset) => Number.parseInt(value.slice(offset, offset + 2), 16);
    return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  };

  for (const [prefix, length] of [['ref.color.neutral', 14], ['ref.color.line', 6]]) {
    for (const theme of themes) {
      const steps = Array.from({ length }, (_, index) => theme.tokens[`${prefix}.${index + 1}`]);
      assert.ok(steps.every(Boolean), `${theme.id} declares every ${prefix} step`);

      const distances = steps.map((step) => Math.abs(luminance(step) - luminance(steps[0])));
      const ordered = distances.every((value, index) => index === 0 || value >= distances[index - 1]);
      assert.ok(ordered, `${theme.id} ${prefix} is not monotonic: ${distances.map(Math.round).join(', ')}`);
    }
  }
});

/**
 * A backdrop is declared the way a stylesheet would declare one.
 *
 * Sizing, centring, tiling and zoom are `background-size`, `background-position`
 * and `background-repeat` under their own names rather than a vocabulary
 * invented here, because every one of those already has an answer that a decade
 * of use has sanded smooth. What the theme file adds is the one step it cannot
 * write by hand: turning artwork into something a `url()` can carry.
 */
test('a backdrop is declared as CSS background longhands', () => {
  for (const longhand of ['color', 'image', 'position', 'size', 'repeat', 'attachment', 'blend-mode']) {
    assert.ok(
      registry.tokens[`sys.backdrop.${longhand}`],
      `sys.backdrop.${longhand} is missing, so a theme cannot set background-${longhand}`,
    );
  }
});

const asCss = (value) => {
  const fixture = {
    registry: {
      groups: { 'sys.backdrop': 'x' },
      tokens: { 'sys.backdrop.image': { $type: 'gradient' } },
    },
    themes: [{
      id: 'dark', name: 'D', description: 'd', appearance: 'dark',
      tokens: { 'sys.backdrop.image': value },
    }],
  };
  return generate(fixture).match(/--av-sys-backdrop-image: (.+);/u)[1];
};

test('an image layer may be a gradient, a fetched URL, or SVG drawn in the theme', () => {
  assert.equal(asCss({ gradient: 'radial-gradient(circle, #000, #fff)' }), 'radial-gradient(circle, #000, #fff)');
  assert.equal(asCss({ url: 'https://example.test/grain.png' }), 'url("https://example.test/grain.png")');
  assert.equal(
    asCss([{ gradient: 'linear-gradient(#000, #fff)' }, 'radial-gradient(#fff, #000)']),
    'linear-gradient(#000, #fff), radial-gradient(#fff, #000)',
    'an array is a layer stack, in CSS painting order',
  );
});

/**
 * Inline SVG becomes a data URI, which is a URL: the characters that end a
 * `url()` or that a strict parser rejects have to be escaped, and the artwork
 * has to declare the SVG namespace or the image silently fails to decode.
 */
test('inline SVG is percent-encoded into a data URI', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4">
    <circle cx="2" cy="2" r="1" fill="#e08c3a" opacity=".3" />
  </svg>`;
  const css = asCss({ svg });

  assert.match(css, /^url\("data:image\/svg\+xml,/u);
  assert.ok(!css.includes('<'), 'angle brackets are encoded, not left inside the url()');
  assert.ok(css.includes('%3Ccircle'), 'the artwork survives the encoding');
  assert.ok(css.includes("cx='2'"), 'double quotes become single ones so the url() can keep its own');
  assert.ok(css.includes('%23e08c3a'), 'a hash would otherwise start a URL fragment');
  assert.ok(!css.includes('\n'), 'whitespace is collapsed so the value stays one CSS token');
});

test('inline SVG without the namespace is rejected rather than shipped broken', () => {
  assert.throws(() => asCss({ svg: '<svg viewBox="0 0 4 4"><rect width="4" height="4"/></svg>' }), /xmlns/u);
});

/**
 * A data URI is its own document, so a custom property declared on `:root` is
 * not in scope inside it. Encoding the braces and moving on would draw the
 * artwork in its fallback colour under every theme.
 */
test('an alias inside inline SVG is rejected, because a data URI cannot read one', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="{sys.color.brand.base}"/></svg>';
  assert.throws(() => asCss({ svg }), /cannot read one/u);
});

test('a layer that names no known kind is rejected', () => {
  assert.throws(() => asCss({ picture: 'cat.png' }), /not svg, url or gradient/u);
});

/**
 * Every theme's block declares every token.
 *
 * A theme that leaves one out falls through to `:root`, which is the default
 * theme — and that works only for an element that has no `data-theme` of its
 * own. The Settings miniature has one: it draws the theme it is offering, not
 * the running one. An alias declared on `:root` is substituted there, so the
 * miniature would inherit the default theme's resolved colour no matter what
 * the ramp beneath it said, and the Light swatch would preview a dark surface.
 */
test('every theme block declares every token, so data-theme works on any element', () => {
  const css = readFileSync(stylesheetPath, 'utf8');
  const paths = Object.keys(registry.tokens);

  for (const theme of themes) {
    const block = css.slice(css.indexOf(selectorFor(theme.id)));
    const body = block.slice(0, block.indexOf('\n}'));
    const missing = paths.filter((path) => !body.includes(`${customProperty(path)}:`));

    assert.deepEqual(missing, [], `${theme.id} leaves tokens to fall through to :root`);
  }
});
