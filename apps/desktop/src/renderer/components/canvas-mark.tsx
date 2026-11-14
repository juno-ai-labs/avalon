import { type PaletteKey, type WorkstreamAppearance } from '@rally/contracts';
import { IdentityTile } from '@rally/ui/components/identity-tile';
import { WORKSTREAM_ICON_COMPONENTS } from '@rally/ui/components/workstream-glyph';
import { canvasColors } from '../lib/canvas-colors';
export { canvasHue } from '../lib/canvas-colors';
import { PanelsTopLeft, type LucideIcon } from 'lucide-react';

/**
 * What a Canvas wears until the naming pass or a person chooses its icon. One
 * fixed glyph, never one read from its artifacts: the icon is a choice, the
 * model's or a person's, and nothing else sets it.
 */
const UNCHOSEN_ICON = PanelsTopLeft;

/**
 * What a Canvas is drawn in: the icon and colour somebody chose, else the
 * unchosen glyph and its id's hue, field by field. A caller with no Canvas id
 * (a list that names none) gets the cyan pair.
 */
export function canvasMark(id: string | undefined, appearance?: WorkstreamAppearance | undefined): {
  icon: LucideIcon; ink: string; tint: string; color: PaletteKey;
} {
  const { color, ink, tint } = canvasColors(id, appearance);
  return { icon: appearance?.icon ? WORKSTREAM_ICON_COMPONENTS[appearance.icon] : UNCHOSEN_ICON, ink, tint, color };
}

/**
 * A Canvas's mark: the page outline every artifact tile uses, holding its
 * chosen icon or the unchosen glyph, in its pastel pair through
 * `markColors`, the mechanism a Sidekick's hexagon uses, so both appearances
 * are themed.
 */
export function CanvasMark({ id, size, appearance }: {
  id?: string;
  size?: number;
  appearance?: WorkstreamAppearance | undefined;
}): React.JSX.Element {
  const { icon, ink, tint } = canvasMark(id, appearance);
  return <IdentityTile icon={icon} ink={ink} shape="sheet" size={size} tint={tint} />;
}
