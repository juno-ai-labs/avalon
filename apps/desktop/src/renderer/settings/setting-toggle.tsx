import type { InputHTMLAttributes, ReactNode } from 'react';
import type { SettingDefinition } from './registry';
import { SettingCopy } from './setting-label';

/** Bind existing state/mutations; the registry owns presentation and discovery. */
export function SettingToggle({ setting, description, nested = false, ...input }: {
  setting: SettingDefinition & { kind: 'toggle' };
  description?: ReactNode;
  /** A narrower switch under the one above it, drawn indented. */
  nested?: boolean;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'children'>): React.JSX.Element {
  return (
    <label className={nested ? 'settings-preference-row settings-preference-row-nested' : 'settings-preference-row'}>
      <SettingCopy setting={setting} description={description} />
      <span className="settings-toggle">
        <input {...input} type="checkbox" />
        <span aria-hidden="true" />
      </span>
    </label>
  );
}
