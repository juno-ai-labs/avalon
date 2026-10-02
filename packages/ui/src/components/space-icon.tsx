import { type SpaceColorKey, type SpaceIconKey } from '@rally/contracts';

import { markColors } from '../lib/project-palette';
import { APPEARANCE_ICON_COMPONENTS } from './appearance-icons';

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
      stroke={markColors(space.colorKey).ink}
      strokeWidth={1.8}
    />
  );
}
