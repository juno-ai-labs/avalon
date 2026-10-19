import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolvedThemes, themeWindowBackground } from '../../common/themes';

// Read from disk because Vite hands
// `?raw` an empty string for a file it is already processing as CSS. This file
// is typed by `tsconfig.node.json` so that `node:fs` stays out of the renderer
// program.
const app = readFileSync(resolve(process.cwd(), '../../packages/ui/src/styles/app.css'), 'utf8');

/**
 * The design-token JSON, two directories up at the repository root. It is the
 * source of truth for what a token is and what each theme sets; `themes.css` is
 * generated from it, and `scripts/build-theme-assets.test.mjs` holds the two
 * together. What is left for this file is the half that JSON cannot see: how
 * `app.css` and the main process use the vocabulary.
 */
const tokensDirectory = resolve(process.cwd(), '../../config/design-tokens');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const registry = readJson<{ tokens: Record<string, { $type: string }> }>(
  join(tokensDirectory, 'registry.json'),
);
const baseFile = readJson<{ tokens: Record<string, string> }>(join(tokensDirectory, 'base.json'));
const themeFiles = readdirSync(join(tokensDirectory, 'themes'))
  .filter((entry) => entry.endsWith('.json'))
  .map((entry) => readJson<{ id: string; tokens: Record<string, string> }>(
    join(tokensDirectory, 'themes', entry),
  ));

/** The custom property a token path is written to; mirrors the generator. */
function customProperty(path: string): string {
  return `--av-${path.replace(/\./gu, '-')}`;
}

const declared = new Set(Object.keys(registry.tokens).map(customProperty));

/**
 * The one value written down twice. The main process needs a window's
 * background before any renderer exists to ask, so it cannot read a stylesheet;
 * this is what stops the copy drifting from the original.
 */
/**
 * The inverse of "names only tokens the registry declares": every token the
 * registry declares is read by something. A token nothing reads still costs
 * three declarations and a line in the generated file, and the set had grown
 * twenty-four of them (a retired turn-alignment trio, sixteen connector fills
 * the masks replaced, three state colours) before this existed.
 *
 * A reader is a source file naming the custom property or the dotted path, a
 * token file aliasing it, or one of the two places that read by prefix:
 * `workstream-glyph.tsx` and its neighbours build `--av-sys-color-project-<key>`
 * from a palette key, `markColors()` builds a mark's `project-tint-<key>` and
 * `project-ink-<key>` the same way, and the build script exports every `sys.color.syntax.*`
 * for the message exporter.
 */
describe('every token has a reader', () => {
  const READ_BY_PREFIX = ['sys.color.project.', 'sys.color.project-tint.', 'sys.color.project-ink.', 'sys.color.syntax.'];

  it('is named by a source file, aliased by a token file, or read by prefix', () => {
    const sources: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(tsx?|css)$/u.test(entry.name) && !entry.name.includes('.test.') && entry.name !== 'themes.css') {
          sources.push(readFileSync(path, 'utf8'));
        }
      }
    };
    walk(resolve(process.cwd(), 'src'));
    walk(resolve(process.cwd(), '../../packages/ui/src'));
    sources.push(readFileSync(resolve(process.cwd(), '../../scripts/build-theme-assets.mjs'), 'utf8'));
    const corpus = sources.join('\n');
    const aliased = new Set<string>();
    for (const file of [baseFile, ...themeFiles]) {
      for (const [, target] of JSON.stringify(file.tokens).matchAll(/\{([a-z0-9.-]+)\}/gu)) aliased.add(target!);
    }
    const unread = Object.keys(registry.tokens).filter((path) =>
      !corpus.includes(customProperty(path))
      && !corpus.includes(`'${path}'`)
      && !aliased.has(path)
      && !READ_BY_PREFIX.some((prefix) => path.startsWith(prefix)));

    expect(unread).toEqual([]);
  });
});

describe('window background', () => {
  it.each(resolvedThemes.map((theme) => [theme] as const))('matches the %s theme’s own canvas', (theme) => {
    const file = themeFiles.find((candidate) => candidate.id === theme);

    expect(file?.tokens['sys.color.surface.canvas']).toBe(themeWindowBackground[theme]);
  });
});

/**
 * Every `var()` in the stylesheet names a token the registry declares.
 *
 * A custom property that resolves to nothing is the quietest failure in CSS:
 * the declaration is dropped and the element keeps whatever it inherited, which
 * usually looks almost right. With about 1,300 references and names as long as
 * `--av-sys-color-surface-raised-hover`, a transposition is a matter of time,
 * and nothing else in the build would say a word about it.
 */
describe('token references', () => {
  // Properties the stylesheet defines for its own use rather than taking from a
  // theme. Each is set by a rule in this same file.
  const RULE_LOCAL = ['--attachment-file-card-height', '--attachment-media-size', '--rail-slot',
    // Runtime layout geometry, not theme-selectable design tokens.
    '--rail-max-slot',
    '--composer-line-height', '--composer-text-padding', '--system-message-lines',
    '--av-cmp-sidebar-width',
    // Deliberately outside the `--av-` namespace, unlike its neighbour above:
    // `--av-cmp-sidebar-width` is a registry token a theme may set and is here
    // only because the resize handle also writes it inline, while this one is
    // the platform's window-chrome geometry, which no theme has an opinion
    // about and the registry does not declare.
    '--window-controls-inset',
    // The band a screen leaves for the window's title bar to be dragged by,
    // stated once so the drag strip and whatever must clear it, the project
    // space's connecting card, measure the same figure. Platform geometry,
    // like the inset above; no theme has an opinion about it.
    '--screen-drag-strip-height',
    // Also outside the `--av-` namespace, and for the same reason: how long a
    // sidebar takes to reach its collapsed width is the shell's behaviour, not
    // a theme's palette. It is stated once in `app.css` so both sidebars spend
    // the same figure.
    '--sidebar-collapse-motion',
    // How wide every draggable edge is to the pointer: the sidebar's, the right
    // panel's and the split divider's. Shell geometry, the same in every theme.
    '--resize-hit-size',
    // The navigation's own two: the interval its contents spend travelling
    // between its layouts, which is the collapse motion unless a drag has
    // turned it off, and the number that travels over it so the component
    // can hear the layout settle. Neither is a theme's to set.
    '--sidebar-layout-motion', '--sidebar-compact',
    // The first rail's current width and its shared collapse interval. The
    // shell owns both as layout geometry, not as theme choices.
    '--spaces-sidebar-width',
    // Near and far fade lengths on a scroller that clips its items. Registered
    // so they interpolate as lengths; a theme has no opinion about them.
    '--clipped-scroll-fade-start', '--clipped-scroll-fade-end',
    '--turn-bubble-radius',
    // The one hover wash, spelled as a paint layer so it composites over a
    // control's own surface instead of replacing it. It is derived from
    // `sys.color.state.hover`, which the registry does declare; a theme sets
    // the colour and this states how it is applied, which is not a theme's to
    // choose.
    '--hover-layer',
    // Markdown's paint, named as a group on `.markdown-body` and re-pointed by
    // a surface that fills itself — the person's bubble, whose fill is
    // near-black or a profile colour and whose ink is whichever absolute one
    // the palette picked for it. The defaults below are the appearance's own
    // tokens; what a theme has no opinion about is which of them a surface
    // that paints itself should be using instead, which is why these are the
    // stylesheet's rather than the registry's.
    '--markdown-ink', '--markdown-ink-strong', '--markdown-ink-quiet',
    '--markdown-ink-muted', '--markdown-ink-faint', '--markdown-wash',
    '--markdown-surface', '--markdown-rule', '--markdown-quote-bar',
    '--markdown-border', '--markdown-link', '--markdown-link-hover',
    '--markdown-mark', '--markdown-scrollbar-thumb',
    // The in-flight sweep's band, a twentieth of the surface's own ink: it is
    // derived from `currentColor` on the surface it paints, so one rule reads
    // light on a dark or profile-coloured bubble and dark on a light card. A
    // decision about the surface it sits on, not a theme's palette.
    '--sweep-ink',
    // The widest a turn is ever drawn, and the field beneath it, which is a
    // fraction of that: the feed's layout arithmetic — the measure a column of
    // conversation is built from — rather than an appearance either theme
    // states differently. The second is read by four rules, which is why it is
    // named rather than repeated.
    '--turn-width-cap', '--composer-width',
    // The empty composer's height and the gap under it, and the insets the
    // dividers between panels take from them and from the title pill: layout
    // arithmetic shared by the dock, the capsule and the dividers.
    '--composer-dock-gap', '--composer-capsule-height',
    '--panel-divider-inset-top', '--panel-divider-inset-bottom',
    // The count wheel reverses its travel when the value decreases. This is
    // local animation geometry, independent of the selected theme.
    '--wheel-travel',
    // The phone layout's sheet header and top-bar heights and sheet motion:
    // geometry and timing of one responsive block, the same in every theme.
    '--phone-sheet-header-height', '--phone-top-bar-height', '--phone-sheet-duration', '--phone-sheet-motion',
    // The Settings header's height, which the phone sections sheet starts under.
    '--settings-header-height',
    // The width a title menu level may take: what Radix reports as available,
    // less the frame's padding. Layout arithmetic, the same in every theme.
    '--title-menu-room',
    // The feed's spacing steps, each a multiple of the one `ref.space.unit`
    // token; the multiples are the stylesheet's, not a theme's.
    '--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-7', '--space-8',
    // The section switcher's width, which the main window centres the macOS
    // traffic lights over: layout, the same in every theme.
    '--navigation-rail-width',
    // The ring behind a tile's badge, set by each sidebar row to its own
    // background so the badge reads as cut out of the tile.
    '--tile-ring'];

  // Set at runtime rather than in CSS: some by components as inline styles,
  // three by libraries on their own elements. They cannot be checked from this
  // file, so they are listed to say they were considered.
  const RUNTIME = [
    // Trusted SVG cursor shared by annotation preview transports.
    '--annotation-cursor', '--rail-width', '--person-accent', '--person-dot',
    // Set per glyph from PALETTE_INK, which is a decision about a fill rather
    // than about the appearance, so it cannot be a theme token.
    '--glyph-ink',
    '--markdown-table-columns', '--arrival-index',
    '--conversation-min-width',
    '--citation-card-played',
    // The open Breakout's pane width, set by SplitConversationLayout from the
    // width the reader dragged it to.
    '--split-breakout-width',
    // How far a pane slides when it takes the whole width or gives it back,
    // measured by SplitConversationLayout at the step.
    '--split-motion-from',
    // How far back an origin-context message sits, set per row by BreakoutOrigin.
    '--origin-step',
    // A picker swatch's ink dot, set per swatch from markColors().
    '--swatch-ink',
    // How far a crowded pane header moves its pill left, set by
    // TitlePillHeader from the gap it measured.
    '--title-pill-shift',
    // The dictation level ring, 0 to 1 from the capture worklet's RMS, written
    // onto the microphone control by the composer while a recording runs.
    '--dictation-level',
    '--radix-dropdown-menu-content-available-height', '--radix-dropdown-menu-content-available-width',
    '--radix-select-content-available-height', '--radix-select-content-transform-origin', '--radix-select-trigger-width'];

  it('names only tokens the registry declares', () => {
    const referenced = new Set(
      [...app.matchAll(/var\((--[a-z0-9-]+)/giu)].map((match) => match[1]!),
    );
    const known = new Set([...declared, ...RULE_LOCAL, ...RUNTIME]);
    const unknown = [...referenced].filter((name) => !known.has(name));

    expect(unknown).toEqual([]);
  });

  it('defines every rule-local property it names', () => {
    for (const name of RULE_LOCAL) {
      expect(app.includes(`${name}:`), `${name} is never defined`).toBe(true);
    }
  });
});
