import type { SettingDefinition } from './registry';
import type { ReactNode } from 'react';

/** Render the same definition search uses, with a focusable, inert destination. */
export function SettingLabel({ setting, instanceId }: {
  setting: SettingDefinition;
  instanceId?: string;
}): React.JSX.Element {
  return <span data-setting-id={setting.id} data-setting-instance={instanceId} tabIndex={-1}>{setting.label}</span>;
}

/** Standard rows and custom controls share their visible/searchable metadata. */
export function SettingCopy({ setting, description, instanceId }: {
  setting: SettingDefinition;
  description?: ReactNode;
  instanceId?: string;
}): React.JSX.Element {
  return <span className="settings-row-copy">
    <strong><SettingLabel setting={setting} instanceId={instanceId} /></strong>
    <small>{description ?? setting.description}</small>
  </span>;
}
