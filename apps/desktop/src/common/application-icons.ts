export const applicationIconChoices = [
  { id: 'light', label: 'Light', fileName: 'light.png' },
  { id: 'dark', label: 'Dark', fileName: 'dark.png' },
  { id: 'sunset-sherbet', label: 'Sunset sherbet', fileName: 'sunset-sherbet.png' },
  { id: 'ludicrous-speed', label: 'Ludicrous speed', fileName: 'ludicrous-speed.png' },
  { id: 'ruby', label: 'Ruby', fileName: 'ruby.png' },
  { id: 'holographic', label: 'Holographic', fileName: 'holographic.png' },
  { id: 'leather', label: 'Leather', fileName: 'leather.png' },
  { id: 'blueprint', label: 'Blueprint', fileName: 'blueprint.png' },
] as const;

export type ApplicationIconId = (typeof applicationIconChoices)[number]['id'];

export interface DesktopApplicationIconState {
  activeIcon: ApplicationIconId;
  isAutomatic: boolean;
  supported: boolean;
}

const applicationIconIds = new Set<string>(applicationIconChoices.map(({ id }) => id));

export function parseApplicationIconId(value: unknown): ApplicationIconId | null {
  return typeof value === 'string' && applicationIconIds.has(value)
    ? value as ApplicationIconId
    : null;
}

export function applicationIconFileName(iconId: ApplicationIconId): string {
  const choice = applicationIconChoices.find(({ id }) => id === iconId);
  if (!choice) throw new Error(`Unknown application icon: ${iconId}`);
  return choice.fileName;
}

export function automaticApplicationIcon(shouldUseDarkColors: boolean): ApplicationIconId {
  return shouldUseDarkColors ? 'dark' : 'light';
}
