import { type SpaceColorKey, type SpaceIconKey } from '@rally/contracts';

import { markColors } from '../lib/project-palette';
import { APPEARANCE_ICON_COMPONENTS } from './appearance-icons';
import { IdentityTile, type IdentityMark } from './identity-tile';

export interface SpaceAppearance {
  iconKey: SpaceIconKey;
  colorKey: SpaceColorKey;
}

/**
 * A Space's mark: its chosen glyph, stroked in its chosen hue's ink.
 *
 * The same drawing in the sidebar row, the dashboard header and the archived
 * list, so a Space is recognised by the same two choices wherever it appears.
 * Choosing them is `AppearancePicker`, the same picker a Channel opens.
 */
export function SpaceIcon({ space, size = 15 }: { space: SpaceAppearance; size?: number }): React.JSX.Element {
  const Icon = APPEARANCE_ICON_COMPONENTS[space.iconKey];
  return (
    <Icon
      aria-hidden="true"
      size={size}
      stroke={markColors(space.colorKey).bare}
      strokeWidth={1.8}
    />
  );
}

/**
 * A Channel's mark as a tile: its glyph on its hue's pastel squircle, the
 * same tile the sidebar's Channel rows draw. Where `SpaceIcon` is the bare
 * mark for a list of marks, this is for a surface that names one Channel,
 * such as its title pill, the way `WorkstreamGlyph` is a thread's circle.
 */
export function ChannelGlyph({ space, size = 24 }: { space: SpaceAppearance; size?: number }): React.JSX.Element {
  const { ink, tint } = markColors(space.colorKey);
  return <IdentityTile icon={APPEARANCE_ICON_COMPONENTS[space.iconKey]} ink={ink} shape="squircle" size={size} tint={tint} />;
}

/** A Space (a Channel) as a mark: its glyph in a squircle, in its hue's pair. */
export function spaceMark(space: SpaceAppearance): IdentityMark {
  const { tint, ink } = markColors(space.colorKey);
  return { shape: 'squircle', icon: APPEARANCE_ICON_COMPONENTS[space.iconKey], tint, ink };
}
