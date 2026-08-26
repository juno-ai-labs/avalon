import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Read from disk rather than imported: Vite hands `?raw` an empty string for a
// file it is already processing as CSS, and `import.meta.url` is an http URL
// under jsdom. This file is named `.node.test.ts` and typed by
// `tsconfig.node.json` so that `node:fs` stays out of the renderer program.
const stylesheet = readFileSync(resolve(process.cwd(), 'src/renderer/styles/app.css'), 'utf8');

/** The declarations inside one rule, or null when the selector is absent. */
function rule(selector: string): string | null {
  const start = stylesheet.indexOf(`\n${selector} {`);
  if (start === -1) return null;
  const open = stylesheet.indexOf('{', start);
  const close = stylesheet.indexOf('}', open);
  return stylesheet.slice(open + 1, close);
}

/**
 * Every rule's selector prelude, with comments removed.
 *
 * Splitting on `}` and taking the text before the *last* `{` in each piece
 * keeps the inner selector of a nested rule rather than the `@media` that
 * encloses it. Comments go first so that prose naming a selector — this
 * stylesheet's comments name several — is not mistaken for the rule itself.
 */
function preludes(): string[] {
  return stylesheet
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .split('}')
    .map((block) => (block.includes('{') ? (block.split('{').at(-2) ?? '') : ''))
    .map((prelude) => prelude.trim())
    .filter(Boolean);
}

/**
 * The bare element names a selector targets — `ul` in `:is(.a, .b) > ul`, and
 * nothing from `.contains-task-list`, `:first-child`, or `[data-expanded]`.
 * An element name is an identifier introduced by a combinator, a comma, an
 * opening parenthesis, or whitespace; every other position belongs to a class,
 * id, pseudo, attribute, or the tail of a hyphenated name.
 */
function elementsIn(prelude: string): string[] {
  return [...prelude.matchAll(/(?:^|[\s>+~,(])([a-z][a-z0-9]*)\b/gu)].flatMap((match) => match[1] ?? []);
}

/**
 * The launch surface is styled by inheriting the work-stream screen's own rules
 * rather than repeating them, so that a change to the destination reaches the
 * surface that is about to become it. Nothing in a component test can see that:
 * both states render the same DOM, and the drift only shows up as a jump on a
 * real screen, months later, in whichever change restyled the destination.
 */
describe('work-stream launch surface geometry', () => {
  // The header is the exception, and the only one. A grid track sized `auto`
  // cannot be animated, so the launching header states its own height as the
  // endpoint the animation grows to — which has to be the destination's row.
  it('grows its header to exactly the work-stream header row', () => {
    const launching = rule('.workstream-launch-screen.is-launching > .launch-header');
    const destinationRows = rule('.workstream-screen');

    expect(launching).toContain('height: 55px;');
    expect(destinationRows).toContain('grid-template-rows: 55px minmax(0, 1fr) auto;');
  });

  // Everything else is inherited, so the launching state must state none of it.
  // A rule written against `.is-launching` wins over the destination's — which
  // is how a copy of today's dock geometry would silently outlive it.
  it.each([
    ['.workstream-launch-screen.is-launching > .launch-dock', ['padding', 'background']],
    ['.workstream-launch-screen.is-launching .composer-stack', ['max-width']],
    ['.workstream-launch-screen.is-launching .launch-composer', ['background', 'border-color', 'border-radius']],
  ])('states no geometry of its own in %s', (selector, forbidden) => {
    const declarations = rule(selector);
    if (declarations === null) return;
    for (const property of forbidden) {
      expect(declarations).not.toContain(`${property}:`);
    }
  });

  // The hand-off keeps the home content mounted for exactly as long as the
  // stylesheet spends fading it, and the two are declared in different files.
  it('fades the home content over the span the screen keeps it mounted for', () => {
    expect(rule('.launch-home-layer.is-leaving')).toContain('animation: launch-home-leave 190ms');
  });
});

describe('member picker controls', () => {
  it('keeps the custom checkbox out of the flexible member-copy rule', () => {
    const copy = rule(
      '.member-picker-row > span:not(.avatar):not(.member-checkbox),\n.member-action-list button > span:not(.avatar)',
    );

    expect(copy).toContain('flex: 1;');
    expect(rule('.member-checkbox')).toContain('flex: 0 0 16px;');
  });

  it('mirrors focus from the transparent native input onto the visible checkbox', () => {
    expect(rule('.member-picker-row:has(input:focus-visible) .member-checkbox'))
      .toContain('outline: 2px solid var(--av-sys-color-focus-quiet);');
  });
});

describe('work-stream participant presence', () => {
  it('draws a tokenized sonar ring and preserves a static reduced-motion state', () => {
    const ping = rule('.avatar-presence-ping');
    expect(ping).toContain('animation: avatar-presence-ping 2.2s ease-out infinite;');
    expect(ping).toContain('var(--av-sys-color-success-base)');
    expect(stylesheet).toContain('@media (prefers-reduced-motion: reduce)');
    expect(stylesheet).toContain('animation: none;');
  });
});

/**
 * The five-line cap on a system row exists only here. `SystemMessageBlock`
 * renders the whole string and sets one attribute; the clamp, and therefore the
 * feature, is the stylesheet. A component test cannot see it — jsdom lays
 * nothing out, so the height stubs those tests rely on describe this rule
 * rather than check it, and deleting it would leave every test green while the
 * app laid out a digest brief in full with a decorative "more" beside it.
 */
describe('system message clamp', () => {
  it('clamps a closed system row to the line count the row declares', () => {
    expect(rule('.system-message')).toContain('--system-message-lines: 5;');

    const closed = rule('.system-message-text:not([data-expanded])');
    expect(closed).toContain('display: -webkit-box;');
    expect(closed).toContain('-webkit-line-clamp: var(--system-message-lines);');
    expect(closed).toContain('overflow: hidden;');
  });

  // A line count is only a useful measure of a row if the row's own newlines
  // survive. These messages are written with structure — an inbound email leads
  // with an untrusted-content warning, then the sender, then the subject, each
  // on its own line — and under the inherited `white-space: normal` all of it
  // collapsed onto two wrapped lines. That is short enough never to reach the
  // clamp, so the row this feature most exists for was the one it skipped.
  it('keeps the newlines a system message was written with', () => {
    expect(rule('.system-message-text')).toContain('white-space: pre-wrap;');
  });

  // The open row is bounded too. Without a ceiling, opening a 120,000-character
  // run prompt restores the wall of text the clamp exists to remove, and puts
  // the control that closes it a screen or more below the reader's pointer.
  it('bounds an open system row instead of letting it run', () => {
    const open = rule('.system-message-text[data-expanded]');
    expect(open).toContain('max-height: 320px;');
    expect(open).toContain('overflow-y: auto;');
  });
});

describe('attachment lightbox', () => {
  it('keeps plain attachment text visibly monospace', () => {
    expect(rule('.attachment-lightbox-text')).toContain(
      'font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;',
    );
  });
});

/**
 * Markdown list markers are drawn by the browser, which makes them exactly the
 * kind of thing a global reset can remove without any test noticing: the DOM is
 * unchanged, the list is still a list, and every assertion about its items
 * still passes. Tailwind's preflight — pulled in by `@tailwind base` at the top
 * of this stylesheet — sets `list-style: none` on every `ol` and `ul`, and for
 * as long as nothing here took it back, bulleted lists rendered as indented
 * paragraphs and numbered ones lost their numbers on every markdown surface in
 * the app.
 */
describe('markdown list markers', () => {
  // One container, because there is one renderer. These assertions briefly named
  // three: a note and a meeting briefing rendered `ReactMarkdown` under a class
  // of their own, so every marker rule had to list all three or leave those two
  // surfaces on the preflight's `none`. Both host `MarkdownBody` now, which is
  // what makes naming `.markdown-body` alone a convergence rather than the
  // oversight it would have been a change ago.

  // `rule()` returns the *first* block whose selector line matches, so a
  // selector that appears twice in the stylesheet resolves to whichever copy is
  // higher up. These marker rules each appear once, and the geometry group below
  // them is matched by its own two-line selector — keep it that way, because
  // merging the two would silently point these assertions at the margins.

  it.each([
    ['.markdown-body ul', 'disc'],
    ['.markdown-body :is(ul, ol) ul', 'circle'],
    ['.markdown-body :is(ul, ol) :is(ul, ol) ul', 'square'],
    ['.markdown-body ol', 'decimal'],
  ])('draws %s with %s', (selector, style) => {
    expect(rule(selector)).toContain(`list-style: ${style};`);
  });

  // Depth is counted in list ancestors of either kind. Selectors that counted
  // only `ul` left an `ol` holding a `ul` on the first level's `disc`, and put
  // `ul > ol > ul` on the second level's `circle` instead of `square`.
  it.each([
    [':is(ul, ol) ul'],
    [':is(ul, ol) :is(ul, ol) ul'],
  ])('counts %s as a nesting level whichever list kind encloses it', (descendant) => {
    expect(rule(`.markdown-body ${descendant}`)).not.toBeNull();
  });

  // The one list that should keep the reset: its items carry checkboxes, and a
  // bullet beside each one is the reason this exception was written.
  it('leaves a task list without markers', () => {
    expect(rule('.markdown-body .contains-task-list')).toContain('list-style: none;');
  });

  // A marker is drawn inside the indent, so restoring the one without the other
  // puts an ordered list's numbers against the edge.
  it('indents the lists it draws markers on', () => {
    expect(rule('.markdown-body ul,\n.markdown-body ol')).toContain('padding-left');
  });

  // And the guard that keeps the single container honest. Both of these host
  // `.markdown-body` now, so a list rule written against either would be a
  // second definition of geometry the shared container already owns, decided
  // against it only by source order — which is not what anyone restyling a note
  // or a briefing will have in mind. Each keeps its heading scale, deliberately,
  // and nothing else; a surface that grows list rules again has started to
  // diverge, whether or not it has also stopped using the component.
  //
  // This reads selector preludes rather than searching the file for
  // `<host> <element>`. That substring is only one of the ways to write the rule
  // it is meant to catch: `:is(.note-detail-article, .meeting-notes-body) ul`
  // and `.note-detail-article > li` both style a markdown element on a host and
  // contain no such substring, so the search would pass while the divergence it
  // exists to prevent was already in the file.
  const MARKDOWN_ELEMENTS = [
    'p', 'a', 'em', 'strong', 'del', 'img', 'code', 'pre', 'hr', 'blockquote',
    'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ];

  it.each([['.note-detail-article'], ['.meeting-notes-body']])(
    'leaves markdown element styling to the shared container in %s',
    (host) => {
      // Headings are absent from the list on purpose: a scale is a property of
      // the surface, not of markdown, and each host overrides exactly one.
      const offenders = preludes()
        .filter((prelude) => prelude.includes(host))
        .filter((prelude) => elementsIn(prelude).some((element) => MARKDOWN_ELEMENTS.includes(element)));

      expect(offenders).toEqual([]);
    },
  );

  // The heading scales are the deliberate exception, and how they win matters as
  // much as that they win. Written as `.note-detail-article :is(h1, …)` they tie
  // `.markdown-body h1` at (0,1,1) and are decided by which sits lower in the
  // file — so splitting this stylesheet, or moving either block, would return
  // both surfaces to the shared scale with nothing going red. That is the same
  // silent visual regression as the missing markers, arriving the same way.
  // Naming `.markdown-body` in the selector settles it on specificity instead,
  // and this is what stops the class being tidied back out.
  it.each([['.note-detail-article'], ['.meeting-notes-body']])(
    'wins its heading scale on specificity rather than source order in %s',
    (host) => {
      const headingRules = preludes()
        .filter((prelude) => prelude.includes(host))
        .filter((prelude) => elementsIn(prelude).some((element) => /^h[1-6]$/u.test(element)));

      expect(headingRules.length).toBeGreaterThan(0);
      for (const prelude of headingRules) {
        expect(prelude).toContain('.markdown-body');
      }
    },
  );
});
