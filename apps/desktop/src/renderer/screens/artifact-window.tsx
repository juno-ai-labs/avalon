import { IconGroup } from '@rally/ui/components/icon-group';
import { useEffect, useRef, useState, useMemo } from 'react';
import type { IconGroupAction } from '@rally/ui/components/icon-group';
import type { DesktopArtifactWindowRequest } from '../../common/desktop';
import { AnnotationDraftProvider, AnnotationChips, useAnnotationDraft } from '../components/artifact-annotations';
import { AnnotationSurface } from '../components/annotation-surface';
import { SiteResourceDetail } from '../components/site-resource-detail';
import { DetailHeaderActionsHost } from '../components/detail-header-actions';
import { desktopBridge } from '../lib/platform';
import * as Tooltip from '@radix-ui/react-tooltip';

export function ArtifactWindow(): React.JSX.Element {
  const [preview, setPreview] = useState<DesktopArtifactWindowRequest | null>(null);
  const files = useRef(new Map<string, File>());
  useEffect(() => {
    const refresh = (): void => { void window.rally?.readArtifactWindow?.().then(setPreview); };
    refresh(); return window.rally?.onArtifactWindowUpdated?.(refresh);
  }, []);
  return <Tooltip.Provider><AnnotationDraftProvider upload={async (file) => { const id = crypto.randomUUID(); files.current.set(id,file); return id; }}>
    {preview && <ArtifactWindowContent preview={preview} files={files.current} />}
  </AnnotationDraftProvider></Tooltip.Provider>;
}
function ArtifactWindowContent({preview,files}: {preview:DesktopArtifactWindowRequest;files:Map<string,File>}): React.JSX.Element {
  const draft = useAnnotationDraft();
  const [src,setSrc] = useState<string>();
  const [error,setError] = useState<string>();
  const [actions,setActions] = useState<readonly IconGroupAction[]>([]);
  const [sending,setSending] = useState(false);
  useEffect(() => {
    if (preview.kind !== 'generated' || !preview.mimeType.startsWith('image/')) { setSrc(undefined); return; }
    const url = URL.createObjectURL(new Blob([Uint8Array.from(preview.content)],{type:preview.mimeType})); setSrc(url);
    return () => URL.revokeObjectURL(url);
  },[preview]);
  const send = async (): Promise<void> => {
    if (!draft || sending) return;
    setSending(true); setError(undefined);
    try {
      const pins = await Promise.all(draft.pins.map(async (pin) => {
        const image = pin.annotation.content.imageAttachmentId ? files.get(pin.annotation.content.imageAttachmentId) : undefined;
        return { annotation:pin.annotation,...(image ? {image:new Uint8Array(await image.arrayBuffer())} : {}) };
      }));
      if (!await window.rally?.returnArtifactAnnotations?.(pins)) throw new Error('Open the original conversation to add these pins.');
      draft.clear(draft.pins.map((p)=>p.id));
    } catch(e) { setError(e instanceof Error?e.message:'The pins could not be added.'); }
    finally {setSending(false);}
  };
  return <DetailHeaderActionsHost onActions={setActions}><main className="artifact-annotation-window"><header><strong>{preview.title}</strong><span>v{preview.version}</span><IconGroup actions={actions.filter((a)=>a.key==='comment-mode').map((a)=>({...a,alwaysVisible:true}))} /></header>
    {preview.kind==='generated' ? <div className="artifact-annotation-window-body"><AnnotationSurface resourceId={preview.resourceId} version={preview.version} name={preview.title} mimeType={preview.sourceMimeType ?? preview.mimeType} src={src} text={preview.mimeType.startsWith('image/')?undefined:new TextDecoder().decode(preview.content)} /></div>
      : <ArtifactSiteWindow preview={preview} />}
    <footer><AnnotationChips />{error && <p role="alert">{error}</p>}<button disabled={!draft?.pins.length||draft.uploading||sending} onClick={()=>void send()} type="button">{sending?'Adding pins…':'Add pins to message'}</button></footer>
  </main></DetailHeaderActionsHost>;
}

function ArtifactSiteWindow({preview}: {preview: Extract<DesktopArtifactWindowRequest,{kind:'site'}>}): React.JSX.Element {
  const options = useMemo(() => {
    const bridge=desktopBridge();
    return {openArtifact:async()=>({openUrl:preview.url,canonicalUrl:new URL('/',preview.url).href,artifactId:preview.artifactId,mode:'static' as const,stateful:false}), describeData:async()=>({tables:[]}),loadTable:async()=>({rows:[],csv:''}),
      surface:{present:bridge.presentArtifactPreview,setBounds:bridge.setArtifactPreviewBounds,snapshot:bridge.snapshotArtifactPreview,pick:bridge.pickArtifactPreview,stopPicking:bridge.stopPickingArtifactPreview,close:bridge.closeArtifactPreview,popOut:async()=>false,copyText:bridge.copyText,openExternal:bridge.openExternal}};
  },[preview]);
  return <SiteResourceDetail resourceId={preview.resourceId} version={preview.version} title={preview.title} {...options} />;
}
