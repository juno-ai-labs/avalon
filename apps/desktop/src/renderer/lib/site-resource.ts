import { classifyAttachmentKind } from '@rally/contracts';

/** Whether this resource is a live artifact Rally serves rather than a file. */
export function isSiteResource(resource: { title: string; mimeType?: string | null | undefined }): boolean {
  return classifyAttachmentKind({ fileName: resource.title, mimeType: resource.mimeType ?? undefined }) === 'site';
}
