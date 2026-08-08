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

export function allowsTrustedMeetingDisplayCapture(input: {
  audioRequested: boolean;
  isMainFrame: boolean;
  isMeetingWindow: boolean;
  trustedRenderer: boolean;
  videoRequested: boolean;
}): boolean {
  return input.isMeetingWindow
    && input.isMainFrame
    && input.trustedRenderer
    && input.audioRequested
    && input.videoRequested;
}

export function allowsTrustedDisplayCapturePermission(input: {
  isMeetingWindow: boolean;
  permission: string;
  trustedRenderer: boolean;
}): boolean {
  return input.isMeetingWindow
    && input.trustedRenderer
    && input.permission === 'display-capture';
}
