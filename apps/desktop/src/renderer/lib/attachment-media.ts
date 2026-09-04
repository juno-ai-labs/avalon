const VIDEO_FILE_PATTERN = /\.(?:m4v|mkv|mov|mp4|ogv|webm)$/iu;
const IMAGE_FILE_PATTERN = /\.(?:avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|webp)$/iu;

export function attachmentMime(mimeType = ''): string {
  return mimeType.split(';', 1)[0]!.trim().toLowerCase();
}

export function hasGenericAttachmentMime(mimeType = ''): boolean {
  const mime = attachmentMime(mimeType);
  return !mime || mime === 'application/octet-stream';
}

export function isVideoAttachment(mimeType: string, fileName: string): boolean {
  return attachmentMime(mimeType).startsWith('video/')
    || (hasGenericAttachmentMime(mimeType) && VIDEO_FILE_PATTERN.test(fileName));
}

export function isImageAttachment(mimeType: string, fileName: string): boolean {
  return attachmentMime(mimeType).startsWith('image/')
    || (hasGenericAttachmentMime(mimeType) && IMAGE_FILE_PATTERN.test(fileName));
}
