import {
  CURRENT_APPLICATION_ICON_IDS,
  type CurrentApplicationIconId,
} from '@rally/contracts/telemetry';

const applicationIconLabels: Record<CurrentApplicationIconId, string> = {
  light: 'Light',
  dark: 'Dark',
  calm: 'Calm',
  ludicrous: 'Ludicrous speed',
  homage: 'Homage',
  builder: 'Builder',
  quiet: 'Quiet',
};

export const applicationIconChoices = CURRENT_APPLICATION_ICON_IDS.map((id) => ({
  id,
  label: applicationIconLabels[id],
  fileName: `${id}.icns`,
  artworkFileName: `${id}.png`,
}));

export type ApplicationIconId = CurrentApplicationIconId;

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

export function applicationIconArtworkFileName(iconId: ApplicationIconId): string {
  const choice = applicationIconChoices.find(({ id }) => id === iconId);
  if (!choice) throw new Error(`Unknown application icon: ${iconId}`);
  return choice.artworkFileName;
}

export function automaticApplicationIcon(shouldUseDarkColors: boolean): ApplicationIconId {
  return shouldUseDarkColors ? 'dark' : 'light';
}
