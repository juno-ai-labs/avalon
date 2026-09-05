import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  assetManifest,
  defaultTheme,
  customProperty,
  fontCacheId,
  fontFaces,
  generate,
  outputs,
  readTokenSources,
  resolvedTokens,
  selectorFor,
  stylesheetPath,
} from './build-theme-assets.mjs';

const { registry, themes } = readTokenSources();

/**
 * The JSON is the source of truth and `themes.css` is its output.
 *
 * Without this the generated file is just a file: someone edits the CSS because
 * that is where the value appeared in a search, the JSON keeps saying something
 * else, and the next `pnpm tokens:build` silently reverts them. This runs in CI
 * through `pnpm test:scripts`.
 */
test('every committed artefact is what the token JSON produces', () => {
  for (const { path, contents } of outputs({ registry, themes })) {
    assert.equal(
      readFileSync(path, 'utf8'),
      contents,
      `${path} has drifted from config/design-tokens — run \`pnpm tokens:build\``,
    );
  }
});

test('a token path becomes a namespaced custom property', () => {
  assert.equal(customProperty('sys.color.text.default'), '--av-sys-color-text-default');
  assert.equal(customProperty('ref.color.neutral.1'), '--av-ref-color-neutral-1');
  assert.equal(customProperty('cmp.sidebar.background-solid'), '--av-cmp-sidebar-background-solid');
});

/**
  * Exactly one theme is also `:root`, and it says so itself.
  *
  * The generator used to know that theme by name, which is one more thing a
  * rename has to remember — and when `dark` became `neu` it did not.
  */
test('one theme declares itself the default, and is emitted as :root', () => {
  const base = defaultTheme(themes);

  assert.equal(selectorFor(base.id, themes), `:root,\n[data-theme='${base.id}']`);
  for (const theme of themes.filter((candidate) => candidate.id !== base.id)) {
    assert.equal(selectorFor(theme.id, themes), `[data-theme='${theme.id}']`);
  }
  assert.throws(() => defaultTheme(themes.map((theme) => ({ ...theme, default: false }))), /exactly one/u);
  assert.throws(() => defaultTheme(themes.map((theme) => ({ ...theme, default: true }))), /exactly one/u);
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
  const base = defaultTheme(themes);
  const required = Object.keys(base.tokens).filter((path) => {
    const value = base.tokens[path];
    return registry.tokens[path].$type === 'color' && !String(value).startsWith('{');
  });

  assert.ok(required.length > 60, 'expected the default theme to name many colours');
  for (const theme of themes.filter((candidate) => candidate.id !== defaultTheme(themes).id)) {
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
      id: 'base', name: 'D', description: 'd', appearance: 'dark', default: true,
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

/**
 * Named custom families must ship a face; otherwise weights resolve against an
 * accidental substitute. Platform UI families are deliberately OS-provided:
 * bundling a replacement would undo the native typography used by portals and
 * secondary windows. Keep the exception narrow, not a pass for any unknown font.
 */
test('every custom family a theme names is a face the build emits', () => {
  const css = generate({ registry, themes });
  const declared = new Set(fontFaces(themes).map((font) => font.family));

  assert.ok(declared.size > 0, 'no theme declares a font');
  for (const theme of themes) {
    for (const path of ['sys.font.family.ui', 'sys.font.family.mono']) {
      const value = resolvedTokens(theme, themes)[path];
      if (String(value).startsWith('{')) continue;
      const first = String(value).split(',')[0].replace(/["']/gu, '').trim();
      assert.ok(
        declared.has(first) || ['-apple-system', 'system-ui', 'ui-sans-serif', 'ui-monospace'].includes(first),
        `${theme.id}: ${path} leads with ${first}, which no font source provides`,
      );
    }
  }
  for (const font of fontFaces(themes)) {
    assert.match(css, new RegExp(`font-family: '${font.family}';`, 'u'));
  }
  assert.match(css, /font-display: block;/u, 'a bundled face should block rather than swap');
});

test('a bundled face points at the file that ships, and a remote one never does', () => {
  const bundled = { family: 'Geist', src: { bundled: 'geist-latin-variable.woff2' } };
  const remote = { family: 'Far', src: { url: 'https://fonts.example/far.woff2' } };
  const css = generate({
    registry: { groups: { 'sys.font': 'x' }, tokens: { 'sys.font.family.ui': { $type: 'fontFamily' } } },
    themes: [{
      id: 'base', name: 'D', description: 'd', appearance: 'dark', default: true,
      fonts: [bundled, remote], tokens: { 'sys.font.family.ui': 'Geist' },
    }],
  });

  assert.match(css, /src: url\('\.\.\/fonts\/geist-latin-variable\.woff2'\) format\('woff2'\);/u);
  // The renderer asking the remote host directly would announce the reader to
  // whoever runs it, on every cold start, for as long as the theme is in use.
  assert.ok(!css.includes('https://fonts.example'), 'a remote URL reached the stylesheet');
  assert.match(css, new RegExp(`url\\('rally-font://cache/${fontCacheId(remote.src.url)}\\.woff2'\\)`, 'u'));
});

test('a bundled font that is not in the repository fails the build', () => {
  assert.throws(() => generate({
    registry: { groups: { 'sys.font': 'x' }, tokens: { 'sys.font.family.ui': { $type: 'fontFamily' } } },
    themes: [{
      id: 'base', name: 'D', description: 'd', appearance: 'dark', default: true,
      fonts: [{ family: 'Ghost', src: { bundled: 'ghost.woff2' } }],
      tokens: { 'sys.font.family.ui': 'Ghost' },
    }],
  }), /which is not in apps\/desktop\/src\/renderer\/fonts/u);
});

test('the main process is told where to fetch a remote font from', () => {
  const remote = { family: 'Far', src: { url: 'https://fonts.example/far.woff2', integrity: 'sha256-AAAA' } };
  const manifest = assetManifest([{
    id: 'base', name: 'D', description: 'd', appearance: 'dark', default: true, fonts: [remote], tokens: {},
  }]);

  assert.match(manifest, new RegExp(`'${fontCacheId(remote.src.url)}': \\{`, 'u'));
  assert.match(manifest, /url: 'https:\/\/fonts\.example\/far\.woff2'/u);
  assert.match(manifest, /integrity: 'sha256-AAAA'/u);
});

/**
 * A heading is larger than the prose it sits above.
 *
 * `.markdown-body` takes its own size from `sys.font.size.prose`, and the
 * headings inside it were a fixed 18/16/14.5/14 — so when Air raised its prose
 * to 16.5px its h2 became *smaller* than the paragraph beneath it and its h3
 * smaller still. Colour was tokenised from the start and size was not, which is
 * exactly the gap the no-literal-colour guard cannot see.
 */
test('every theme keeps its markdown headings above its prose', () => {
  const px = (value) => Number.parseFloat(String(value));

  for (const theme of themes) {
    const values = resolvedTokens(theme, themes);
    const prose = px(values['sys.font.size.prose']);
    const headings = [1, 2, 3, 4].map((level) => px(values[`cmp.markdown.heading-${level}`]));

    assert.ok(headings.every(Number.isFinite), `${theme.id} leaves a markdown heading size unset`);
    for (const [index, size] of headings.entries()) {
      // `>=`, not `>`: a level that matches the prose and is carried by weight
      // alone is a design decision. One *below* it is not — that is a heading
      // the eye reads as a caption.
      assert.ok(
        size >= prose,
        `${theme.id}: h${index + 1} is ${size}px under ${prose}px prose — a heading that does not read as one`,
      );
    }
    // And they descend, or the levels say nothing about depth.
    const descending = headings.every((size, index) => index === 0 || size <= headings[index - 1]);
    assert.ok(descending, `${theme.id}: markdown heading sizes are not in descending order`);

    // The note detail runs its own scale, and h4 and below fall back to the
    // shared one — so an article scale that stops descending too early inverts
    // the hierarchy rather than merely flattening it.
    const article = [1, 2, 3].map((level) => px(values[`cmp.markdown.article-heading-${level}`]));
    assert.ok(article.every(Number.isFinite), `${theme.id} leaves an article heading size unset`);
    assert.ok(
      article.every((size, index) => (index === 0 || size <= article[index - 1]) && size >= prose),
      `${theme.id}: the note article's heading scale does not descend above its prose`,
    );
  }
});

/**
 * A composer is a card or a rule, and either way its top edge is `rule-color`.
 *
 * `app.css` writes `border-top` from that token unconditionally — the renderer
 * suite anchors that declaration — so the token is not a rule theme's opt-in.
 * A retired palette read it as one, set it to `transparent`, and shipped a card with three
 * sides: the work-stream composer was open along the top while the launch
 * screen, which writes its own card, was closed. Nothing else sees this. The
 * generated CSS is valid, every token resolves, and the missing edge is one
 * hairline on one screen.
 *
 * Read through `resolvedTokens` rather than the appearance JSON, because an
 * appearance inherits whatever it was content not to restate.
 */
test('a card composer states its top edge as its frame, and a rule keeps a visible one', () => {
  for (const theme of themes) {
    const values = resolvedTokens(theme, themes);
    const token = (name) => values[`cmp.composer.${name}`];
    // `0`, `0px`, `0rem` — a zeroed width is the rule shape however it is spelt.
    const rule = /^0(?:[a-z%]+)?$/u.test(String(token('border-width')));

    if (rule) {
      // The hairline is the whole shape, and `rule-color-focus` is the only
      // thing left saying the field is live once the frame is gone. Either one
      // going transparent leaves a composer with no edge at all, which is the
      // card's missing top read from the other side.
      assert.equal(token('border-color'), 'transparent', `${theme.id} zeroes its composer border but keeps a colour on it`);
      assert.equal(token('border-color-focus'), 'transparent', `${theme.id} draws a focus-only frame on a rule composer`);
      assert.notEqual(token('rule-color'), 'transparent', `${theme.id} is a rule composer with no rule`);
      assert.notEqual(token('rule-color-focus'), 'transparent', `${theme.id} leaves a rule composer with no focus signal`);
      continue;
    }

    assert.equal(
      token('rule-color'),
      token('border-color'),
      `${theme.id}'s card composer draws its top edge from something other than its frame`,
    );
    assert.equal(
      token('rule-color-focus'),
      token('border-color-focus'),
      `${theme.id}'s card composer keeps a different top edge on focus`,
    );
  }
});
