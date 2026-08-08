interface ElectronCommandLine {
  appendSwitch: (name: string, value: string) => void;
  getSwitchValue: (name: string) => string;
}

export const MACOS_SCREEN_CAPTURE_AUDIO_FEATURE = 'MacSckSystemAudioLoopbackOverride';
export const MACOS_CORE_AUDIO_CAPTURE_FEATURE = 'MacCatapLoopbackAudioForScreenShare';

function appendFeature(
  commandLine: ElectronCommandLine,
  switchName: 'disable-features' | 'enable-features',
  feature: string,
): void {
  const features = new Set(
    commandLine.getSwitchValue(switchName)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  features.add(feature);
  commandLine.appendSwitch(switchName, [...features].join(','));
}

export function configureSystemAudioCapture(
  commandLine: ElectronCommandLine,
  platform: NodeJS.Platform,
): void {
  if (platform !== 'darwin') return;

  // Chromium 150 defaults macOS loopback capture to Core Audio taps. That
  // route can return a denied or already-ended track on current macOS builds.
  // Its ScreenCaptureKit implementation captures the same outgoing system
  // audio reliably, including browser calls, after the standard macOS consent.
  appendFeature(commandLine, 'disable-features', MACOS_CORE_AUDIO_CAPTURE_FEATURE);
  appendFeature(commandLine, 'enable-features', MACOS_SCREEN_CAPTURE_AUDIO_FEATURE);
}
