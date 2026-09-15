export const desktopReleaseChannels = ['stable', 'faster'] as const;

export type DesktopReleaseChannel = typeof desktopReleaseChannels[number];

export const defaultDesktopReleaseChannel: DesktopReleaseChannel = 'stable';

export function parseDesktopReleaseChannel(value: unknown): DesktopReleaseChannel | null {
  return typeof value === 'string'
    && desktopReleaseChannels.includes(value as DesktopReleaseChannel)
    ? value as DesktopReleaseChannel
    : null;
}
