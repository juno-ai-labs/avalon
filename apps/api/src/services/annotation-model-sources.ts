import { z } from 'zod';
import type { ModelAttachmentSource } from './attachment-model-content';

/** Server-built immutable image descriptors travel with the canonical turn for replay. */
const sources = z.object({
  kind:z.literal('artifact_annotations'),
  images:z.array(z.object({
    id:z.string(),workspaceId:z.string(),fileName:z.string(),mimeType:z.string(),sizeBytes:z.number(),
    contentRef:z.string().nullable(),modelContentRef:z.string().nullable(),modelContentStatus:z.literal('ready').nullable(),
  })),
});
export function annotationModelSources(content:unknown): ModelAttachmentSource[] {
  const parsed=sources.safeParse(content);
  return parsed.success ? parsed.data.images : [];
}
