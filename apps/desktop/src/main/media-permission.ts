export function allowsTrustedAudioCapture(input: {
  mainWindowContents: object | null | undefined;
  mediaTypes: readonly string[];
  permission: string;
  requestingContents: object | null | undefined;
  trustedRenderer: boolean;
}): boolean {
  const isAudioCaptureWindow = input.requestingContents != null
    && input.requestingContents === input.mainWindowContents;
  return isAudioCaptureWindow
    && input.trustedRenderer
    && input.permission === 'media'
    && input.mediaTypes.length > 0
    && input.mediaTypes.every((mediaType) => mediaType === 'audio');
}
