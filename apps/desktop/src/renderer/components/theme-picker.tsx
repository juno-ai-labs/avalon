import {
  appearanceModeDescriptions,
} from '../../common/themes';
import { persistThemeChoice, useTheme, withMode } from '../lib/theme';

/**
 * Rally has one visual language. This control only decides whether that GrokBot
 * palette follows the Mac or stays pinned light or dark.
 */
export function ThemePicker(): React.JSX.Element {
  const { choice, resolved } = useTheme();
  const lighting = resolved === 'air-dark' ? 'dark' : 'light';

  return (
    <div className="settings-theme-card">
      <div className="settings-theme-heading">
        <span>
          <strong>Appearance</strong>
          <small>Follow this Mac or keep Rally light or dark.</small>
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

      <p aria-live="polite" className="settings-theme-status">
        {choice.mode === 'system'
          ? `Following this Mac, which is ${lighting} right now.`
          : `Always ${choice.mode}.`}
      </p>
    </div>
  );
}
