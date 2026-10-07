import { settings, type SettingDefinition } from '../settings/registry';
import { SettingLabel } from '../settings/setting-label';
import {
  appearanceModeDescriptions,
} from '../../common/themes';
import { SegmentedControl } from './primitives';
import { persistThemeChoice, useTheme } from '../lib/theme';

/**
 * Rally has one visual language. This control only decides whether that GrokBot
 * palette follows the Mac or stays pinned light or dark.
 */
export function ThemePicker({ setting = settings.appearance }: { setting?: SettingDefinition } = {}): React.JSX.Element {
  const { choice, resolved } = useTheme();
  const lighting = resolved;

  return (
    <div className="settings-theme-card">
      <div className="settings-theme-heading">
        <span>
          <strong><SettingLabel setting={setting} /></strong>
          <small>{setting.description}</small>
        </span>
      </div>

      <SegmentedControl
        ariaLabel="Appearance"
        onChange={persistThemeChoice}
        options={appearanceModeDescriptions.map((mode) => ({
          value: mode.id,
          label: mode.label,
          title: mode.description,
        }))}
        value={choice}
      />

      <p aria-live="polite" className="settings-theme-status">
        {choice === 'system'
          ? `Following this device, which is ${lighting} right now.`
          : `Always ${choice}.`}
      </p>
    </div>
  );
}
