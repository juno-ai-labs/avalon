export const desktopSettingsSections = [
  'account',
  'preferences',
  'memories',
  'notifications',
  'workspace',
  'members',
  'billing',
  'internet-access',
  'connections',
  'connection',
  'application',
] as const;

export type DesktopSettingsSection = (typeof desktopSettingsSections)[number];

/**
 * The sections a guest can open: their own profile, who is in the Organization,
 * and this app. Every other section configures the Organization or a member's
 * place in it, and its routes refuse a guest, so a guest sees it disabled.
 */
export const GUEST_SETTINGS_SECTIONS: ReadonlySet<DesktopSettingsSection> = new Set(['account', 'preferences', 'members', 'application']);

export function parseDesktopSettingsSection(value: unknown): DesktopSettingsSection | null {
  // The digest moved into Notifications. Its old page is still named by
  // digest emails already sent and by older Rally builds, so it is an alias.
  if (value === 'digest') return 'notifications';
  return typeof value === 'string'
    && (desktopSettingsSections as readonly string[]).includes(value)
    ? value as DesktopSettingsSection
    : null;
}
