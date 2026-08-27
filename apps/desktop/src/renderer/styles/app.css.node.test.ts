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
  return ruleWithin(stylesheet, selector);
}

/** The declarations inside one rule within an already bounded stylesheet fragment. */
function ruleWithin(source: string, selector: string): string | null {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return source.match(new RegExp(`(?:^|\\n)\\s*${escapedSelector} \\{([^}]*)\\}`, 'u'))?.[1] ?? null;
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

    // `rule()` returns null for a selector that is not in the file, and
    // `toContain` on null fails as "expected null to include …" — which names
    // neither the selector nor the fact that the rule is gone. Reformatting a
    // rule onto more lines is enough to produce it, so every assertion on a
    // rule's contents below says first that the rule is there.
    expect(launching).not.toBeNull();
    expect(destinationRows).not.toBeNull();
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
    // The one `rule()` consumer with no null guard, deliberately: these three
    // selectors are absent from the stylesheet today — the split is written as
    // `:not(.is-launching)` rules on the resting state instead — and absence is
    // exactly the property this test is named after. Asserting the rule exists
    // here would assert the opposite. It does mean these rows pass while the
    // classes they name are only ever spelled in this file.
    const declarations = rule(selector);
    if (declarations === null) return;
    for (const property of forbidden) {
      expect(declarations).not.toContain(`${property}:`);
    }
  });

  // The hand-off keeps the home content mounted for exactly as long as the
  // stylesheet spends fading it, and the two are declared in different files.
  it('fades the home content over the span the screen keeps it mounted for', () => {
    const leaving = rule('.launch-home-layer.is-leaving');

    expect(leaving).not.toBeNull();
    expect(leaving).toContain('animation: launch-home-leave 190ms');
  });
});

describe('member picker controls', () => {
  it('keeps custom controls out of the flexible member-copy rule', () => {
    const copy = rule(
      '.member-picker-row > span:not(.avatar):not(.member-checkbox):not(.resource-picker-icon),\n.member-action-row > span:not(.avatar)',
    );
    const checkbox = rule('.member-checkbox');

    expect(copy).not.toBeNull();
    expect(checkbox).not.toBeNull();
    expect(copy).toContain('flex: 1;');
    expect(checkbox).toContain('flex: 0 0 16px;');
  });

  it('mirrors focus from the transparent native input onto the visible checkbox', () => {
    const mirrored = rule('.member-picker-row:has(input:focus-visible) .member-checkbox');

    expect(mirrored).not.toBeNull();
    expect(mirrored).toContain('outline: 2px solid var(--av-sys-color-focus-quiet);');
  });
});

/**
 * Chromium's `::-webkit-scrollbar` styling (below, 9px) opts these scrollers
 * into classic space-consuming scrollbars, so the moment their content
 * crosses one viewport the scrollbar pops in and shifts whatever is centered
 * inside them — the transcript column, the sidebar's row width, the settings
 * pane, the automation builder's 996px column, a note's 760px article. Each of
 * these is tall enough, on an ordinary screen, to reach that point in normal
 * use, so each reserves its gutter up front rather than having it appear
 * mid-session.
 *
 * This list is the registry of that judgement — the standing call is recorded
 * in `docs/assumptions.md`, and a scroller judged *not* to qualify is left out
 * of it with a comment at its own rule saying why. A row here therefore means
 * somebody decided the scroller reaches a viewport; the absence of one means
 * somebody decided it does not.
 */
describe('scrollbar gutter reservation on the always-tall scrollers', () => {
  it.each([
    ['.transcript-scroll'],
    ['.sidebar-scroll'],
    ['.rail-scroll'],
    ['.settings-navigation'],
    ['.settings-content-scroll'],
    ['.new-workstream-home'],
    ['.automation-overview-scroll'],
    ['.new-automation-screen'],
    ['.note-detail-scroll'],
    ['.note-transcript-scroll'],
  ])('reserves a stable gutter on %s', (selector) => {
    const declarations = rule(selector);

    expect(declarations).not.toBeNull();
    expect(declarations).toContain('scrollbar-gutter: stable;');
    // And that the rule is still a scroll container. `scrollbar-gutter` is
    // inert on an element that does not scroll, so a rule that loses its
    // `overflow` keeps a declaration that now reserves nothing — which reads,
    // here and in the file, exactly like one that still works.
    expect(declarations).toMatch(/overflow(-[xy])?: (auto|scroll);/u);
  });
});

/**
 * `.rail-scroll` backs both the inspector rail and the HyperSight
 * (block-dashboard) rail — `inspector-rail.tsx` and `block-dashboard-panel.tsx`
 * both render a `.rail-scroll` div — and containment used to be declared only
 * for the HyperSight variant, via `.block-dashboard-rail .rail-scroll`.
 *
 * What that containment does, precisely, because the obvious reading is wrong:
 * scroll chaining walks the *ancestor* chain, and neither of these scrollers
 * has a scrollable ancestor to chain into. `.rail-surface` and `.sidebar` are
 * `position: fixed`, and `html`, `body` and `#root` are all `overflow: hidden`.
 * Scrolling past either edge could not have scrolled the transcript or the
 * workspace underneath it, and adding containment did not stop it doing so.
 * What `contain` suppresses is the other half of the property: the viewport's
 * own overscroll affordance — Chromium's rubber-band or glow — at the end of
 * the scroller.
 *
 * Why only the HyperSight rail carried it was never written down, and this
 * consolidation is not the repair of a defect anybody observed: it makes the
 * two rails identical, and gives the sidebar the same treatment, so that the
 * next person reading either rule finds one answer rather than two.
 */
describe('overscroll containment on the shared rail and sidebar scrollers', () => {
  it.each([['.rail-scroll'], ['.sidebar-scroll']])('contains overscroll on %s', (selector) => {
    const declarations = rule(selector);

    expect(declarations).not.toBeNull();
    expect(declarations).toContain('overscroll-behavior: contain;');
  });

  // Read off the selector preludes rather than searched for in the whole file,
  // for the reason spelled out at the markdown guard below. `not.toContain` on
  // the raw stylesheet was both. Under-strict: it misses
  // `.block-dashboard-rail > .rail-scroll`, an `:is()` form, and a selector
  // broken across lines, every one of which is the override it exists to
  // forbid. And over-strict: `preludes()` strips comments, but a raw substring
  // search does not, so a comment in the stylesheet explaining why the override
  // was removed would have failed it — which makes the one place the reasoning
  // belongs the one place it could not be written.
  it('declares it on the shared rule rather than a HyperSight-only override', () => {
    expect(preludes().filter((prelude) => /\.block-dashboard-rail\b[^,]*\.rail-scroll\b/u.test(prelude)))
      .toEqual([]);
  });
});

describe('Needs attention row geometry', () => {
  it('reserves a project slot and pins time and chevron to stable columns', () => {
    expect(rule('.waiting-workstream-row')).toContain(
      'grid-template-columns: 112px auto minmax(0, 1fr) auto auto 15px;',
    );
    expect(rule('.waiting-workstream-projects')).toContain('min-width: 20px;');
    expect(rule('.waiting-workstream-source')).toContain('grid-column: 4;');
    expect(rule('.waiting-workstream-row time')).toContain('grid-column: 5;');
    expect(rule('.waiting-workstream-row > svg')).toContain('grid-column: 6;');
  });
});

describe('raised popover interaction states', () => {
  it('highlights ordinary menu rows and preserves the danger override', () => {
    const content = rule('.menu-content');
    const highlighted = rule('.menu-item[data-highlighted]');
    const danger = rule('.menu-item-danger[data-highlighted]');

    expect(content).not.toBeNull();
    expect(highlighted).not.toBeNull();
    expect(danger).not.toBeNull();
    expect(content).toContain('background: var(--av-sys-color-surface-raised);');
    expect(highlighted).toContain('background: var(--av-sys-color-surface-raised-hover);');
    expect(danger).toContain('background: var(--av-sys-color-danger-tint);');
  });

  it('highlights command rows against the raised command popover', () => {
    const popover = rule('.command-popover');
    const rows = rule(
      '.command-popover > button:hover,\n'
      + '.command-popover > button:focus-visible,\n'
      + '.command-popover > button.is-selected',
    );

    expect(popover).not.toBeNull();
    expect(rows).not.toBeNull();
    expect(popover).toContain('background: var(--av-sys-color-surface-raised);');
    expect(rows).toContain('background: var(--av-sys-color-surface-raised-hover);');
  });
});

describe('work-stream participant presence', () => {
  it('finishes the arrival pop before pulsing every ten seconds and preserves a static reduced-motion state', () => {
    const ping = rule('.avatar-presence-ping');
    expect(ping).not.toBeNull();
    expect(ping).toContain('animation: avatar-presence-ping 10s cubic-bezier(0, 0, .2, 1) infinite;');
    expect(ping).toContain('animation-delay: 420ms;');
    expect(ping).toContain('background: color-mix(');
    expect(ping).toContain('var(--av-sys-color-success-base)');
    expect(ping).toContain('inset: 0;');
    expect(ping).toContain('opacity: 0;');
    expect(ping).toContain('transform: scale(1);');
    expect(ping).toContain('z-index: 1;');
    expect(stylesheet).toContain('20%, 100% { opacity: 0; transform: scale(2); }');
    expect(rule('.avatar-stack .avatar')).toContain('transition: border-color 180ms ease;');
    const presentAvatar = rule('.avatar-stack-item.is-present > .avatar');
    expect(presentAvatar).toContain(
      'animation: avatar-presence-entry 420ms cubic-bezier(.2, .75, .24, 1);',
    );
    expect(presentAvatar).toContain('border-color: var(--av-sys-color-brand-base);');
    expect(stylesheet).toContain('42% { transform: translateY(-3px); }');
    const reducedMotionBlock = stylesheet.match(
      /@media \(prefers-reduced-motion: reduce\) \{\n([\s\S]*?)\n\}\n/,
    )?.[1] ?? '';
    expect(reducedMotionBlock).not.toBe('');
    const reducedMotion = ruleWithin(reducedMotionBlock, '.avatar-presence-ping');
    expect(reducedMotion).toContain('animation: none;');
    expect(reducedMotion).toContain('opacity: .3;');
    expect(reducedMotion).toContain('transform: scale(1.35);');
    const reducedMotionAvatar = ruleWithin(reducedMotionBlock, '.avatar-stack .avatar');
    expect(reducedMotionAvatar).toContain('transition: none;');
    const reducedMotionEntry = ruleWithin(
      reducedMotionBlock,
      '.avatar-stack-item.is-present > .avatar',
    );
    expect(reducedMotionEntry).toContain('animation: none;');
    const overflow = stylesheet.match(/\n\.avatar-overflow \{\n {2}align-items: center;[^}]*\}/)?.[0];
    expect(overflow).toContain('position: relative;');
    expect(overflow).toContain('z-index: 1;');
  });
});

/**
 * `animation-duration` and `transition-duration` are zeroed here, but a delay is
 * a separate property: it holds the "from" state of a `both`-filled animation
 * for its own length regardless of how short the animation that follows is. A
 * `.launch-arrival` row staggers in on a 60ms base plus a 70ms-per-index delay
 * from `opacity: 0`, so leaving delays alone kept every row invisible for its
 * whole stagger under this preference — the block looked like it turned motion
 * off and instead only made it instant once it started.
 */
describe('global reduced-motion kill switch', () => {
  it('zeroes animation and transition delays alongside their durations', () => {
    const declarations =
      stylesheet.match(
        /@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{([^}]*)\}/u,
      )?.[1] ?? null;

    expect(declarations).not.toBeNull();
    expect(declarations).toContain('animation-duration: 0.001ms !important;');
    expect(declarations).toContain('animation-delay: 0.001ms !important;');
    expect(declarations).toContain('transition-duration: 0.001ms !important;');
    expect(declarations).toContain('transition-delay: 0.001ms !important;');
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
    const row = rule('.system-message');
    expect(row).not.toBeNull();
    expect(row).toContain('--system-message-lines: 5;');

    const closed = rule('.system-message-text:not([data-expanded])');
    expect(closed).not.toBeNull();
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
    const text = rule('.system-message-text');

    expect(text).not.toBeNull();
    expect(text).toContain('white-space: pre-wrap;');
  });

  // The open row is bounded too. Without a ceiling, opening a 120,000-character
  // run prompt restores the wall of text the clamp exists to remove, and puts
  // the control that closes it a screen or more below the reader's pointer.
  it('bounds an open system row instead of letting it run', () => {
    const open = rule('.system-message-text[data-expanded]');
    expect(open).not.toBeNull();
    expect(open).toContain('max-height: 320px;');
    expect(open).toContain('overflow-y: auto;');
  });
});

describe('attachment lightbox', () => {
  it('keeps plain attachment text visibly monospace', () => {
    const text = rule('.attachment-lightbox-text');

    expect(text).not.toBeNull();
    expect(text).toContain('font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;');
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
    const declarations = rule(selector);

    expect(declarations).not.toBeNull();
    expect(declarations).toContain(`list-style: ${style};`);
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
    const taskList = rule('.markdown-body .contains-task-list');

    expect(taskList).not.toBeNull();
    expect(taskList).toContain('list-style: none;');
  });

  // A marker is drawn inside the indent, so restoring the one without the other
  // puts an ordered list's numbers against the edge.
  it('indents the lists it draws markers on', () => {
    const geometry = rule('.markdown-body ul,\n.markdown-body ol');

    expect(geometry).not.toBeNull();
    expect(geometry).toContain('padding-left');
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
