export const desktopSettingsSections = [
  'account',
  'notifications',
  'workspace',
  'members',
  'internet-access',
  'connections',
  'connection',
  'application',
] as const;

export type DesktopSettingsSection = (typeof desktopSettingsSections)[number];

export function parseDesktopSettingsSection(value: unknown): DesktopSettingsSection | null {
  // The digest moved into Notifications. Its old page is still named by
  // digest emails already sent and by older Rally builds, so it is an alias.
  if (value === 'digest') return 'notifications';
  return typeof value === 'string'
    && (desktopSettingsSections as readonly string[]).includes(value)
    ? value as DesktopSettingsSection
    : null;
}
