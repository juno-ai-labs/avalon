export function allowsTrustedAudioCapture(input: {
  isMainWindow: boolean;
  mediaTypes: readonly string[];
  permission: string;
  trustedRenderer: boolean;
}): boolean {
  return input.isMainWindow
    && input.trustedRenderer
    && input.permission === 'media'
    && input.mediaTypes.length > 0
    && input.mediaTypes.every((mediaType) => mediaType === 'audio');
}
