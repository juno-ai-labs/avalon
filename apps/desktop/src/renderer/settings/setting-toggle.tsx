import type { InputHTMLAttributes, ReactNode } from 'react';
import type { SettingDefinition } from './registry';
import { SettingCopy } from './setting-label';

/** Bind existing state/mutations; the registry owns presentation and discovery. */
export function SettingToggle({ setting, description, ...input }: {
  setting: SettingDefinition & { kind: 'toggle' };
  description?: ReactNode;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'children'>): React.JSX.Element {
  return (
    <label className="settings-preference-row">
      <SettingCopy setting={setting} description={description} />
      <span className="settings-toggle">
        <input {...input} type="checkbox" />
        <span aria-hidden="true" />
      </span>
    </label>
  );
}
