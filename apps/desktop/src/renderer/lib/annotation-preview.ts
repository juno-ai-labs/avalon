import type { Annotation } from '@rally/contracts';
import type { AttachmentPreview } from '../components/attachments';
import type { RallyApi } from './api';

/** Load exactly the saved version, retaining the quote even when its bytes are gone. */
export async function loadAnnotationPreview(api:RallyApi,preview:AttachmentPreview,onCurrent:(resourceId:string)=>void):Promise<AttachmentPreview> {
  const annotation=preview.annotation;
  const resourceId=preview.resourceId;
  if(!annotation||!resourceId)return preview;
  const image=annotation.content.imageAttachmentId;
  const fallback:AttachmentPreview={...preview,...(image ? {loadAnnotationImage:(signal?:AbortSignal)=>api.getResourcePreviewContent(image,signal)}:{}),loadContent:async()=>{throw new Error('The original page cannot be shown again.');}};
  try {
    const [resource,versions]=await Promise.all([api.getResource(resourceId),api.getResourceVersions(resourceId)]);
    const version=versions.find((v)=>v.version===annotation.target.version);
    if(!version)return fallback;
    return {...fallback,name:version.title,mimeType:annotation.target.locator.type==='element'?'text/html':version.mimeType??resource.mimeType??undefined,version:annotation.target.version,
      loadContent:(signal)=>annotation.target.locator.type==='element'&&resource.mimeType==='application/vnd.rally.site-manifest+json'
        ?api.getAnnotationSitePreview(resourceId,annotation.target.version,annotation.target.locator.pagePath??'/',signal)
        :api.getResourceVersionPreview(resourceId,annotation.target.version,signal),
      ...(resource.currentVersion!==annotation.target.version?{superseded:{label:`Version ${annotation.target.version} · older version`,onReturnToCurrent:()=>onCurrent(resourceId)}}:{}),
    };
  }catch{return fallback;}
}

/** Resolve site selections from their frozen page, and other selections from the canonical preview. */
export async function readAnnotationVersion(api: RallyApi, id: string, version: number, signal: AbortSignal, annotation?: Annotation, mimeType?: string | null): Promise<Blob> {
  if (annotation?.target.locator.type === 'element') {
    if (mimeType === 'application/vnd.rally.site-manifest+json') return api.getAnnotationSitePreview(id, version, annotation.target.locator.pagePath ?? '/', signal);
  }
  return api.getResourceVersionPreview(id, version, signal);
}
