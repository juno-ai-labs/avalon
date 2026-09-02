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
import { PROJECT_COLOR_KEYS, type ProjectColorKey } from '@rally/contracts';

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

export interface WorkstreamAppearance {
  color: ProjectColorKey;
  iconIndex: number;
}

/**
 * A work stream has no stored appearance, so its id is the seed. The result is
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
    color: PROJECT_COLOR_KEYS[unsigned % PROJECT_COLOR_KEYS.length] ?? 'purple',
    iconIndex: Math.floor(unsigned / PROJECT_COLOR_KEYS.length) % WORKSTREAM_ICONS.length,
  };
}

export function WorkstreamGlyph({ id, size = 32 }: { id: string; size?: number }): React.JSX.Element {
  const appearance = workstreamAppearance(id);
  const Icon = WORKSTREAM_ICONS[appearance.iconIndex] ?? Sparkles;
  const color = `var(--av-sys-color-project-${appearance.color})`;
  return (
    <span
      aria-hidden="true"
      className="workstream-glyph"
      style={{ height: size, width: size }}
    >
      <span
        className="workstream-glyph-shape"
        style={{ background: `linear-gradient(145deg, color-mix(in srgb, ${color} 78%, var(--av-sys-color-surface-default)), ${color})` }}
      />
      <Icon className="workstream-glyph-icon" size={Math.max(12, Math.round(size * 0.5))} strokeWidth={1.9} />
    </span>
  );
}
