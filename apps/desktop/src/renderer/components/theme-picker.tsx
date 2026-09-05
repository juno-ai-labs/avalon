import { settings } from '../settings/registry';
import { SettingLabel } from '../settings/setting-label';
import {
  appearanceModeDescriptions,
} from '../../common/themes';
import { persistThemeChoice, useTheme } from '../lib/theme';

/**
 * Rally has one visual language. This control only decides whether that GrokBot
 * palette follows the Mac or stays pinned light or dark.
 */
export function ThemePicker(): React.JSX.Element {
  const { choice, resolved } = useTheme();
  const lighting = resolved;

  return (
    <div className="settings-theme-card">
      <div className="settings-theme-heading">
        <span>
          <strong><SettingLabel setting={settings.appearance} /></strong>
          <small>{settings.appearance.description}</small>
        </span>
      </div>

      <div aria-label="Appearance" className="settings-theme-modes" role="radiogroup">
        {appearanceModeDescriptions.map((mode) => (
          <button
            aria-checked={choice === mode.id}
            className="settings-theme-mode"
            key={mode.id}
            onClick={() => persistThemeChoice(mode.id)}
            role="radio"
            title={mode.description}
            type="button"
          >
            {mode.label}
          </button>
        ))}
      </div>

      <p aria-live="polite" className="settings-theme-status">
        {choice === 'system'
          ? `Following this Mac, which is ${lighting} right now.`
          : `Always ${choice}.`}
      </p>
    </div>
  );
}
