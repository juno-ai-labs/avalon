import clsx from 'clsx';
import {
  IconBrandGithub,
  IconBrandGoogle,
  IconBrandGoogleDrive,
  IconBrandNotion,
  IconBrandSlack,
  IconPlug,
  IconStack2,
  IconWebhook,
  IconWorldSearch,
  type TablerIcon,
} from '@tabler/icons-react';
import type { AutomationPluginActivity, AutomationPluginIcon } from '@rally/contracts';

export const pluginIconByKey: Record<AutomationPluginIcon, TablerIcon> = {
  'brand-github': IconBrandGithub,
  'brand-google': IconBrandGoogle,
  'brand-google-drive': IconBrandGoogleDrive,
  'brand-notion': IconBrandNotion,
  'brand-slack': IconBrandSlack,
  linear: IconStack2,
  plug: IconPlug,
  webhook: IconWebhook,
  'world-search': IconWorldSearch,
};

/** A row shows the plugin that owns the tool it ran, so there is only ever one. */
export function PluginFace({ plugin }: { plugin: AutomationPluginActivity }): React.JSX.Element {
  const PluginIcon = pluginIconByKey[plugin.icon];
  return (
    <span
      aria-label={`Plugin: ${plugin.displayName}`}
      className={clsx('plugin-face', `plugin-face-${plugin.icon}`)}
      role="img"
      title={plugin.displayName}
    >
      <PluginIcon aria-hidden="true" size={14} stroke={1.8} />
    </span>
  );
}
