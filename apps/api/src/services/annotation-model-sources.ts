import { z } from 'zod';
import type { ModelAttachmentSource } from './attachment-model-content';

/** Server-built immutable image descriptors travel with the canonical turn for replay. */
const sources = z.object({
  kind:z.literal('artifact_annotations'),
  images:z.array(z.object({
    id:z.string(),resourceVersion:z.number().int().positive().optional(),workspaceId:z.string(),fileName:z.string(),mimeType:z.string(),sizeBytes:z.number(),
    contentRef:z.string().nullable(),modelContentRef:z.string().nullable(),modelContentStatus:z.literal('ready').nullable(),
    contentSha256:z.string().nullable().optional(),modelMimeType:z.string().nullable().optional(),modelContentSha256:z.string().nullable().optional(),modelMetadataJson:z.string().nullable().optional(),
  })),
});
export function annotationModelSources(content:unknown): ModelAttachmentSource[] {
  const parsed=sources.safeParse(content);
  return parsed.success ? parsed.data.images.map((image)=>({
    id:image.id,workspaceId:image.workspaceId,fileName:image.fileName,mimeType:image.mimeType,
    sizeBytes:image.sizeBytes,contentRef:image.contentRef,modelContentRef:image.modelContentRef,modelContentStatus:image.modelContentStatus,
    ...(image.resourceVersion===undefined?{}:{resourceVersion:image.resourceVersion}),
    contentSha256:image.contentSha256??null,modelMimeType:image.modelMimeType??null,
    modelContentSha256:image.modelContentSha256??null,modelMetadataJson:image.modelMetadataJson??null,
  })) : [];
}
