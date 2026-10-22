import {
  Aperture,
  Atom,
  Boxes,
  CircleDot,
  CircuitBoard,
  Component,
  Dices,
  Orbit,
  Play,
  Sparkles,
  Spline,
  WandSparkles,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { generatedWorkstreamAppearance, type ProjectColorKey, type WorkstreamAppearance as SavedAppearance } from '@rally/contracts';
import clsx from 'clsx';
import { useId } from 'react';
import { markColors } from '../lib/project-palette';
import { APPEARANCE_ICON_COMPONENTS } from './appearance-icons';
import type { IdentityMark } from './identity-tile';

const WORKSTREAM_ICONS = [
  Aperture,
  Atom,
  Boxes,
  CircleDot,
  CircuitBoard,
  Component,
  Dices,
  Orbit,
  Sparkles,
  Spline,
  WandSparkles,
  Workflow,
] as const satisfies readonly LucideIcon[];

/** Every storable key's glyph; see `appearance-icons.ts`. */
export const WORKSTREAM_ICON_COMPONENTS = APPEARANCE_ICON_COMPONENTS;

export interface WorkstreamAppearance {
  color: ProjectColorKey;
  iconIndex: number;
}

/**
 * A work stream without a chosen appearance uses its id as the seed. The result is
 * deliberately deterministic: an identity that changed on every launch would
 * make the sidebar harder to scan even though it looked more random.
 */
export const workstreamAppearance = generatedWorkstreamAppearance;

/** Shared identity symbol for stream glyphs and automation hexagons. */
export function WorkstreamSymbol({ id, size, className }: { id: string; size: number; className?: string }): React.JSX.Element {
  const Icon = WORKSTREAM_ICONS[workstreamAppearance(id).iconIndex] ?? Sparkles;
  return <Icon className={className} size={size} strokeWidth={1.9} />;
}

/**
 * What resolving needs, and no more: a stored icon key this build may not have.
 *
 * `string` rather than the contract's union is the honest type. A key is a
 * stored value, and a client is shipped separately from the catalog it was
 * built against, so "a key I do not know" is a state this function exists to
 * survive rather than one the type system can rule out. The colour stays the
 * union: it is interpolated into a token name, and there is no fallback that
 * would make an arbitrary string safe there.
 */
export interface ResolvableAppearance {
  icon?: string | null;
  color?: SavedAppearance['color'];
}

/** The icon map as a lookup that admits a miss, which is the whole point. */
const ICON_BY_KEY: Record<string, LucideIcon | undefined> = WORKSTREAM_ICON_COMPONENTS;

/**
 * One work stream's appearance resolved to what a component actually renders.
 *
 * Every treatment goes through this — the filled glyph, the bare mark, and
 * whatever comes next — so a stored appearance cannot come out as two different
 * marks in two rails. Resolving it twice is how they drift.
 *
 * The fallback chain is `||` rather than a ternary, and that is the fix rather
 * than a style: written `saved?.icon ? MAP[saved.icon] : ICONS[i] ?? Sparkles`,
 * the ternary binds first and the fallback only ever guards the *generated*
 * branch. A stored key the map lacks then resolves to `undefined`, and React
 * renders an undefined component by throwing `Element type is invalid`, which
 * blanks the window rather than dropping one glyph.
 */
export function resolveWorkstreamAppearance(id: string, saved?: ResolvableAppearance): {
  Icon: LucideIcon;
  /** The palette key itself, for a caller that has to look something up by it. */
  colorKey: ProjectColorKey;
  /** That key as the hue itself, for a caller that draws the official colour. */
  color: string;
  /** The mark's pastel background and the icon on it; see `markColors`. */
  tint: string;
  ink: string;
  bare: string;
} {
  const generated = workstreamAppearance(id);
  const colorKey = saved?.color ?? generated.color;
  return {
    Icon: (saved?.icon ? ICON_BY_KEY[saved.icon] : undefined)
      || WORKSTREAM_ICONS[generated.iconIndex]
      || Sparkles,
    colorKey,
    color: `var(--av-sys-color-project-${colorKey})`,
    ...markColors(colorKey),
  };
}

/** A thread or a Breakout as a mark: its symbol in a circle, in its pastel pair. */
export function workstreamMark(id: string, saved?: ResolvableAppearance): IdentityMark {
  const { Icon, tint, ink } = resolveWorkstreamAppearance(id, saved);
  return { shape: 'circle', icon: Icon, tint, ink };
}

/**
 * The work stream's identity as a bare tinted mark, for a surface that already
 * sits inside the work stream. The glyph's filled shape says *which* stream
 * among many, which is the navigation sidebar's job; a rail that only ever
 * shows one stream needs the colour and the symbol, not a second badge.
 */
export function WorkstreamMark({ id, size = 24, appearance: saved }: { id: string; size?: number; appearance?: SavedAppearance }): React.JSX.Element {
  // No tint behind it, so the mark takes the colour that reads on the page.
  const { Icon, bare } = resolveWorkstreamAppearance(id, saved);
  return <Icon aria-hidden="true" className="workstream-mark" size={size} strokeWidth={1.9} style={{ color: bare }} />;
}

export function WorkstreamGlyph({ id, size = 32, appearance: saved }: { id: string; size?: number; appearance?: SavedAppearance }): React.JSX.Element {
  const { Icon, tint, ink } = resolveWorkstreamAppearance(id, saved);
  return (
    <span
      aria-hidden="true"
      className="workstream-glyph"
      style={{ height: size, width: size, '--glyph-ink': ink } as React.CSSProperties}
    >
      {/*
        The raw fill, flat. This used to be a 145deg gradient whose far stop
        mixed 22% of `surface-default` into the fill, and that put a second
        colour under the symbol that `PALETTE_INK` had never been computed
        against. Because the mix target follows the appearance while the fill
        and its ink deliberately do not, it always moved contrast the losing
        way — lightening under white ink in the light theme, darkening under
        black ink in the dark one — and cost up to 19 Lc, dropping five fills
        under the readable floor at that stop.

        Painting the raw token is what makes the floor in `PALETTE_INK`
        provable rather than approximate: there is exactly one colour behind
        the symbol, and it is the one the table was computed from.
        `AutomationGlyph` already worked this way. The alternative was to keep
        the sheen and shade away from each fill's own ink instead, which also
        cleared the floor; the flat fill won because a guarantee that needs no
        second surface to reason about is worth more here than the depth.
      */}
      <span className="workstream-glyph-shape" style={{ background: tint }} />
      <Icon className="workstream-glyph-icon" size={Math.max(12, Math.round(size * 0.5))} strokeWidth={1.9} />
    </span>
  );
}

/**
 * A state the hexagon carries in its bottom-right corner, drawn as its own
 * symbol rather than as a coloured token whose meaning has to be learned.
 *
 * Generic on purpose: the primitive knows how to cut one symbol out of the
 * fill and paint it, and nothing about which states a Sidekick has. A second
 * state is a second constant like `SIDEKICK_RUNNING_MARKER` below, not a second
 * knockout.
 */
export interface HexagonMarker {
  symbol: LucideIcon;
  /** A theme token; see `docs/theming.md`. */
  color: string;
  /**
   * What the marker means, for the surface to show when the pointer is on it.
   * The symbol is the whole of what a reader sees, and a symbol nobody can name
   * is a mark to be learned rather than read. The words are the marker's, next
   * to its shape and its colour, for the same reason its geometry is the
   * hexagon's — whoever adds the second marker states its meaning here or ships
   * an unexplained one. Where they are drawn is the surface's, because the
   * surface owns the one tooltip a tile has; see the `<g>` below.
   */
  description: string;
}

/**
 * A Sidekick that is running: lifecycle `active`, in service and waiting on its
 * triggers. Green because it is the healthy state, and a play because that is
 * already what the product's own **Resume** and **Run now** controls are drawn
 * with, so the marker and the buttons that produce it say the same thing.
 *
 * The description spends its words on the half a play gets wrong. A play reads
 * as *running right now*, and this marker is on every Sidekick the strip shows
 * whether or not one has a run in flight: `waiting` is the correction, and the
 * lifecycle rather than the run is what the mark reports. The wording follows
 * the work-stream markers' own `statusDescription` — the state named, then one
 * clause on what it means — so the two families of mark in this window explain
 * themselves the same way, and it stays short enough to wrap to two lines in
 * the width `.sidekick-tile-tooltip` holds a tile's tooltip to.
 */
export const SIDEKICK_RUNNING_MARKER: HexagonMarker = {
  symbol: Play,
  color: 'var(--av-sys-color-success-base)',
  description: 'Active — in service and waiting on its triggers.',
};

/**
 * The marker's box in the hexagon's own viewBox units, at the bottom right.
 * Sized and placed here rather than in the stylesheet so it scales with the
 * tile — 60px in the sidebar, 36px in the rail — instead of holding a pixel
 * size and swelling as the shape around it shrinks, which is the same reason
 * the new-Sidekick outline is stroked in these units.
 *
 * X and Y are separate because the hexagon is not square in its own viewBox:
 * it spans 88 units across (x 6→94) but 93.5 down (y 3.75→97.25), so one
 * origin cannot sit the marker against both edges. Y is the origin that puts
 * `Play`'s lowest point — y=21 of its 24-unit box, where the bottom-left
 * rounding arc bottoms out — just inside the hexagon's own lowest point at
 * y=97.25 (`74 + 21 * 26 / 24 = 96.75`). X is unchanged, and leaves the
 * play's right tip 2.25 units inside the right edge.
 *
 * `MARKER_Y + MARKER_BOX` is exactly 100, the viewBox's bottom. The hover
 * rect still gets its full 26 units, but a later bump to Y would clip that
 * target against the root SVG rather than fail the attribute test (which
 * compares the rect to the symbol, not to what was painted). The knockout's
 * dilated stroke also now reaches ~100.5, past both the root viewBox and
 * the mask's `0 0 100 100` region. Harmless today: the hexagon fill ends at
 * 97.25, so there is nothing down there to cut.
 */
const MARKER_BOX = 26;
const MARKER_X = 69;
const MARKER_Y = 74;

/**
 * How wide the knockout is stroked, in the marker's own 24-unit box. A stroke
 * is centred on the outline it traces, so the gap this leaves around the
 * painted symbol is half of it — but only because the knockout copy below
 * carries `overflow="visible"`. A Lucide icon is a nested `<svg>`, which
 * establishes its own viewport, and the UA stylesheet clips one to it. `Play`
 * fills its box to about 3 units from the top and 21 from the left, so any
 * dilation past 3 is cut off square at three edges — the shape-accurate gap
 * flattening into a box corner exactly where the marker crosses the hexagon.
 * That overflow only defeats the *icon* viewport. The root viewBox and the
 * mask region are a second clipper; see `MARKER_Y`.
 */
const MARKER_KNOCKOUT = 7;

/**
 * The rounded hexagon a Sidekick is drawn in, with one symbol centred in it and
 * an optional state marker cut out of its bottom-right corner.
 *
 * Separate from `AutomationGlyph` below because the shape is not the identity:
 * the sidebar's strip also has to draw the hexagon for a Sidekick that does not
 * exist yet, and that one has no id to seed a fill or a symbol from. Both go
 * through here so there is one hexagon rather than two paths that drift, and so
 * a fill and an outline are the same silhouette at the same size.
 *
 * The marker belongs to the hexagon rather than to the tile around it because
 * the knockout does. A marker has one colour and the fill under it is whichever
 * of the fifteen identity colours this Sidekick drew, so a marker painted
 * straight onto the fill is legible on some Sidekicks and lost on the ones
 * whose colour is near its own — green on `green` being exactly the pairing the
 * strip already hands out. Masking the fill along the marker's own outline is
 * what makes the separation independent of both colours. The strip used to buy
 * the same separation with a disc of `surface-default` under a dot, which cost
 * two things this does not: the gap was a circle around a symbol that is not
 * one, and an opaque patch of the default surface sat over a row that is
 * painted in a hover fill half the time. A hole shows whatever is behind it.
 */
export function HexagonGlyph({ className, fill, ink, marker, onMarkerHover, symbol: Icon }: {
  className?: string | undefined;
  /** The shape's interior. `none` leaves what is underneath it showing. */
  fill: string;
  /** What the symbol is drawn in over that fill; see `markColors`. */
  ink: string;
  /** The state to mark, or nothing where there is no state to mark. */
  marker?: HexagonMarker | undefined;
  /**
   * That the pointer is on the marker. Only the hexagon knows where the marker
   * is — the play is drawn in this viewBox so it scales with the tile, rather
   * than positioned by the surface — so only the hexagon can say when it is
   * being pointed at. What the surface does with that is its own business, and
   * one with nothing to say passes nothing.
   */
  onMarkerHover?: ((over: boolean) => void) | undefined;
  symbol: LucideIcon;
}): React.JSX.Element {
  // SVG ids are document-global and the strip draws one of these per Sidekick,
  // so a fixed id would point every hexagon at the first one's mask.
  const maskId = `hexagon-marker-${useId().replace(/[^A-Za-z0-9_-]/gu, '-')}`;
  return (
    <svg className={clsx('automation-glyph', className)} viewBox="0 0 100 100" fill="none" aria-hidden="true"
      style={{ '--glyph-ink': ink } as React.CSSProperties}>
      {marker && (
        <defs>
          {/*
            Luminance, so `white` keeps the fill and `black` cuts it away. These
            are the mask's own two channels rather than colours anything is
            painted in, which is why they are not tokens.
          */}
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
            <rect width="100" height="100" fill="white" />
            {/*
              `overflow="visible"` is load-bearing, not tidying: without it the
              nested viewport clips the dilating stroke and the gap squares off
              at the box edge. See `MARKER_KNOCKOUT`.
            */}
            <marker.symbol
              className="automation-glyph-knockout" fill="black" overflow="visible" size={MARKER_BOX}
              stroke="black" strokeLinejoin="round" strokeWidth={MARKER_KNOCKOUT}
              x={MARKER_X} y={MARKER_Y}
            />
          </mask>
        </defs>
      )}
      <path className="automation-glyph-shape" d="M43 6C47 3 52 3 57 6L86 23C91 26 94 30 94 36L94 66C94 72 91 76 86 79L57 95C52 98 47 98 42 95L14 78C9 75 6 71 6 65L6 35C6 29 9 25 14 22Z" fill={fill} mask={marker ? `url(#${maskId})` : undefined} />
      <Icon x={25} y={25} size={50} strokeWidth={1.9} />
      {marker && (
        /*
          The marker's hover target, and nothing more. What it *means* is the
          marker's own (`description`), and where that gets shown belongs to the
          surface: a tile has one tooltip slot, and a second Radix root inside
          the first one's trigger cannot share it. Radix dispatches a global
          "close everything else" the moment a root decides to open — before the
          controlled prop it then asks for is refused — so two roots nested like
          this do not resolve to one tooltip, they resolve to whichever decided
          last, and a caller that vetoes the outer one gets no tooltip at all
          rather than the right one. Both were seen in the window: the marker's
          sentence replaced by the tile's name, and then replaced by nothing.

          So the hexagon says *that* the pointer is on the marker, and the
          surface above chooses what its one tooltip says. It also keeps the
          pointer out of it: no `stopPropagation`, which reaches past React to
          the sidebar's own `window` listeners.
        */
        <g onPointerLeave={() => onMarkerHover?.(false)} onPointerMove={() => onMarkerHover?.(true)}>
          {/*
            The target is the marker's whole box rather than the play inside it.
            SVG hit-tests what is painted, and the play is about 7px across at
            the rail's 36px — a target a pointer lands on by accident, not one it
            can be rested on. A transparent fill is still a fill, so the rect
            answers `visiblePainted` while painting nothing; `fill="none"` would
            be invisible to the pointer too.
          */}
          <rect fill="transparent" height={MARKER_BOX} width={MARKER_BOX} x={MARKER_X} y={MARKER_Y} />
          {/* Solid rather than stroked: at the rail's 36px the marker is about 7px
              across, where a 2-unit outline is most of the symbol and the shape
              stops reading as a play at all. */}
          <marker.symbol className="automation-glyph-marker" fill={marker.color} size={MARKER_BOX} stroke="none"
            x={MARKER_X} y={MARKER_Y} />
        </g>
      )}
    </svg>
  );
}

/**
 * A Sidekick's identity in that hexagon, scaled to its containing tile.
 *
 * The third treatment over {@link resolveWorkstreamAppearance}, and it reads
 * the same stored appearance the other two do: a Sidekick's icon and colour are
 * chosen from the same catalog, through the same picker, so resolving them here
 * a second way is how the hexagon and the glyph would come to disagree about
 * one choice. The shape itself stays `HexagonGlyph`'s — this supplies only what
 * the identity decides (the fill, its ink, and the symbol) and passes through
 * whatever state marker the caller wants cut out of that fill.
 */
export function AutomationGlyph({ id, appearance: saved, marker, onMarkerHover }: {
  id: string;
  appearance?: SavedAppearance;
  /** The Sidekick's lifecycle, where the surface shows one; see `HexagonMarker`. */
  marker?: HexagonMarker | undefined;
  /** Passed through; see `HexagonGlyph`. */
  onMarkerHover?: ((over: boolean) => void) | undefined;
}): React.JSX.Element {
  const { Icon, tint, ink } = resolveWorkstreamAppearance(id, saved);
  return <HexagonGlyph fill={tint} ink={ink} marker={marker} onMarkerHover={onMarkerHover} symbol={Icon} />;
}
