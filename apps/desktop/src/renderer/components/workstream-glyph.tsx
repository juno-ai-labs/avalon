import {
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
  type LucideIcon,
} from 'lucide-react';
import { PROJECT_COLOR_RING, type ProjectColorKey, type WorkstreamAppearance as SavedAppearance } from '@rally/contracts';
import { glyphInk } from '../lib/project-palette';
import { PROJECT_ICONS } from './project-icons';

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

export const WORKSTREAM_ICON_COMPONENTS = {
  aperture: Aperture, atom: Atom, boxes: Boxes, 'circle-dot': CircleDot,
  'circuit-board': CircuitBoard, component: Component, dices: Dices, orbit: Orbit,
  sparkles: Sparkles, spline: Spline, 'wand-sparkles': WandSparkles, workflow: Workflow,
  ...PROJECT_ICONS,
};

export interface WorkstreamAppearance {
  color: ProjectColorKey;
  iconIndex: number;
}

/**
 * A work stream without a chosen appearance uses its id as the seed. The result is
 * deliberately deterministic: an identity that changed on every launch would
 * make the sidebar harder to scan even though it looked more random.
 */
export function workstreamAppearance(id: string): WorkstreamAppearance {
  let hash = 2_166_136_261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  const unsigned = hash >>> 0;
  return {
    // The ring, not the full palette: `black` is the neutral somebody picks, not
    // a colour to hand out at random.
    color: PROJECT_COLOR_RING[unsigned % PROJECT_COLOR_RING.length] ?? 'purple',
    iconIndex: Math.floor(unsigned / PROJECT_COLOR_RING.length) % WORKSTREAM_ICONS.length,
  };
}

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
export function resolveWorkstreamAppearance(id: string, saved?: ResolvableAppearance): { Icon: LucideIcon; color: string } {
  const generated = workstreamAppearance(id);
  return {
    Icon: (saved?.icon ? ICON_BY_KEY[saved.icon] : undefined)
      || WORKSTREAM_ICONS[generated.iconIndex]
      || Sparkles,
    color: `var(--av-sys-color-project-${saved?.color ?? generated.color})`,
  };
}

/**
 * The work stream's identity as a bare tinted mark, for a surface that already
 * sits inside the work stream. The glyph's filled shape says *which* stream
 * among many, which is the navigation sidebar's job; a rail that only ever
 * shows one stream needs the colour and the symbol, not a second badge.
 */
export function WorkstreamMark({ id, size = 24, appearance: saved }: { id: string; size?: number; appearance?: SavedAppearance }): React.JSX.Element {
  const { Icon, color } = resolveWorkstreamAppearance(id, saved);
  return <Icon aria-hidden="true" className="workstream-mark" size={size} strokeWidth={1.9} style={{ color }} />;
}

export function WorkstreamGlyph({ id, size = 32, appearance: saved }: { id: string; size?: number; appearance?: SavedAppearance }): React.JSX.Element {
  const { Icon, color } = resolveWorkstreamAppearance(id, saved);
  return (
    <span
      aria-hidden="true"
      className="workstream-glyph"
      style={{ height: size, width: size, '--glyph-ink': glyphInk(appearance.color) } as React.CSSProperties}
    >
      <span
        className="workstream-glyph-shape"
        style={{ background: `linear-gradient(145deg, color-mix(in srgb, ${color} 78%, var(--av-sys-color-surface-default)), ${color})` }}
      />
      <Icon className="workstream-glyph-icon" size={Math.max(12, Math.round(size * 0.5))} strokeWidth={1.9} />
    </span>
  );
}

/** Scales the shape and symbol together to the containing automation tile. */
export function AutomationGlyph({ id }: { id: string }): React.JSX.Element {
  const appearance = workstreamAppearance(id);
  const Icon = WORKSTREAM_ICONS[appearance.iconIndex] ?? Sparkles;
  return (
    <svg className="automation-glyph" viewBox="0 0 100 100" fill="none" aria-hidden="true"
      style={{ '--glyph-ink': glyphInk(appearance.color) } as React.CSSProperties}>
      <path d="M43 6C47 3 52 3 57 6L86 23C91 26 94 30 94 36L94 66C94 72 91 76 86 79L57 95C52 98 47 98 42 95L14 78C9 75 6 71 6 65L6 35C6 29 9 25 14 22Z" fill={`var(--av-sys-color-project-${appearance.color})`} />
      <Icon x={25} y={25} size={50} strokeWidth={1.9} />
    </svg>
  );
}
