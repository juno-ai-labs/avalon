import {
  appearanceModeDescriptions,
  familyAppearances,
  themeFamilyDescriptions,
  type ResolvedTheme,
} from '../../common/themes';
import { persistThemeChoice, useTheme, withFamily, withMode } from '../lib/theme';

/**
 * The miniature, drawn entirely from the offered appearance's own tokens.
 *
 * It shows the three things that differ between families rather than only their
 * colours: the shape of a row's leading mark, whether a person's turn sits in a
 * bubble, and — the one that reads fastest — which side of the feed each actor
 * speaks from. Rally's own turn hugs the right; Air's runs left with everything
 * else. A preview built from hardcoded values would be a second copy of the
 * palette and go stale the first time a theme is retuned; this one cannot.
 */
function Miniature(): React.JSX.Element {
  return (
    <>
      <span className="settings-theme-swatch-sidebar">
        <span className="settings-theme-swatch-marker" />
      </span>
      <span className="settings-theme-swatch-surface">
        <span className="settings-theme-swatch-line" />
        <span className="settings-theme-swatch-line is-short" />
        <span className="settings-theme-swatch-turn">
          <span className="settings-theme-swatch-line is-turn" />
        </span>
      </span>
    </>
  );
}

/**
 * The Appearance control, on two axes.
 *
 * The **mode** sits above the designs rather than beside them, because it is not
 * one of them: it says which way round to run whichever design is chosen. As one
 * flat list, `system` was a peer of Light and Dark and Air — so following the Mac
 * silently also chose Terra, and someone on Air had no way to say "this design,
 * but follow the room". Two rows say both things at once.
 */
export function ThemePicker(): React.JSX.Element {
  const { choice, resolved } = useTheme();
  const lighting = resolved === familyAppearances[choice.family].dark ? 'dark' : 'light';
  const familyLabel = themeFamilyDescriptions.find((family) => family.id === choice.family)?.label
    ?? 'Terra';

  return (
    <div className="settings-theme-card">
      <div className="settings-theme-heading">
        <span>
          <strong>Theme</strong>
          <small>Applies to every Rally window on this Mac, and is remembered here rather than on your account.</small>
        </span>
      </div>

      <div aria-label="Appearance" className="settings-theme-modes" role="radiogroup">
        {appearanceModeDescriptions.map((mode) => (
          <button
            aria-checked={choice.mode === mode.id}
            className="settings-theme-mode"
            key={mode.id}
            onClick={() => persistThemeChoice(withMode(choice, mode.id))}
            role="radio"
            title={mode.description}
            type="button"
          >
            {mode.label}
          </button>
        ))}
      </div>

      <div aria-label="Theme" className="settings-theme-shelf" role="radiogroup">
        {themeFamilyDescriptions.map((family) => {
          const appearances = familyAppearances[family.id];
          // Under a pinned mode a family has one appearance to show. Under
          // `system` it has two, and which one you get depends on the Mac — so
          // the swatch shows both, split, rather than picking one and being
          // quietly wrong for half of the day.
          const halves: readonly ResolvedTheme[] = choice.mode === 'system'
            ? [appearances.light, appearances.dark]
            : [appearances[lighting]];

          return (
            <button
              aria-checked={choice.family === family.id}
              className="settings-theme-option"
              key={family.id}
              onClick={() => persistThemeChoice(withFamily(choice, family.id))}
              role="radio"
              title={family.description}
              type="button"
            >
              <span aria-hidden="true" className="settings-theme-swatch" data-theme={halves[0]}>
                <Miniature />
                {halves[1] ? (
                  <span className="settings-theme-swatch-alternate" data-theme={halves[1]}>
                    <Miniature />
                  </span>
                ) : null}
              </span>
              <span className="settings-theme-option-label">{family.label}</span>
            </button>
          );
        })}
      </div>

      <p aria-live="polite" className="settings-theme-status">
        {choice.mode === 'system'
          ? `${familyLabel}, following this Mac, which is ${lighting} right now.`
          : `${familyLabel}, always ${choice.mode}.`}
      </p>
    </div>
  );
}
