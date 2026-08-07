export function allowsTrustedAudioCapture(input: {
  isAudioCaptureWindow: boolean;
  mediaTypes: readonly string[];
  permission: string;
  trustedRenderer: boolean;
}): boolean {
  return input.isAudioCaptureWindow
    && input.trustedRenderer
    && input.permission === 'media'
    && input.mediaTypes.length > 0
    && input.mediaTypes.every((mediaType) => mediaType === 'audio');
}
