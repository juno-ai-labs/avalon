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

describe('capsule composer stacking', () => {
  // This guards the CSS contract; actual pointer hit-testing is verified in Electron.
  it('keeps both capsule control areas above the spanning attachment input shell', () => {
    const controls = rule(':is(.workstream-screen, .new-chat-screen) .is-message-capsule :is(.composer-tools, .composer-submit-area)');
    expect(controls).toContain('position: relative;');
    expect(controls).toContain('z-index: 1;');
    expect(rule('.composer-input-shell')).toContain('position: relative;');
    expect(rule('.composer-input-shell')).not.toContain('z-index:');
    expect(rule(':is(.workstream-screen, .new-chat-screen) .workstream-composer.is-message-capsule.has-attachments .composer-input-shell'))
      .toContain('grid-column: 1 / -1;');
  });
});

describe('secondary surface focus and layout', () => {
  it('keeps Terminal selection and keyboard focus distinguishable from resting borders', () => {
    expect(rule('.terminal-network-modes > label:has(input:checked)')).toContain('var(--av-sys-color-text-default)');
    expect(rule('.terminal-network-domains textarea:focus')).toContain('var(--av-sys-focus-ring-default)');
    expect(rule('.terminal-network-domains textarea:focus')).not.toContain('outline: none');
    expect(rule('.terminal-network-domains textarea')).toContain('var(--av-cmp-control-font-size)/1.5');
  });

  it('keeps dialog bodies scrollable without losing description-only footer spacing', () => {
    expect(rule('.dialog-content')).toContain('flex-direction: column');
    expect(rule('.dialog-body')).toContain('min-height: 0');
    expect(rule('.dialog-body')).toContain('overflow: auto');
    expect(rule('.dialog-header + .dialog-footer')).toContain('padding-top: 16px');
  });
});

/**
 * Collapsing a sidebar is the same state change however it was asked for — the
 * edge double-clicked, the toolbar button, or `⌘B` — so the motion is attached
 * to the width itself rather than to any one of those handlers, and none of
 * them has to remember to animate. What that costs is a drag: it writes the
 * same width many times a second and must land on the pointer, so the gesture
 * takes its own channel back out for as long as it lasts. These check that the
 * two halves are still both there, since either alone is a defect that looks
 * like a working feature — no transition is the cut this replaced, and a
 * transition left on during a drag is a sidebar that trails the pointer.
 */
describe('sidebar collapse motion', () => {
  it('transitions the navigation width alongside the rail, and drops it for a drag', () => {
    // Interpolating a custom property at all requires the syntax be declared;
    // an unregistered one switches over at the halfway point.
    expect(stylesheet).toMatch(/@property --av-cmp-sidebar-width \{\n {2}syntax: '<length>';/u);
    // `.workspace-shell` is declared twice; this reads the one that carries the
    // width channels rather than whichever the rule helper reaches first.
    expect(stylesheet).toContain(
      'transition: --rail-width 240ms cubic-bezier(.22, 1, .36, 1),'
      + ' --av-cmp-sidebar-width var(--sidebar-collapse-motion),'
      + ' --workstream-sidebar-width var(--sidebar-collapse-motion);',
    );
    // Each drag drops only its own channel. The other two are restated rather
    // than left out, so dragging one sidebar cannot silently stop the other, or
    // a rail closing on its own, from moving.
    expect(rule('.workspace-shell:has(.sidebar.is-resizing)'))
      .toBe(' transition-property: --rail-width, --workstream-sidebar-width; ');
    expect(rule('.workspace-shell:has(.workstream-context-sidebar.is-resizing)'))
      .toBe(' transition-property: --rail-width, --av-cmp-sidebar-width; ');
  });

  it('transitions the work-stream sidebar on the one property that sizes it', () => {
    expect(rule('.workstream-context-sidebar'))
      .toContain('transition: flex-basis var(--sidebar-collapse-motion)');
    expect(rule('.workstream-context-sidebar.is-resizing')).toContain('transition: none');
  });

  // `--rail-max-slot` spends the width this sidebar publishes, so the published
  // copy has to travel on the same interval as the `flex-basis` that draws it.
  // Registered as a length, or it reaches its final value in one frame and the
  // inspector's width steps while the sidebar beside it is still moving.
  it('moves the width the work-stream sidebar publishes with the width it draws', () => {
    expect(stylesheet).toMatch(/@property --workstream-sidebar-width \{\n {2}syntax: '<length>';/u);
    expect(rule('@property --workstream-sidebar-width')).toContain('initial-value: 0px;');
    expect(stylesheet).toContain('var(--workstream-sidebar-width, 0px)');
  });

  it('spends one duration on both sidebars', () => {
    expect(rule(':root')).toContain('--sidebar-collapse-motion: 240ms cubic-bezier(.22, 1, .36, 1);');
  });
});

describe('work-stream context sidebar layout', () => {
  it('keeps the transcript flexible and anchors the drag target to its panel', () => {
    expect(rule('.conversation-layout')).toContain('display: flex');
    expect(rule('.conversation-layout > .workstream-screen')).toContain('flex: 1');
    expect(rule('.workstream-context-sidebar')).toContain('position: relative');
    expect(rule('.workstream-context-sidebar')).toContain('min-width: 0');
    expect(rule('.workstream-context-sidebar.is-compact')).toContain('flex-basis: 96px');
    expect(rule('.workstream-context-scroll')).toContain('overflow-y: auto');
    expect(rule('.workstream-context-row:focus-visible')).toContain('var(--av-sys-color-focus-default)');
  });
});

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

});

describe('GrokBot sidebar header geometry', () => {
  it('keeps creation in the titlebar and gives search its own rounded row', () => {
    const titlebar = rule('.sidebar-titlebar');
    const commandbar = rule('.sidebar-commandbar');
    const create = rule('.sidebar-new-button');
    const search = rule('.sidebar-search');
    const scroll = rule('.sidebar-scroll');
    const scrollbar = rule('.sidebar-scroll::-webkit-scrollbar');

    expect(titlebar).not.toBeNull();
    expect(commandbar).not.toBeNull();
    expect(create).not.toBeNull();
    expect(search).not.toBeNull();
    expect(scroll).not.toBeNull();
    expect(scrollbar).not.toBeNull();
    expect(titlebar).toContain('height: 44px;');
    expect(commandbar).toContain('display: block;');
    expect(create).toContain('background: transparent;');
    expect(search).toContain('border-radius: 8px;');
    expect(search).toContain('height: 32px;');
    expect(scroll).toContain('scrollbar-gutter: auto;');
    expect(scrollbar).toContain('width: 0;');
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

describe('Grok Bot mention-chip geometry', () => {
  it('uses the inserted-chip metrics and the user-turn ink wash', () => {
    const chip = rule('.mention-chip');
    const userChip = rule(
      ':is(.workstream-screen, .automation-chat-surface) .human-message .mention-chip',
    );

    expect(chip).not.toBeNull();
    expect(chip).toContain('background: color-mix(in srgb, var(--av-ref-color-neutral-9) 13%, transparent);');
    expect(chip).toContain('border-radius: 4px;');
    expect(chip).toContain('font-size: 12px;');
    expect(chip).toContain('font-weight: 500;');
    expect(chip).toContain('gap: 4px;');
    expect(chip).toContain('line-height: 16px;');
    expect(chip).toContain('margin-bottom: -1px;');
    expect(chip).toContain('margin-top: -3px;');
    expect(chip).toContain('padding: 2px 6px 2px 4px;');
    expect(chip).not.toMatch(/(?:^|\n)\s*height:/u);
    expect(userChip).not.toBeNull();
    expect(userChip).toContain(
      'background: color-mix(in srgb, currentColor 24%, transparent);',
    );
  });
});

describe('citation card image preview', () => {
  it('fills its box from the center without distorting the image', () => {
    // The shared `.markdown-body img` sets `height: auto` and a prose margin.
    // Naming the host here is what makes the fixed cover box win inside it.
    const image = rule('.markdown-body .citation-card-image-preview');

    expect(image).not.toBeNull();
    expect(image).toContain('height: 100%;');
    expect(image).toContain('margin: 0;');
    expect(image).toContain('max-width: none;');
    expect(image).toContain('object-fit: cover;');
    expect(image).toContain('width: 100%;');
  });
});

/**
 * Chromium's `::-webkit-scrollbar` styling (below, 9px) opts these scrollers
 * into classic space-consuming scrollbars, so the moment their content
 * crosses one viewport the scrollbar pops in and shifts whatever is centered
 * inside them — the transcript column, the sidebar's row width, the settings
 * pane and a note's 760px article. Each of
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
    ['.sidekick-profile'],
    ['.sidekicks-library'],
    ['.transcript-scroll'],
    ['.rail-scroll'],
    ['.settings-navigation'],
    ['.settings-content-scroll'],
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
 * Shared rail and sidebar scrollers contain viewport overscroll effects.
 */
describe('overscroll containment on the shared rail and sidebar scrollers', () => {
  it.each([['.rail-scroll'], ['.sidebar-scroll']])('contains overscroll on %s', (selector) => {
    const declarations = rule(selector);

    expect(declarations).not.toBeNull();
    expect(declarations).toContain('overscroll-behavior: contain;');
  });
});

/**
 * `sys.space.group.gap` exists so one value decides every break between one
 * group of navigation rows and the next. It stopped meaning that once each
 * consumer was handed a literal of its own, and the way that failed is the
 * point: `.pinned-section` was left holding a retired theme's 60px while every
 * rule around it had quietly been tuned down to the low teens, so the only
 * break nobody had overridden was the one nobody had looked at. A fresh
 * literal here is that same move, and it fails rather than accumulates.
 *
 * `0` stays allowed — the compact rail hides the headings these gaps space, so
 * zero there is a different decision, not an escape from the token. The
 * shorthand is checked alongside the longhand because `.sidebar-primary-actions`
 * is the standing proof that a `margin` shorthand later in the file silently
 * shadows a `margin-top` that names the token.
 */
describe('sidebar group breaks follow the group-gap token', () => {
  const GROUPED = ['.pinned-section', '.workstreams-section', '.projects-section', '.sidebar-group'];

  it('gives no grouped sidebar section a margin-top literal of its own', () => {
    const offenders: string[] = [];

    for (const [, selector = '', body = ''] of stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      if (!GROUPED.some((name) => selector.includes(name))) continue;

      for (const [, value = ''] of body.matchAll(/margin-top:\s*([^;]+)/gu)) {
        const top = value.trim();
        if (top === '0' || top === 'var(--av-sys-space-group-gap)') continue;
        offenders.push(`${selector.trim()} { margin-top: ${top} }`);
      }

      // A shorthand's first value is its top margin.
      for (const [, value = ''] of body.matchAll(/(?:^|;)\s*margin:\s*([^;]+)/gu)) {
        const top = value.trim().split(/\s+/u)[0] ?? '';
        if (top === '0' || top === 'var(--av-sys-space-group-gap)') continue;
        offenders.push(`${selector.trim()} { margin: ${value.trim()} }`);
      }
    }

    expect(offenders).toEqual([]);
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

describe('sidebar project rows', () => {
  // Project rows wear `.sidebar-row` so they pick up the shared hover fill,
  // radius, and padding. A private hover colour on `.project-sidebar-row`
  // would win on specificity and split the two kinds again — which is how
  // they looked before this guard.
  it('does not give project rows a private hover fill', () => {
    expect(rule('.project-sidebar-row:hover')).toBeNull();
    expect(rule('.project-sidebar-workstream')).toBeNull();
    expect(rule('.project-sidebar-workstream:hover')).toBeNull();
  });

  it('hides the project-row plus until the row is hovered or focused', () => {
    expect(rule('.project-sidebar-row .project-sidebar-row-action')).toContain('opacity: 0;');
    const reveal = rule(
      '.project-sidebar-row:hover .project-sidebar-row-action,\n'
      + '.project-sidebar-row:focus-within .project-sidebar-row-action',
    );
    expect(reveal).toContain('opacity: 1;');
  });

  it('starts nested work-stream rows where the accordion control ends', () => {
    expect(rule('.sidebar-row.project-sidebar-row')).toContain('grid-template-columns: 18px minmax(0, 1fr) 28px;');
    expect(rule('.project-accordion-control')).toContain('width: 18px;');
    expect(rule('.project-sidebar-workstreams')).toContain('padding-left: 18px;');
  });

  it('paints the command-shortcut scrim from the same hover and selected fills as the row', () => {
    expect(stylesheet).toContain(
      '.sidebar-row:hover { --sidebar-row-background: var(--av-cmp-row-background-hover); }',
    );
    expect(stylesheet).toContain(
      '.sidebar-row.is-active { --sidebar-row-background: var(--av-cmp-row-background-selected); }',
    );
  });
});

describe('sidebar automation rows', () => {
  it('does not give automation rows a private hover fill', () => {
    expect(rule('.automation-row:hover')).toBeNull();
    expect(rule('.workstream-row,\n.automation-row')).toContain('min-height: var(--av-cmp-row-height-dense);');
  });

  it('drops the scope-badge fill while the row is hovered or current', () => {
    const ghost = rule(
      '.sidebar-row:hover .scope-badge,\n'
      + '.sidebar-row.is-active .scope-badge,\n'
      + '.sidebar-row:focus-within .scope-badge',
    );
    expect(ghost).toContain('background: transparent;');
    expect(ghost).toContain('border-color: transparent;');
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
 * for its own length regardless of how short the animation that follows is. The
 * two `.launch-arrival` rows stagger in on a 60ms base plus a 70ms-per-index
 * delay from `opacity: 0`, so leaving delays alone kept them invisible for
 * their whole 60ms and 130ms holds under this preference — the block looked
 * like it turned motion off and instead only made it instant once it started.
 *
 * The regex anchors on the `*, *::before, *::after` selector rather than
 * reusing the block extractor above, which resolves to the *first* of this
 * stylesheet's four `prefers-reduced-motion` blocks by position — not this one.
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
    expect(declarations).toContain('scroll-behavior: auto !important;');
  });

  // The declarations above only prove the spelling. What actually reopens the
  // stagger bug is a delay *winning the cascade*: any class-level
  // `animation-delay: … !important` (specificity 0,1,0) beats the universal
  // selector (0,0,0), so the kill switch holds only while it owns the sole
  // `!important` delays in the sheet. A future rule that trips this must state
  // its own reduced-motion story inside the kill-switch block instead.
  it('owns the only !important delay declarations in the stylesheet', () => {
    const importantDelays = stylesheet.match(/[a-z-]*delay:[^;{}]*!important/gu) ?? [];

    expect(importantDelays).toEqual([
      'animation-delay: 0.001ms !important',
      'transition-delay: 0.001ms !important',
    ]);
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

  it.each([
    ['.note-detail-article'],
    ['.meeting-notes-body'],
    ['.inspector-detail-document'],
  ])(
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

  it('does not restore the retired embed-card text preview', () => {
    expect(rule('.citation-card-preview')).toBeNull();
    expect(preludes().filter((prelude) => (
      prelude.includes('.citation-card-preview')
      && !prelude.includes('.citation-card-preview-skeleton')
    ))).toEqual([]);
  });

  // The preview's inherit is a nested-MarkdownBody fix. If it ever leaked onto
  // the shared group, a note, a briefing, or a turn would recede with the
  // glance — the failure this test exists to make red. Every `.markdown-body`
  // rule that inherits has to name the card preview; the shared paints below
  // are the ones the other hosts still need.
  it('leaves shared markdown paint alone outside the embed-card preview', () => {
    const markdownInherit = preludes().filter((prelude) => {
      if (!prelude.includes('.markdown-body')) return false;
      return /(^|;|\s)color\s*:\s*inherit/u.test(rule(prelude) ?? '');
    });

    expect(markdownInherit).toEqual([]);
    for (const prelude of markdownInherit) {
      expect(prelude).toContain('.citation-card-preview');
    }

    expect(rule('.markdown-body strong')).toContain('var(--av-ref-color-neutral-14)');
    expect(rule('.markdown-body a')).toContain('var(--av-sys-color-accent-soft)');
    expect(rule('.markdown-body h1')).toContain('var(--av-cmp-markdown-heading-1)');
    expect(rule('.note-detail-article .markdown-body h1')).toContain(
      'var(--av-cmp-markdown-article-heading-1)',
    );
    expect(rule('.meeting-notes-body .markdown-body :is(h1, h2, h3, h4, h5, h6)')).toContain(
      'font-size: 15px',
    );
    expect(rule(':is(.workstream-screen, .automation-chat-surface) .agent-message .markdown-body'))
      .toContain('14.5px');
  });
});

/**
 * Every surface that sizes a company mark has to out-specify the shared rule.
 *
 * `.connector-mark` carries the default height and width, and it sits low in
 * this file. A per-surface size written as a bare class ties it at (0,1,0) and
 * loses on source order, so the rule is inert and the mark silently keeps the
 * default — which is exactly what happened to Settings' provider chip and its
 * connection row, and it survived a visual check because 16px against 19px and
 * 14px is a difference you have to be looking for.
 */
describe('company mark sizing', () => {
  const sizesAMark = (prelude: string): boolean => {
    const declarations = rule(prelude) ?? '';
    return /(^|;|\s)(height|width)\s*:/u.test(declarations);
  };

  it('sizes a mark only through the surface that owns it', () => {
    const markRules = preludes()
      .filter((prelude) => prelude.includes('connector-mark'))
      .filter(sizesAMark);

    expect(markRules.length).toBeGreaterThan(1);
    for (const prelude of markRules) {
      // The shared default and its own descendants are the rules allowed to
      // lead with the class; a *surface* override is what has to out-specify.
      if (prelude.startsWith('.connector-mark')) continue;
      expect(prelude, `${prelude} ties .connector-mark and loses on order`)
        .toMatch(/\.[a-z-]+\s+\.connector-mark/u);
    }
  });

  it('keeps the shared default above the surfaces that override it', () => {
    // Specificity settles these, but a bare rule added *below* the default
    // would win on order and read as if it were fine, so the ordering is
    // pinned too: the default comes first and everything else out-specifies it.
    const source = readFileSync(resolve(process.cwd(), 'src/renderer/styles/app.css'), 'utf8');
    const base = source.indexOf('\n.connector-mark {');
    expect(base).toBeGreaterThan(-1);
    expect(source.indexOf('.provider-icon .connector-mark')).toBeLessThan(base);
    expect(source.indexOf('.settings-connection-name .connector-mark')).toBeLessThan(base);
  });
});


/**
 * A message header shows the author, the time, and — once a response settles —
 * the total it took. The last two are the same kind of thing, and the design
 * asks for them to be indistinguishable: same size, same weight, same colour.
 * Two rules that happen to agree today would drift the first time either is
 * touched, and the difference is a few tenths of a pixel on one line, which is
 * exactly the sort of thing a visual check passes over.
 */
describe('message header meta typography', () => {
  it('styles the settled total through the timestamp rule rather than beside it', () => {
    const shared = rule('.message-block time,\n.message-block .message-work-summary');
    expect(shared).not.toBeNull();
    expect(shared).toContain('font-size: var(--av-sys-font-size-meta)');
    expect(shared).toContain('color: var(--av-ref-color-neutral-8)');
    // Neither may carry a size, weight, or colour of its own anywhere else, or
    // the two stop matching without either rule looking wrong on its own.
    const strays = preludes().filter((prelude) => prelude.includes('.message-work-summary')
      && prelude !== '.message-block time,\n.message-block .message-work-summary');
    expect(strays).toEqual([]);
  });

  it('centres the header on its children rather than on their line boxes', () => {
    // The row mixes three type sizes whose line boxes exceed their glyphs by
    // different amounts, so flex centring alone leaves the text looking high.
    expect(rule('.message-block > header')).toContain('align-items: center');
    expect(rule('.message-block > header > *')).toContain('line-height: 1');
  });

  /**
   * The substream control appears in both action rows, so the rows share one set
   * of button metrics. Restating them per row is not merely duplication: inside
   * the agent's row `.agent-message-actions button` outranks the control's own
   * class, so a per-row copy silently wins there and loses under the bubble, and
   * tuning one row moves the control on Rally's turn while leaving it behind on
   * the person's.
   */
  /**
   * The defect this PR's action-row move introduced and then fixed: the control
   * carried its own hover opacity into a row that already fades, the two
   * multiplied, and it settled paler and later than the four buttons beside it.
   * The fix is the deletion of a declaration, so this is where it is held —
   * nothing in the DOM says what opacity a pixel ended up at.
   */
  it('leaves the hover fade to the row that holds the control', () => {
    expect(rule('.message-start-substream')).not.toContain('opacity');
    expect(rule('.agent-message-actions')).toContain('opacity: 0;');
    expect(rule('.human-message-actions')).toContain('opacity: 0;');
  });

  it('gives both action rows one set of button metrics', () => {
    const shared = rule(':is(.agent-message-actions, .human-message-actions) button');
    expect(shared).not.toBeNull();
    expect(shared).toContain('font-size: 10px;');
    expect(shared).toContain('padding: 2px;');
    expect(rule('.agent-message-actions button')).toBeNull();
  });

  /**
   * The identity line over a person's turn, and the action row under it, stop
   * where the bubble's top edge does, so the name, the time and the actions sit
   * over the flat of the pill rather than over the round of its corner. That is
   * one number in four rules, and a literal copied into any of them drifts the
   * first time the corner is tuned — a few pixels on one line, which is exactly
   * what a screenshot pass looks past.
   */
  it('insets the human identity line and action row by the bubble corner they are named once for', () => {
    const block = rule(':is(.workstream-screen, .automation-chat-surface) .human-message');
    expect(block).toContain('--turn-bubble-radius:');
    expect(rule(':is(.workstream-screen, .automation-chat-surface) .human-message-bubble'))
      .toContain('border-radius: var(--turn-bubble-radius);');
    expect(rule(':is(.workstream-screen, .automation-chat-surface) .human-message > header'))
      .toContain('padding-inline-end: var(--turn-bubble-radius);');
    expect(rule(':is(.workstream-screen, .automation-chat-surface) .human-message .human-message-actions'))
      .toContain('padding-inline-end: var(--turn-bubble-radius);');
  });

  /**
   * A theme that wants a different corner restates the token, not the corner.
   * The work-stream theme wrote `18px` onto the bubble and onto the header's
   * padding instead, which held only while those two literals agreed: the
   * action row, reading the token, came out inset by the shared 14px against an
   * 18px corner.
   */
  it('lets the work-stream theme move the corner by the token rather than by a literal', () => {
    const themed = rule('.workstream-screen .human-message');
    expect(themed).not.toBeNull();
    expect(themed).toContain('--turn-bubble-radius:');
    // The two token declarations tie on specificity — `:is()` takes its most
    // specific argument — so source order is what makes the theme's value win.
    // Without this, moving the theme rule above the shared one keeps every
    // assertion here green while restoring the 4px drift they exist to prevent.
    expect(stylesheet.indexOf('.workstream-screen .human-message {'))
      .toBeGreaterThan(stylesheet.indexOf(':is(.workstream-screen, .automation-chat-surface) .human-message {'));
    expect(rule('.workstream-screen .human-message-bubble'))
      .toContain('border-radius: var(--turn-bubble-radius);');
    // On the value, not one spelling of the property: a literal creeping back
    // as `padding-inline-end: 18px` — a spelling this file does use, and so a
    // likely regression — would pass a check that only banned `padding-right`.
    // `padding-inline` is in the pattern for the same reason: it sets the
    // trailing inset as surely as either, and it is the logical spelling the
    // stylesheet actually reaches for.
    expect(rule('.workstream-screen .human-message > header'))
      .not.toMatch(/padding(?:-right|-inline(?:-end)?)?:/u);
  });

  /**
   * Rally's turn has no avatar, so nothing occupies a gutter left of its name.
   * The theme inset that header by 18px anyway, which put the identity line on
   * its own vertical while the prose and the action row under it shared the
   * article's own edge — a hanging indent over an empty gutter. Held on the
   * value rather than on one spelling, for the same reason as the human rule
   * above. `padding-inline` is the one that matters most here: it is the
   * logical spelling this stylesheet actually uses (`padding-inline-start`
   * appears nowhere in it), and `padding-inline: 18px 0` reads as a horizontal
   * pair rather than as a leading inset while setting exactly the one this
   * change removed. A trailing inset stays allowed, since `padding-inline-end`
   * is what the human header opposite uses.
   */
  it('starts the assistant identity line on the same vertical as its prose', () => {
    expect(rule('.workstream-screen .agent-message > header'))
      .not.toMatch(/padding(?:-left|-inline(?:-start)?)?:/u);
    expect(rule(':is(.workstream-screen, .automation-chat-surface) .agent-message > header'))
      .not.toMatch(/padding(?:-left|-inline(?:-start)?)?:/u);
  });
});

describe('inspector resource document chrome', () => {
  it('draws a hairline between last-updated and the document from the line tokens', () => {
    const declarations = rule('.inspector-detail-rule');
    expect(declarations).not.toBeNull();
    expect(declarations).toContain('border-top: var(--av-sys-size-border-hairline) solid var(--av-sys-color-border-subtle);');
  });

  it('paints the archive header control in the danger colour', () => {
    const idle = rule('.icon-button-danger');
    expect(idle).not.toBeNull();
    expect(idle).toContain('color: var(--av-sys-color-danger-base);');
  });

  // The rail is a grid with a definite width, but an implicit `auto` column
  // will not shrink below the markdown's max-content, and `.rail-scroll`'s
  // `overflow-x: hidden` then clips the unwrapped lines. Naming the column
  // `minmax(0, 1fr)` and giving the scroller and the document host `min-width:
  // 0` is what makes the preview take the rail rather than the file; removing
  // either half returns the clip.
  it('gives the rail a column that can shrink below the document min-content', () => {
    const surface = rule('.rail-surface');
    expect(surface).not.toBeNull();
    expect(surface).toContain('grid-template-columns: minmax(0, 1fr);');
    const scroll = rule('.rail-scroll');
    expect(scroll).not.toBeNull();
    expect(scroll).toContain('min-width: 0;');
  });

  it('sizes the document host to the rail rather than the markdown max-content', () => {
    const host = rule('.inspector-detail-document');
    expect(host).not.toBeNull();
    expect(host).toContain('max-width: 100%;');
    expect(host).toContain('min-width: 0;');
  });
});

describe('collapsed heading preview mask', () => {
  it('fades from 60% on the first pixel to transparent on the last', () => {
    const body = rule('.markdown-collapse.is-collapsed > .markdown-collapse-body');
    expect(body).not.toBeNull();
    expect(body).toContain('color-mix(in srgb, var(--av-sys-color-text-default) 60%, transparent)');
    expect(body).toContain('transparent)');
    expect(body).not.toContain('18%');
  });

  // Clicking the preview opens the section, so a collapsed one reads as the
  // control it is. An expanded section keeps the ordinary text cursor: there
  // is no inverse click.
  it('gives a collapsed section the pointer cursor, and an expanded one none', () => {
    expect(rule('.markdown-collapse.is-collapsed')).toContain('cursor: pointer');
    expect(rule('.markdown-collapse.is-expanded')).toBeNull();
  });
});

/**
 * A queued row renders the message through the transcript's own Markdown
 * renderer, which emits blocks: a paragraph, a heading, a list, a fenced block.
 * The row is one line. Nothing in a component test can see the difference —
 * jsdom lays nothing out, so every assertion about the row's markup stays green
 * while the composer dock grows to the height of a whole queued message — so
 * the flattening lives here, where deleting it fails.
 */
describe('composer queue preview', () => {
  it('keeps a queued message to one clipped line', () => {
    const text = rule('.composer-queue-text');
    expect(text).not.toBeNull();
    expect(text).toContain('white-space: nowrap;');
    expect(text).toContain('overflow: hidden;');
    expect(text).toContain('text-overflow: ellipsis;');
  });

  it('flattens every Markdown block the renderer can emit into that line', () => {
    const body = rule('.composer-queue-text .markdown-body');
    expect(body).not.toBeNull();
    expect(body).toContain('display: inline;');
    // The prose type scale would otherwise set a heading in a 12px row.
    expect(body).toContain('font-size: inherit;');
    expect(body).toContain('line-height: inherit;');

    const blocks = preludes().find((prelude) => (
      prelude.startsWith('.composer-queue-text .markdown-body :is(')
      && prelude.includes('p,')
    ));
    expect(blocks).toBeDefined();
    for (const tag of ['p', 'h1', 'h6', 'ul', 'ol', 'li', 'pre', 'blockquote', 'table', 'tr', 'td']) {
      expect(blocks).toMatch(new RegExp(`[(,]\\s*${tag}[,)]`, 'u'));
    }
  });
});

/**
 * The window's own buttons are drawn over the page on macOS, and the sidebar's
 * 48px title bar is what normally holds anything readable clear of them. Below
 * 921px the sidebar leaves the flow for a drawer, and the work-stream and
 * automation headers slide under the traffic lights — where the title is both
 * illegible and unclickable, since the buttons are chrome above the web
 * contents and take the press. `docs/assumptions.md` item 25 is the rule.
 *
 * Nothing in a component test can see it: the DOM is identical either way, and
 * the defect is entirely in resolved layout against chrome jsdom does not draw.
 */
describe('window-control gutter while the sidebar is a drawer', () => {
  it('defaults the inset to nothing, so only macOS pays for the band', () => {
    const root = rule(':root');
    const overlay = rule('.workspace-shell.has-overlay-window-controls');

    expect(root).not.toBeNull();
    expect(overlay).not.toBeNull();
    expect(root).toContain('--window-controls-inset: 0px;');
    expect(overlay).toContain('--window-controls-inset: 82px;');
  });

  // 82px is the traffic lights' own geometry: three 12px buttons on a 20px
  // pitch from `trafficLightPosition` x: 18, ending at 70, plus 12px of air.
  // `max()` rather than the token alone so the 8px the narrow layout already
  // used survives on the platforms where the inset is zero.
  it('starts the collapsed headers after the band rather than under it', () => {
    const collapsed = stylesheet.match(/@media \(max-width: 920px\) \{([\s\S]*?)\n\}/u)?.[1];
    expect(collapsed).toBeDefined();

    const headers = ruleWithin(collapsed!, '.workstream-header,\n  .automation-overview-header');
    expect(headers).not.toBeNull();
    expect(headers).toContain('padding-left: max(8px, var(--window-controls-inset));');
  });

  /**
   * The drawer button keeps its whole hit target however little room is left.
   *
   * It is the only way back to the navigation at this width, and it sits in a
   * flex row that also holds a title with `min-width: 0`. Left to shrink it
   * loses width to the title before the title truncates, and with the right
   * rail open at the window's 860px minimum there is little to give.
   */
  it('never lets the drawer button shrink out of its hit target', () => {
    const button = rule('.header-menu-button');
    expect(button).not.toBeNull();
    expect(button).toContain('flex: 0 0 auto;');
  });

  /**
   * The one coupling nothing else would notice.
   *
   * A stylesheet rule keyed on a class no component writes is inert, and the
   * symptom is this change's defect returning on macOS alone — the platform
   * none of this suite runs on. The class is asserted where it is *produced*,
   * so an inverted mapping fails `windowControlsShellClass`'s own test rather
   * than passing a grep for the literal. What is left for here is that the
   * stylesheet and that helper name the same class. Read from disk rather than
   * imported for the reason at the top of this file.
   */
  it('is keyed on the class the shell actually produces', () => {
    const shell = readFileSync(resolve(process.cwd(), 'src/renderer/components/app-shell.tsx'), 'utf8');
    const produced = /return platform === 'darwin' \? '([a-z-]+)' : '';/u.exec(shell)?.[1];

    expect(produced).toBe('has-overlay-window-controls');
    expect(rule(`.workspace-shell.${produced!}`)).not.toBeNull();
    // And that the shell hands it the platform rather than calling it with
    // something that is never 'darwin'.
    expect(shell).toContain('windowControlsShellClass(runtime?.platform)');
  });
});
