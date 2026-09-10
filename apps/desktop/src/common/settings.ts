export const desktopSettingsSections = [
  'account',
  'digest',
  'workspace',
  'internet-access',
  'connections',
  'github',
  'custom-mcp',
  'application',
] as const;

export type DesktopSettingsSection = (typeof desktopSettingsSections)[number];

export function parseDesktopSettingsSection(value: unknown): DesktopSettingsSection | null {
  return typeof value === 'string'
    && (desktopSettingsSections as readonly string[]).includes(value)
    ? value as DesktopSettingsSection
    : null;
}
