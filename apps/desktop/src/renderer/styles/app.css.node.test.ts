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
    const controls = rule(':is(.workstream-screen, .workstream-launch-screen) .is-message-capsule :is(.composer-tools, .composer-submit-area)');
    expect(controls).toContain('position: relative;');
    expect(controls).toContain('z-index: 1;');
    expect(rule('.composer-input-shell')).toContain('position: relative;');
    expect(rule('.composer-input-shell')).not.toContain('z-index:');
    expect(rule(':is(.workstream-screen, .workstream-launch-screen) .workstream-composer.is-message-capsule.has-attachments .composer-input-shell'))
      .toContain('grid-column: 1 / -1;');
    expect(rule(":is(.workstream-screen, .workstream-launch-screen) .workstream-composer.is-message-capsule[data-multiline='true'] .composer-input-shell,\n:is(.workstream-screen, .workstream-launch-screen) .workstream-composer.is-message-capsule.has-attachments .composer-input-shell"))
      .toContain('grid-column: 1 / -1;');
  });
});

/**
 * The one fixed thing about **Jump to latest** is its own 30px. It hangs over a
 * composer whose height is the draft's (a queue above the field, an error under
 * it, a message grown to six lines), so the only edge worth measuring from is
 * that composer's top, upwards. `top` measures from the same edge downwards: it
 * reads correctly on a one-line field and sinks the control further into the
 * composer the taller the composer gets, which is the state a reader is most
 * likely to be scrolled away in. jsdom lays nothing out, so no component test
 * can tell the two apart.
 */
describe('jump to latest', () => {
  type Edge = { side: 'top' | 'bottom'; longhands: string[]; boxes: string[]; blocks: string[] };

  const TOP: Edge = { side: 'top', longhands: ['top', 'inset-block-start'], boxes: ['inset'], blocks: ['inset-block'] };
  const BOTTOM: Edge = { side: 'bottom', longhands: ['bottom', 'inset-block-end'], boxes: ['inset'], blocks: ['inset-block'] };
  const PADDING_TOP: Edge = { side: 'top', longhands: ['padding-top', 'padding-block-start'], boxes: ['padding'], blocks: ['padding-block'] };

  /** A shorthand this scan cannot expand, so that it fails rather than passes. */
  const UNREADABLE = '<unreadable to this scan>';

  /**
   * Every rule whose selector names one class, in source order, so a second
   * rule cannot quietly restate what the first one settled. Rules nested in an
   * `@media` block are found the same way `preludes()` finds them: the pattern
   * cannot cross a brace, so the wrapper never matches and its contents do.
   */
  function rulesNaming(className: string): { prelude: string; declarations: string }[] {
    // Not `\b`, which ends a word at a hyphen and would take `.jump-bottom-wide`
    // for the class it is named after.
    const named = new RegExp(`\\.${className}(?![\\w-])`, 'u');
    return [...stylesheet.replace(/\/\*[\s\S]*?\*\//gu, ' ').matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
      .map(([, prelude, declarations]) => ({ prelude: prelude!.trim().replace(/\s+/gu, ' '), declarations: declarations! }))
      .filter(({ prelude }) => named.test(prelude));
  }

  /** A box shorthand's one to four values as `[top, bottom]`, in this app's writing mode. */
  function blockValues(declared: string, count: 2 | 4): [string, string] | null {
    const values = declared.trim().split(/\s+/u);
    // A `calc()` or `var()` brings its own spaces; splitting on whitespace would
    // mis-read it, and mis-reading is what this scan exists to prevent.
    if (values.length > count || values.some((value) => value.includes('('))) return null;
    const [first, second = first, third = first] = values as [string, string?, string?];
    return count === 2 ? [first!, second!] : [first!, third!];
  }

  /**
   * What a rule's declarations leave one edge on, reading them in order: the
   * last declaration to touch that edge wins, which is what makes a longhand
   * after a shorthand visible where matching on the shorthand alone is not.
   * `null` means the rule says nothing about that edge.
   */
  function settlesOn(declarations: string, edge: Edge): string | null {
    let value: string | null = null;
    for (const [, property, declared] of declarations.matchAll(/([a-z-]+)\s*:\s*([^;]+)/gu)) {
      const box = edge.boxes.includes(property!) ? 4 as const : edge.blocks.includes(property!) ? 2 as const : null;
      if (edge.longhands.includes(property!)) value = declared!.trim();
      else if (box) value = blockValues(declared!, box)?.[edge.side === 'top' ? 0 : 1] ?? UNREADABLE;
    }
    return value;
  }

  /** The last value a rule declares for one plain property, or null for none. */
  function declares(declarations: string, property: string): string | null {
    return [...declarations.matchAll(/([a-z-]+)\s*:\s*([^;]+)/gu)]
      .filter(([, declared]) => declared === property)
      .map(([, , value]) => value!.trim())
      .at(-1) ?? null;
  }

  /** Every rule with something to say about one edge, and what it leaves there. */
  function settledEdges(rules: { prelude: string; declarations: string }[], edge: Edge): { prelude: string; value: string }[] {
    return rules
      .map(({ prelude, declarations }) => ({ prelude, value: settlesOn(declarations, edge) }))
      .filter((edged): edged is { prelude: string; value: string } => edged.value !== null);
  }

  it('hangs above the composer rather than a fixed distance into the dock', () => {
    const anchored = rulesNaming('jump-bottom');
    expect(anchored.length).toBeGreaterThan(1);

    // One rule owns the anchor, and it puts the control's own bottom edge on
    // the dock's top edge plus a step of the scale. A second entry here is a
    // later rule restating `bottom`, which would win over it.
    expect(settledEdges(anchored, BOTTOM).map(({ prelude, value }) => `${prelude} { bottom: ${value} }`))
      .toEqual(['.jump-bottom { bottom: calc(100% + var(--space-2)) }']);

    // And nothing measures the control from that same edge downwards again.
    expect(settledEdges(anchored, TOP)
      .filter(({ value }) => value !== 'auto')
      .map(({ prelude, value }) => `${prelude} { top: ${value} }`)).toEqual([]);
  });

  it('stays out of flow, over a dock that is a containing block', () => {
    // `bottom` addresses a containing block, so two things outside the anchor
    // itself decide which box it lands on: the control being positioned at all,
    // and the dock being positioned rather than transparent to the search. Take
    // either away and the declaration keeps its value and changes its meaning.
    expect(rulesNaming('jump-bottom')
      .map(({ prelude, declarations }) => ({ prelude, position: declares(declarations, 'position') }))
      .filter(({ position }) => position !== null)
      .map(({ prelude, position }) => `${prelude} { position: ${position!} }`))
      .toEqual(['.jump-bottom { position: absolute }']);

    const docks = rulesNaming('composer-dock')
      .map(({ prelude, declarations }) => ({ prelude, position: declares(declarations, 'position') }))
      .filter(({ position }) => position !== null);
    expect(docks.length).toBeGreaterThan(1);
    expect(docks.filter(({ position }) => position === 'static').map(({ prelude }) => prelude)).toEqual([]);
  });

  it('keeps the dock edge it measures from the composer\'s own', () => {
    // `bottom: 100%` lands on the dock's padding-box top, so padding there is a
    // gap the control clears as well, silently widening the one it states. The
    // launch docks carry `.launch-dock` and their own padding; the control is
    // not rendered in one, so they are deliberately out of scope here.
    const docks = rulesNaming('composer-dock');
    expect(docks.length).toBeGreaterThan(1);
    expect(settledEdges(docks, PADDING_TOP)
      .filter(({ value }) => !/^0(?:px|rem|em|%)?$/u.test(value))
      .map(({ prelude, value }) => `${prelude} { padding-top: ${value} }`)).toEqual([]);
  });
});

/**
 * The composer is measured from the conversation above it, not from the pane it
 * sits in: it is three quarters of the widest a turn is ever drawn, so the field
 * and the bubbles it produces read as one column. One width serves the settled
 * conversation and both launchers that become one, because the element is the
 * same element across that handoff — it never unmounts, and a width that changes
 * across it moves under the person typing.
 *
 * Nothing in a component test can see any of this: jsdom lays nothing out, and
 * every one of these numbers renders correctly whatever it is. What can be
 * checked here is that the rules are still reading one number rather than four
 * copies of it, and that the row width at which the field gives up its inset is
 * still the pane the design states rather than whatever is left after somebody
 * retunes a dock's gutters.
 */
describe('composer width', () => {
  /** The pane width below which the field takes the whole row. */
  const NARROW_PANE = 600;

  it('takes three quarters of the same cap a turn is drawn to', () => {
    expect(rule(':is(.workstream-screen, .workstream-launch-screen) .composer-stack'))
      .toContain('max-width: var(--composer-width);');
    expect(stylesheet).toContain('--composer-width: calc(var(--turn-width-cap) * .75);');

    // One declaration of the cap, and every turn rule reading it. A literal
    // copied back into any of them is a width that stops moving with the field,
    // and there is no screen on which that reads as a defect rather than as a
    // choice somebody made.
    expect([...stylesheet.matchAll(/--turn-width-cap:/gu)]).toHaveLength(1);
    expect([...stylesheet.matchAll(/max-width: min\(88%, ([^,]+), calc\(100% - 82px\)\)/gu)].map(([, cap]) => cap))
      .toEqual(['var(--turn-width-cap)', 'var(--turn-width-cap)', 'var(--turn-width-cap)']);
  });

  /**
   * The two rows a launcher stacks over its field — the substream banner and
   * the participant chips — are centred siblings of the stack rather than
   * children of it, so each states the measure for itself. That is how the
   * launcher's old 690px came to be written out three times, and how its field
   * came to be a different width from the one the same draft landed in a
   * keystroke later.
   */
  it('gives the rows above the field the same measure', () => {
    for (const selector of ['.substream-launch-banner', '.new-workstream-modifiers']) {
      expect(rule(selector)).toContain('max-width: var(--composer-width);');
    }

    const capped = preludes()
      .flatMap((prelude) => [...(rule(prelude) ?? '').matchAll(/max-width:\s*([^;]*)/gu)]
        .filter(([, value]) => /\b690px\b/u.test(value!))
        .map(([declaration]) => `${prelude} { ${declaration.trim()} }`));

    expect(capped).toEqual([]);
  });

  it('gives the row back to the field below a 600px pane', () => {
    // The query below resolves against the nearest named container, so it is
    // inert — silently, and only at narrow widths — without this. The launchers
    // reach it through the same rule, which is why it names both screens.
    expect(rule(':is(.workstream-screen, .workstream-launch-screen) .composer-dock'))
      .toContain('container: composer-dock / inline-size;');

    const threshold = Number(stylesheet.match(/@container composer-dock \(width < (\d+)px\)/u)?.[1]);

    // A size query reads the container's content box, which is inside the
    // dock's gutters, so the pane is those two gutters wider — and every dock
    // has to state the same gutter or it crosses at a different pane. That is
    // not cosmetic: a launcher whose field changes width on the keystroke that
    // submits it is the defect this arrangement exists to remove, and it hid in
    // a 36px band of pane widths behind a dock that stated 34px sides.
    // Every rule that pads a dock, read from the stylesheet rather than looked
    // up by selector: `rule()` returns the *first* match for a name, and
    // `.workstream-launch-screen:not(.is-launching) > .launch-dock` is written
    // twice — once in a narrow-width media block and once as the rule itself —
    // so a lookup answers for the wrong one and this scan passed over the one
    // dock it exists for. Comments come out too, for the same reason in
    // miniature: a padding preceded by one reads as no padding at all.
    const paddedDocks = [...stylesheet.replace(/\/\*[\s\S]*?\*\//gu, ' ').matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
      .map(([, prelude, declarations]) => ({ prelude: prelude!.trim().replace(/\s+/gu, ' '), declarations: declarations! }))
      .filter(({ prelude }) => /(?:composer|launch)-dock(?![\w-])/u.test(prelude))
      .filter(({ declarations }) => /(?:^|;|\s)padding(?:-[a-z-]+)?\s*:/u.test(declarations));

    // The side value of a `padding` shorthand — index 1 in every form but the
    // one-value one — plus any longhand that states a side on its own.
    const sideValues = (declarations: string): string[] => [
      ...[...declarations.matchAll(/(?:^|;|\s)padding:\s*([^;]+)/gu)]
        .map(([, declared]) => declared!.trim().split(/\s+/u))
        .map((values) => values[values.length === 1 ? 0 : 1]!),
      ...[...declarations.matchAll(/padding-(?:left|right|inline[a-z-]*):\s*([^;]+)/gu)].map(([, value]) => value!.trim()),
    ];

    const gutter = `${(NARROW_PANE - threshold) / 2}px`;
    const stated = paddedDocks.flatMap(({ prelude, declarations }) => sideValues(declarations)
      .map((value) => `${prelude} { padding-inline: ${value} }`));

    // A rule this scan cannot parse fails here rather than passing unexamined.
    expect(paddedDocks.filter(({ declarations }) => sideValues(declarations).length === 0).map(({ prelude }) => prelude))
      .toEqual([]);
    expect(stated.length).toBeGreaterThan(2);
    expect(stated.filter((entry) => !entry.endsWith(`${gutter} }`))).toEqual([]);

    // And the rows above the field come with it, or they stop lining up on the
    // one width where the field is not the box it was centred in.
    const narrow = stylesheet.match(/@container composer-dock \([^)]*\) \{([\s\S]*?)\n\}/u)?.[1];
    for (const selector of ['.composer-stack', '.substream-launch-banner', '.new-workstream-modifiers']) {
      expect(narrow).toContain(selector);
    }
    expect(narrow).toContain('max-width: none;');
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

describe('sidebar layout motion', () => {
  // The rows travel on the box's own interval, restated once on the sidebar so
  // a drag — which snaps the edge to the pointer — turns every one of them off
  // with one override rather than a rule per shape.
  it('spends the collapse motion on the rows, and none of it under a drag', () => {
    expect(rule('.sidebar')).toContain('--sidebar-layout-motion: var(--sidebar-collapse-motion);');
    expect(rule('.sidebar.is-resizing')).toContain('--sidebar-layout-motion: 0s;');
    // A zero interval only stops transitions the drag would start; the ones
    // already running keep their duration unless they lose their property.
    expect(rule('.sidebar.is-resizing *,\n.workstream-context-sidebar.is-resizing *')).toContain('transition-property: none !important;');
    for (const selector of [
      '.app-shell .sidebar .sidebar-list > .sidebar-context-target',
      '.app-shell .sidebar .workstream-row',
      '.app-shell .sidebar .sidebar-group-heading',
      '.sidebar-commandbar .sidebar-search',
      '.sidebar-automation-strip',
    ]) {
      expect(rule(selector), selector).toContain('var(--sidebar-layout-motion)');
    }
  });

  // What the component listens to: a number that travels between the layouts
  // on the aside itself. Unregistered it would switch over at the halfway
  // point, and the events would say the layout had settled 120ms early.
  it('carries a registered number the component hears the layout settle by', () => {
    expect(stylesheet).toMatch(/@property --sidebar-compact \{\n {2}syntax: '<number>';/u);
    // A registration without an initial value is invalid as a whole, and an
    // inherited number would recompute every row's style each frame.
    expect(rule('@property --sidebar-compact')).toContain('inherits: false;');
    expect(rule('@property --sidebar-compact')).toContain('initial-value: 0;');
    expect(rule('.sidebar')).toContain('--sidebar-compact: 0;');
    // On the sidebar itself, so the signal fires wherever it is rendered, and
    // restated on the shell's rule beside the workspace-switch fade.
    expect(rule('.sidebar')).toContain('transition: --sidebar-compact var(--sidebar-layout-motion);');
    expect(rule('.sidebar.is-compact')).toContain('--sidebar-compact: 1;');
    expect(rule('.workspace-shell .sidebar')).toContain('--sidebar-compact var(--sidebar-layout-motion)');
    // Under reduced motion the fade goes and the channel stays — as the whole
    // shorthand, since `transition-property` alone would pair the channel
    // with the fade's 220ms and end the signal before the layout has.
    const reduced = stylesheet.slice(stylesheet.indexOf('@media (prefers-reduced-motion: reduce) {\n  /* The fade goes'));
    expect(reduced.slice(0, reduced.indexOf('}\n}'))).toContain('.workspace-shell .sidebar { transition: --sidebar-compact var(--sidebar-layout-motion); }');
  });

  // The titles are faded and clipped rather than hidden, so they can travel;
  // `visibility` on the same interval is what takes them out of the
  // accessibility tree when the fade ends.
  it('keeps the rail\'s hidden copy in layout and takes it out of the tree by visibility', () => {
    const title = rule('.app-shell .sidebar.is-compact .workstream-row .sidebar-row-main');
    expect(title).toContain('opacity: 0;');
    expect(title).toContain('visibility: hidden;');
    expect(title).not.toContain('display: none');
    expect(rule('.app-shell .sidebar .workstream-row .sidebar-row-main')).toContain('visibility var(--sidebar-layout-motion)');
  });

  // The work-stream sidebar restates the interval and travels the same way,
  // with the substream's two marks stacked in one cell so they can cross-fade
  // and nothing centred by `justify-content`, which cannot travel.
  it('travels the work-stream sidebar\'s contents on the same interval', () => {
    expect(rule('.workstream-context-sidebar')).toContain('--sidebar-layout-motion: var(--sidebar-collapse-motion);');
    expect(rule('.workstream-context-sidebar.is-resizing')).toContain('--sidebar-layout-motion: 0s;');
    for (const selector of [
      '.workstream-context-scroll',
      '.workstream-context-row',
      '.workstream-context-copy',
      '.workstream-context-section',
      '.workstream-context-section h2',
      '.workstream-substream-arrow',
      '.workstream-substream-initial',
      '.workstream-context-sidebar .sidebar-collapse-footer',
    ]) {
      expect(rule(selector), selector).toContain('var(--sidebar-layout-motion)');
    }
    expect(rule('.workstream-context-mark > *')).toContain('grid-area: 1 / 1;');
    expect(rule('.workstream-substream-initial')).toContain('visibility: hidden;');
    expect(rule('.workstream-context-sidebar.is-compact .workstream-substream-initial')).toContain('visibility: visible;');
    expect(rule('.workstream-context-sidebar.is-compact .workstream-context-mark:has(> .workstream-substream-initial) > .workstream-substream-arrow')).toContain('visibility: hidden;');
    expect(rule('.workstream-context-sidebar.is-compact .workstream-context-copy')).not.toContain('display: none');
    expect(rule('.workstream-context-sidebar.is-compact .workstream-context-row')).not.toContain('justify-content');
    expect(rule('.workstream-context-sidebar.is-compact .sidebar-collapse-footer')).toContain('padding: 8px 32.5px 8px 8px;');
  });

  // The strip stays a horizontally scrolling row in the rail: a column inside
  // the scroll box was the earlier answer, and it took the strip away from the
  // bottom where the full sidebar keeps it.
  it('keeps the Sidekick strip horizontal and below the list in the rail', () => {
    expect(rule('.app-shell .sidebar.is-compact .sidebar-automation-strip')).not.toContain('flex-direction');
    expect(rule('.sidebar-automation-strip')).toContain('overflow-x: auto;');
    expect(rule('.app-shell .sidebar.is-compact .sidebar-automation-strip > .sidebar-context-target')).toContain('flex-basis: 54px;');
  });

  it('traces the new-Sidekick hexagon in viewBox units, so it scales with the tile', () => {
    // A pixel stroke would hold its width while the tile shrank from 60px to the
    // rail's 36px, so the outline would thicken relative to the shape it traces.
    const slot = rule('.sidekick-new-glyph .automation-glyph-shape');
    expect(slot).toContain('stroke-width: 3;');
    expect(slot).not.toMatch(/stroke-width:[^;]*px/u);
    expect(slot).toContain('stroke-dasharray:');
  });

  it('draws that outline in an ink token, because it is the mark rather than a divider', () => {
    // The border ramp is built for lines beside content and has no headroom for
    // the 3:1 a graphical object needs: against `surface-default`,
    // `border-strong` measures 1.38:1 light and 1.44:1 dark, where `text-muted`
    // is 5.35:1 and 7.99:1. This outline is the entire new-Sidekick mark — at
    // the rail's 36px it is all that distinguishes the tile — so it takes the
    // ink token the plus inside it already uses.
    const slot = rule('.sidekick-new-glyph .automation-glyph-shape');
    expect(slot).toContain('stroke: var(--av-sys-color-text-muted);');
    expect(slot).not.toMatch(/stroke:\s*var\(--av-sys-color-border-/u);
    expect(rule(
      '.sidebar-row.automation-tile:hover .sidekick-new-glyph .automation-glyph-shape,\n'
      + '.sidebar-row.automation-tile:focus-visible .sidekick-new-glyph .automation-glyph-shape',
    )).toContain('stroke: var(--av-sys-color-text-subtle);');
  });
});

describe('work-stream context sidebar layout', () => {
  // The colour is the substance of the mark, not a detail of it: the arrow is
  // the only thing on a substream row that says the row is a substream, and
  // the 10% sidebar-border token this rule used to carry left it a smudge
  // beside a title drawn in full ink. Naming the rejected token as well as the
  // required one is what makes the revert fail here rather than in a window.
  it('draws the substream arrow in muted text rather than the sidebar rule token', () => {
    expect(rule('.workstream-substream-arrow')).toContain('color: var(--av-sys-color-text-muted);');
    expect(rule('.workstream-substream-arrow')).not.toContain('var(--av-cmp-sidebar-border)');
  });

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
    ['.workstream-launch-screen.is-launching .workstream-composer', ['background', 'border-color', 'border-radius']],
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
    // Two numeric tracks — the search row and the rail's New chat slot — so
    // the slot can open and close over the layout motion.
    expect(commandbar).toContain('display: grid;');
    expect(commandbar).toContain('grid-template-rows: 32px 0px;');
    // The list motion draws a removed row's stand-in in this box.
    expect(commandbar).toContain('position: relative;');
    expect(rule('.app-shell .sidebar.is-compact .sidebar-commandbar')).toContain('grid-template-rows: 54px 54px;');
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
      '.human-message .mention-chip',
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

/**
 * The microphone had both faults a state-on-a-shape can have. Its recording red
 * was set once, on the shared control, and then silently overpainted in the
 * message capsule by two shape rules carrying two more classes; and its resting
 * fill named `cmp.row.background-selected`, which `html[data-personal-color]`
 * rewrites into the member's own accent, so the one control in the composer
 * wearing a personal colour looked deliberate to anyone whose account had none.
 *
 * Neither is visible in a DOM assertion and neither is visible in a screenshot
 * taken by the seeded local account, so they are guarded here: the shape rules
 * must keep standing down while recording, and no rule reaching the microphone
 * may name a token the account accent rewrites.
 */
describe('dictation button recording state', () => {
  // The seven the account accent re-points, plus the selection fill. That fill
  // is no longer re-pointed — the microphone wearing a member's colour is what
  // got the re-point removed — but a microphone is not a selection either, so
  // it stays banned here on the reason that outlives the accent.
  const NOT_THE_MICROPHONE_S = [
    '--av-cmp-row-background-selected',
    '--av-sys-color-accent-base',
    '--av-sys-color-accent-strong',
    '--av-sys-color-accent-soft',
    '--av-sys-color-accent-wash',
    '--av-sys-color-accent-edge',
    '--av-sys-color-accent-tint',
    '--av-sys-color-accent-on',
  ];

  it('fills with danger and takes the ink that pairs with it', () => {
    const recording = rule('.microphone-control.is-listening .dictation-button');
    expect(recording).toContain('background: var(--av-sys-color-danger-base);');
    expect(recording).toContain('color: var(--av-sys-color-danger-on);');
  });

  it('lets no rule paint the button while it is recording except that one', () => {
    // Order matters here, and it is the whole point. `':not(.is-listening)'`
    // contains `'.is-listening'` as a substring, so skipping every prelude that
    // merely mentions the state would exempt the over-specified rules this
    // guard exists to catch — a capsule rule spelled *with* `.is-listening`
    // rather than around it out-specifies the state rule exactly as the one
    // that omits it. Only two preludes may paint: the state rule itself, and a
    // shape rule that has stood down with `:not(…)`.
    const STATE_RULE = '.microphone-control.is-listening .dictation-button';
    const offenders: string[] = [];

    for (const [, selector = '', body = ''] of stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      const prelude = selector.replace(/\/\*[\s\S]*?\*\//gu, ' ').trim();
      if (!prelude.includes('.dictation-button')) continue;
      if (!/(?:^|;|\s)(?:background|color):/u.test(body)) continue;
      if (prelude === STATE_RULE) continue;
      if (prelude.includes(':not(.is-listening)')) continue;
      offenders.push(prelude);
    }

    expect(offenders).toEqual([]);
  });

  it('gives the microphone no fill that carries identity or selection', () => {
    const offenders: string[] = [];

    for (const [, selector = '', body = ''] of stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      const prelude = selector.replace(/\/\*[\s\S]*?\*\//gu, ' ').trim();
      if (!/\.(?:dictation-button|microphone-control|microphone-menu-trigger)\b/u.test(prelude)) continue;

      for (const token of NOT_THE_MICROPHONE_S) {
        if (body.includes(token)) offenders.push(`${prelude} { ${token} }`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

// These rows were built for the home screen's Needs attention section and are
// now the project space's, which renders three of the six tracks. The project
// and source rules below are dead until something fills those tracks again; the
// geometry is asserted whole because the template is what keeps the chevrons on
// one right edge. See docs/workstream-markers.md.
describe('Work-stream row geometry', () => {
  it('keeps the marker dot at its size, and clips a label the track cannot hold', () => {
    // The dot is a flex item beside the label, so it is what gives way when a
    // label outgrows the row's fixed first column. Four of the nine labels
    // outgrew the 112px this track used to be, and the widest two shrank the
    // dot to nothing — rows showing no marker at all. The track now fits the
    // widest, the dot refuses to shrink, and the label ellipsizes so the next
    // one to outgrow it clips where somebody can see it rather than sliding
    // under the title. See docs/workstream-markers.md.
    expect(rule('.status-dot')).toContain('flex: 0 0 auto;');
    expect(rule('.waiting-workstream-row .status-indicator > span'))
      .toContain('text-overflow: ellipsis;');
  });

  it('reserves a project slot and pins time and chevron to stable columns', () => {
    expect(rule('.waiting-workstream-row')).toContain(
      'grid-template-columns: 130px auto minmax(0, 1fr) auto auto 15px;',
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
/**
 * A keycap is a label, not a selection.
 *
 * It got its own fill because `onboarding.css` re-pointed
 * `cmp.row.background-selected` at the reader's account accent, which printed
 * A, B, C, D on pale blue chips. That re-point is gone now and the two tokens
 * hold the same value, so this no longer guards a colour — it guards the
 * coupling. `cmp.row.background-selected` is the fill a *selection* takes, and
 * the registry's own entry says a theme may set it to `transparent` and mark
 * selection with the marker alone. A keycap that followed it would disappear
 * on that theme, having never been a selection in the first place. Naming the
 * rejected token as well as the required one is what makes a revert fail here
 * rather than in somebody's window.
 */
describe('option keycaps', () => {
  it('fills the letter from the keycap token, not the selected row', () => {
    const keycap = rule('.app-shell .elicitation-option > kbd');
    expect(keycap).toContain('background: var(--av-cmp-keycap-background);');
    expect(keycap).not.toContain('var(--av-cmp-row-background-selected)');
  });

  /**
   * And the row underneath still draws from the selection fill. Lifting the
   * keycap off that token is a split, not a removal; a change that took the
   * whole panel off it would pass the assertion above on its own.
   */
  it('leaves the selected option itself drawn in the selection fill', () => {
    expect(rule('.app-shell .elicitation-option.is-selected,\n.app-shell .elicitation-option.is-selected:hover'))
      .toContain('background: var(--av-cmp-row-background-selected);');
  });
});

/**
 * The feed's spacing is one scale. A literal that slips back into a feed rule
 * renders correctly and stays invisible until somebody moves `ref.space.unit`
 * and one gap does not move with it, which is how the feed accumulated every
 * integer from 1px to 18px before the scale existed. Values under a step are
 * allowed: they are optical nudges inside inline controls, not gaps.
 */
describe('feed spacing is a step of the scale', () => {
  const FEED = /message-block|transcript-event|human-message|agent-message|tool-|work-accordion|agent-work-timing|elicitation|system-message|markdown|attachment|citation|transcript-column|unread-divider|virtual-message|activity-presence|run-failure|run-stopped|assistant-turn|message-delivery-pill|message-attachments|plugin-/u;
  // Not the feed: the lightbox over it, the composer under it, the automation
  // overview and the document surfaces that host `.markdown-body` too.
  const NOT_FEED = /lightbox|gallery|composer|pending-attachment|automation-|note-|meeting-|sidekick|settings|inspector|onboarding|new-chat-screen|message-delivery-controls/u;
  // Values that are not gaps, each with the reason it stays literal.
  const EXEMPT: Record<string, string> = {
    '.transcript-column': 'the 150px is clearance under an overlaid composer, a height rather than a gap',
    '.system-message-dot': 'centres a 4px dot on the cap height of the line beside it',
    // Inline chips: their padding sizes the chip to the line it sits in.
    '.citation-chip': 'inline chip',
    '.citation-identity-card': 'inline identity chip',
    '.markdown-body .citation-connector-status': 'inline status pill on a connector card',
    '.app-shell .elicitation-option > kbd': 'the key cap beside an option',
  };

  /**
   * The narrow breakpoint has to out-specify the work stream's own column rule,
   * which is two classes deep; a shared `.transcript-column` rule inside the
   * media query is inert on that screen however late it sits. The step is the
   * 24px one: the collapse chevrons hang 20px outside the column and their
   * focus ring reaches 3px further, so anything under 23px clips them.
   */
  it('keeps the narrow column padding on the work stream at the 24px step', () => {
    // Anchored on the rule's own comment: the work stream's column rule outside
    // the media query shares the selector, and matching by selector alone finds
    // that one first.
    const narrow = stylesheet.match(/Restated for the work stream[\s\S]*?\.workstream-screen \.transcript-column \{([^}]*)\}/u)?.[1];
    expect(narrow).toContain('padding-left: var(--space-6);');
    expect(narrow).toContain('padding-right: var(--space-6);');
    expect(stylesheet).toContain('--space-6: calc(var(--av-ref-space-unit) * 6);');
  });

  /**
   * The two launch surfaces render `MessageBlock` and `AgentWorkTiming`
   * outside `.virtual-message-row`, where the row rhythm cannot reach them
   * and the base rules now give a row no margin. Review found their rows
   * stacked flush; these are the gaps they state for themselves.
   */
  it('spaces the launch surfaces\' rows, which sit outside the feed wrapper', () => {
    expect(rule('.substream-branch-context > * + *,\n.launch-arrival + .launch-arrival')).toContain('margin-top: var(--av-sys-space-block-gap);');
    expect(rule('.substream-branch-context > .message-block + .message-block,\n.substream-branch-context + .launch-arrival')).toContain('margin-top: var(--av-sys-space-stack-gap);');
  });

  /**
   * The feed keys each row's margin on the gap `MessageFeed` stamps, and each
   * stamped gap reaches its own token. The seam is the one to watch: a
   * stamped row with no rule takes no margin at all, which would look like a
   * tightening rather than a missing rule, and the seam is exactly the row
   * that must not read as tight.
   */
  it('keys every stamped row gap on its own token', () => {
    for (const gap of ['stack', 'seam', 'block', 'event']) {
      expect(rule(`.virtual-message-row[data-row-gap='${gap}'] > .message-arrival-layer > :first-child`))
        .toContain(`margin-top: var(--av-sys-space-${gap}-gap);`);
    }
  });

  it('carries no literal spacing of a step or more in a feed rule', () => {
    const offenders = preludes()
      .filter((prelude) => FEED.test(prelude) && !NOT_FEED.test(prelude) && !(prelude in EXEMPT))
      .flatMap((prelude) => [...(rule(prelude) ?? '').matchAll(/(?:margin|padding|gap|row-gap|column-gap)[a-z-]*\s*:\s*([^;]*)/gu)]
        .filter(([, value]) => [...value!.matchAll(/(-?\d+(?:\.\d+)?)px/gu)].some(([, px]) => Math.abs(Number(px)) >= 4))
        .map(([declaration]) => `${prelude} { ${declaration.trim()} }`));

    expect(offenders).toEqual([]);
  });
});

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
    expect(rule('.agent-message .markdown-body'))
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
    expect(shared).toContain('font-size: var(--av-cmp-feed-byline-font-size)');
    expect(shared).toContain('color: var(--av-sys-color-text-muted)');
    // Neither may carry a size, weight, or colour of its own anywhere else, or
    // the two stop matching without either rule looking wrong on its own.
    const strays = preludes().filter((prelude) => prelude.includes('.message-work-summary')
      && prelude !== '.message-block time,\n.message-block .message-work-summary');
    expect(strays).toEqual([]);
  });

  /**
   * One byline for every turn, whoever is speaking. The name and the time used
   * to be painted four times over — a base pair, an `.agent-message` pair that
   * added the navigation label's small capitals and a 0.7 opacity, and a
   * work-stream pair per speaker — so Rally's turn and a person's carried
   * different sizes, weights and greys for the same two facts, and neither rule
   * looked wrong beside the others. What separates the speakers is the accent
   * on the dot, which is the one thing a per-speaker rule may still say.
   */
  it('paints the name and the time once, not once per speaker', () => {
    const speakerScoped = preludes().filter((prelude) => /\.(agent|human)-message/u.test(prelude)
      && /(\.message-author\b|\btime\b)/u.test(prelude)
      && !prelude.includes('.message-author-dot'));
    expect(speakerScoped).toEqual([]);
    // The name resolves through the byline tokens rather than through the
    // accent, so a bright personal hue cannot decide whether it is readable.
    const author = rule('.message-author');
    expect(author).toContain('color: var(--av-sys-color-text-subtle);');
    expect(author).toContain('font-size: var(--av-cmp-feed-byline-font-size);');
    expect(author).toContain('font-weight: var(--av-cmp-feed-byline-author-weight);');
    expect(author).not.toContain('--person-accent');
    // Three parts, one type size. The context label used to carry a third,
    // fitted against a timestamp size that no longer exists.
    expect(rule('.message-context-label')).toContain('font-size: var(--av-cmp-feed-byline-font-size);');
    expect(rule('.message-block time,\n.message-block .message-work-summary'))
      .toContain('font-weight: var(--av-cmp-feed-byline-time-weight);');
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

  /**
   * The person's slot holds its height with nothing in it. It is laid out on
   * every person's turn, control or not, because the one-unit turn gap relies
   * on it to keep the next turn off the bubble; an empty flex row is 0px tall,
   * and a turn without the control would otherwise hand the next turn a 4px
   * clearance on the surfaces that cannot start a substream.
   */
  it('holds the person’s action slot at its height when it is empty', () => {
    expect(rule('.human-message-actions')).toContain('min-height: var(--space-5);');
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
    const block = rule('.human-message');
    expect(block).toContain('--turn-bubble-radius:');
    expect(rule('.human-message-bubble'))
      .toContain('border-radius: var(--turn-bubble-radius);');
    expect(rule('.human-message > header'))
      .toContain('padding-inline-end: var(--turn-bubble-radius);');
    expect(rule('.human-message .human-message-actions'))
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
    // The theme rule out-specifies the base rule now that the base is
    // un-scoped, but it is still asserted to follow it: a base rule that moved
    // below the theme's would read as the override and be edited as one.
    expect(stylesheet.indexOf('.workstream-screen .human-message {'))
      .toBeGreaterThan(stylesheet.search(/^\.human-message \{/mu));
    expect(rule('.workstream-screen .human-message-bubble'))
      .toContain('border-radius: var(--turn-bubble-radius);');
    // On the value, not one spelling of the property: a literal creeping back
    // as `padding-inline-end: 18px` — a spelling this file does use, and so a
    // likely regression — would pass a check that only banned `padding-right`.
    // `padding-inline` is in the pattern for the same reason: it sets the
    // trailing inset as surely as either, and it is the logical spelling the
    // stylesheet actually reaches for.
    // The theme no longer restates anything on the header: the one
    // declaration it carried, a margin a pixel off the shared rule's, went
    // with the feed's move to one spacing scale. A theme rule on the header is
    // where a literal inset would creep back in, so its absence is what is
    // asserted, and the shared rule is checked to carry the inset by token.
    expect(rule('.workstream-screen .human-message > header')).toBeNull();
    expect(rule('.human-message > header'))
      .not.toMatch(/padding(?:-right|-inline(?:-end)?)?:\s*\d/u);
  });

  /**
   * Rally's turn has no avatar, so nothing occupies a gutter left of its name.
   * The theme inset that header by 18px anyway, which put the identity line on
   * its own vertical while the prose and the action row under it shared the
   * article's own edge — a hanging indent over an empty gutter. Held on the
   * value rather than on one spelling. `padding-inline` is the one that matters
   * most here: it is the logical spelling this stylesheet actually uses
   * (`padding-inline-start` appears nowhere in it), and `padding-inline: 18px 0`
   * reads as a horizontal pair rather than as a leading inset while setting
   * exactly the one that was removed. A trailing inset stays allowed, since
   * `padding-inline-end` is what the human header opposite uses.
   *
   * The assistant now states nothing of its own about its header at all: the
   * shared rule is the only one, and this asserts on it, because a leading
   * inset arriving there would put *every* byline on its own vertical rather
   * than just Rally's.
   */
  it('starts the assistant identity line on the same vertical as its prose', () => {
    expect(rule('.workstream-screen .agent-message > header')).toBeNull();
    expect(rule('.agent-message > header')).toBeNull();
    expect(rule('.message-block > header'))
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

/**
/*
 * The search modal is a fixed frame over shifting contents.
 *
 * A reader retries a failed continuation by clicking a button that is only
 * there because the continuation failed. If that footer adds to the modal's
 * flow height, the modal grows under the pointer as the message arrives and
 * shrinks again when the retry succeeds, moving the box, its shadow and its
 * centred position while the reader is aiming at it. jsdom lays nothing out,
 * so no component test can tell a footer that divides a fixed body from one
 * that extends the modal; both render the same DOM.
 */
describe('workspace search modal geometry', () => {
  it('divides one fixed body between the list and its pagination footer', () => {
    const body = rule('.rally-search-body');
    const results = rule('.rally-search-results');
    const footer = rule('.rally-search-footer');

    expect(body).not.toBeNull();
    expect(body).toContain('height: 360px;');
    expect(body).toContain('display: flex;');
    expect(body).toContain('flex-direction: column;');
    // The list gives the footer its room rather than the modal finding more.
    expect(results).toContain('flex: 1;');
    // Either of these lets it shrink below its rows: a scroll container's
    // automatic minimum size is already zero, and `min-height` says so outright.
    // Both are pinned, so a change has to mean to drop the pair.
    expect(results).toContain('overflow-y: auto;');
    expect(results).toContain('min-height: 0;');
    expect(results).not.toMatch(/(?<![-\w])height:/u);
    expect(footer).toContain('flex-shrink: 0;');
    // The other conditional child never occupies flow at all.
    expect(rule('.rally-search-state')).toContain('position: absolute;');
  });
});

/*
 * The live artifact detail is the surface that showed why the GrokBot rules
 * being scoped to `.app-shell` is a real constraint rather than a tidy detail:
 * it renders through a Radix portal, which mounts on `document.body`, so it
 * missed every one of them and drew the pre-rewrite bordered-card family
 * instead. The grouping primitive it now uses is unscoped for that reason, and
 * the pane's corner is shared with a native view that CSS cannot reach.
 */
describe('the shared shell primitives and the artifact pane', () => {
  it('leaves the primitives unscoped, so a portal gets them without a shell ancestor', () => {
    expect(rule('.inset-surface')).not.toBeNull();
    const scoped = preludes().filter((prelude) => /\.app-shell[^,]*\.inset-surface\b/u.test(prelude));
    expect(scoped).toEqual([]);
  });

  it('draws no edge of its own around the page, and no gutter around the pane', () => {
    // The border and the corner the pane used to carry were a second frame
    // inside the lightbox's own, around content that already fills it.
    const pane = rule('.site-detail-pane');
    expect(pane).not.toContain('border:');
    expect(pane).not.toContain('border-radius');
    expect(rule('.resource-lightbox .rail-scroll:has(> .site-detail)')).toContain('padding: 0');
  });

  it('leaves the page square inside chrome that is not', () => {
    // The lightbox is Rally's frame and keeps its corner. The viewer inside it
    // is the page itself, and a page does not get rounded by the thing holding
    // it: the composited view is square, which means nothing in the main
    // process may round it either. CSS cannot reach that view, so this is
    // where the two halves are kept in agreement. Read from disk for the
    // reason at the top of this file.
    expect(rule('.attachment-lightbox.is-document-viewer')).toContain('border-radius:');
    expect(rule('.site-detail-pane')).not.toContain('border-radius');

    const main = readFileSync(resolve(process.cwd(), 'src/main/artifact-viewers.ts'), 'utf8');
    expect(main).not.toContain('setBorderRadius');
  });
});
