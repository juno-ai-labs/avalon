import { themeDescriptions } from '../../common/themes';
import { persistThemeChoice, useTheme } from '../lib/theme';

/**
 * The Appearance control.
 *
 * Each option previews itself: the swatch is a miniature of the theme drawn
 * with that theme's own tokens, under `data-theme` on the swatch rather than on
 * the document. A preview built from hardcoded colours is a second copy of the
 * palette and goes stale the first time a theme is retuned; this one cannot.
 *
 * The System option has no palette of its own, so it shows the appearance it
 * currently resolves to, which is the honest preview of what choosing it does.
 */
export function ThemePicker(): React.JSX.Element {
  const { choice, resolved } = useTheme();

  return (
    <div className="settings-theme-card">
      <div className="settings-theme-heading">
        <span>
          <strong>Theme</strong>
          <small>Applies to every Avalon window on this Mac, and is remembered here rather than on your account.</small>
        </span>
      </div>
      <div aria-label="Theme" className="settings-theme-shelf" role="radiogroup">
        {themeDescriptions.map((theme) => {
          const selected = choice === theme.id;
          return (
            <button
              aria-checked={selected}
              className="settings-theme-option"
              key={theme.id}
              onClick={() => persistThemeChoice(theme.id)}
              role="radio"
              title={theme.description}
              type="button"
            >
              <span
                aria-hidden="true"
                className="settings-theme-swatch"
                data-theme={theme.id === 'system' ? resolved : theme.id}
              >
                <span className="settings-theme-swatch-sidebar" />
                <span className="settings-theme-swatch-surface">
                  <span className="settings-theme-swatch-line" />
                  <span className="settings-theme-swatch-line is-short" />
                  <span className="settings-theme-swatch-accent" />
                </span>
              </span>
              <span className="settings-theme-option-label">{theme.label}</span>
            </button>
          );
        })}
      </div>
      <p aria-live="polite" className="settings-theme-status">
        {choice === 'system'
          ? `Following this Mac, which is ${resolved === 'dark' ? 'dark' : 'light'} right now.`
          : `${themeDescriptions.find((theme) => theme.id === choice)?.label ?? 'Dark'} is selected.`}
      </p>
    </div>
  );
}
