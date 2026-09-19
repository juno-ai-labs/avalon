import * as Tooltip from '@radix-ui/react-tooltip';
import { SPACE_ICON_KEYS, type SpaceColorKey, type SpaceIconKey } from '@rally/contracts';
import clsx from 'clsx';

import { projectColorCells } from '../lib/project-palette';
import { SPACE_ICONS } from './space-icons';

/**
 * A catalog key as a person reads it: `list-checks` becomes `List Checks`.
 *
 * The keys are the vocabulary and the labels are derived from them rather than
 * held in a second table, so adding a hue or a glyph to the contract is the
 * whole change. A hand-written label table is how a swatch ends up named after
 * the colour beside it.
 */
function label(value: string): string {
  return value.split('-').map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(' ');
}

export interface SpaceAppearance {
  iconKey: SpaceIconKey;
  colorKey: SpaceColorKey;
}

/**
 * A Space's mark: its chosen glyph, stroked in its chosen hue.
 *
 * The same drawing in the sidebar row, the dashboard header and the archived
 * list, so a Space is recognised by the same two choices wherever it appears.
 */
export function SpaceIcon({ space, size = 15 }: { space: SpaceAppearance; size?: number }): React.JSX.Element {
  const Icon = SPACE_ICONS[space.iconKey];
  return (
    <Icon
      aria-hidden="true"
      size={size}
      stroke={`var(--av-sys-color-project-${space.colorKey})`}
      strokeWidth={1.8}
    />
  );
}

/**
 * The two grids a Space's appearance is chosen from, as a form control.
 *
 * Deliberately not {@link AppearancePicker}, which is the same catalog behind a
 * dropdown that saves on every click. A Space is given its appearance inside a
 * form — the New Space dialog, and the dashboard's icon-and-colour modal —
 * where the choice is committed with the rest of the form and a preview that
 * saved itself would be a write the reader did not ask for yet. What the two
 * share is the catalog and the swatch layout, which live in the contract and in
 * `projectColorCells` rather than in either picker.
 *
 * Presentational: it holds no draft and performs no mutation. The host owns
 * both keys and what saving them means.
 */
export function SpaceAppearancePicker({
  colorKey,
  iconKey,
  onColorChange,
  onIconChange,
}: {
  colorKey: SpaceColorKey;
  iconKey: SpaceIconKey;
  onColorChange: (colorKey: SpaceColorKey) => void;
  onIconChange: (iconKey: SpaceIconKey) => void;
}): React.JSX.Element {
  return (
    <div className="space-appearance-picker">
      <fieldset>
        <legend>Icon</legend>
        <div className="space-icon-grid">
          {SPACE_ICON_KEYS.map((key) => {
            const Icon = SPACE_ICONS[key];
            return (
              <button
                aria-label={label(key)}
                aria-pressed={iconKey === key}
                className={clsx(iconKey === key && 'is-selected')}
                key={key}
                onClick={() => onIconChange(key)}
                type="button"
              >
                <Icon aria-hidden="true" size={17} stroke={`var(--av-sys-color-project-${colorKey})`} />
              </button>
            );
          })}
        </div>
      </fieldset>
      <fieldset>
        <legend>Color</legend>
        <div className="space-color-grid">
          {projectColorCells().map((key, cell) => (key === null
            ? <span aria-hidden="true" className="space-color-gap" key={`gap-${cell}`} />
            : <Tooltip.Root delayDuration={250} key={key}>
              <Tooltip.Trigger asChild>
                <button
                  aria-label={label(key)}
                  aria-pressed={colorKey === key}
                  className={clsx(colorKey === key && 'is-selected')}
                  onClick={() => onColorChange(key)}
                  type="button"
                >
                  <span style={{ background: `var(--av-sys-color-project-${key})` }} />
                </button>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="tooltip" sideOffset={5}>
                  {label(key)}
                  <Tooltip.Arrow className="tooltip-arrow" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>))}
        </div>
      </fieldset>
    </div>
  );
}
