import { SITE_MANIFEST_MIME_TYPE, ResourceSchema, ResourceRevisionSchema } from '@rally/contracts';
import { z } from 'zod';
import { isDiagnosticCode, zodDiagnosticCode } from '@rally/contracts/zod-diagnostics';
import { InspectorRail } from '../components/inspector-rail';
import { mapResource, mapResourceVersion } from '../lib/api';
import type { WorkstreamResource, ResourceVersion } from '../lib/types';
import type { ArtifactWindowAction } from '../../common/artifact-window-actions';
import { useEffect, useRef, useState, useMemo } from 'react';
import type { DesktopArtifactWindowRequest } from '../../common/desktop';
import { AnnotationDraftProvider, AnnotationChips, useAnnotationDraft } from '../components/artifact-annotations';
import { AnnotationSurface } from '../components/annotation-surface';
import { SiteResourceDetail } from '../components/site-resource-detail';
import { desktopBridge } from '../lib/platform';
import * as Tooltip from '@radix-ui/react-tooltip';

function actionFailure(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.replace(/^Error invoking remote method 'artifact:window-action': Error: /u, '') : '';
  const diagnostic = zodDiagnosticCode(error, 'artifact_window_response') ?? (isDiagnosticCode(message) ? message : null);
  return diagnostic ? `${fallback} (${diagnostic})` : fallback;
}

async function command(action: ArtifactWindowAction): Promise<unknown> {
  const execute = window.rally?.artifactWindowAction;
  if (!execute) throw new Error('Artifact actions are unavailable.');
  return execute(action);
}

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
export function ArtifactWindowContent({preview: request,files}: {preview:DesktopArtifactWindowRequest;files:Map<string,File>}): React.JSX.Element {
  const [selected, setSelected] = useState<DesktopArtifactWindowRequest | null>(null);
  const preview = selected ?? request;
  const [resource, setResource] = useState<WorkstreamResource>();
  const [versions, setVersions] = useState<ResourceVersion[]>();
  const [versionsFailed, setVersionsFailed] = useState(false);
  const [pinned, setPinned] = useState<boolean>();
  const [error,setError] = useState<string>();
  const editable = request.editable === true && Boolean(request.annotationScope?.endsWith(':0'));
  useEffect(() => {
    setSelected(null);
    if (!window.rally?.artifactWindowAction) return;
    let active = true;
    void command({ type: 'read' }).then((value) => {
      if (active) setResource({ ...mapResource(ResourceSchema.parse(value)), direction: 'artifact' });
    }).catch((error: unknown) => { if (active) setError(actionFailure(error, 'Artifact details could not be loaded.')); });
    setVersionsFailed(false);
    void command({ type: 'versions' }).then((value) => {
      if (active) setVersions(z.array(ResourceRevisionSchema).parse(value).map(mapResourceVersion));
    }).catch((error: unknown) => { if (active) { setVersionsFailed(true); if (zodDiagnosticCode(error, 'artifact_window_response')) setError(actionFailure(error, 'Version history could not be loaded.')); } });
    const refreshPin = (): void => {
      if (editable) void command({ type: 'pin-state' }).then((value) => {
        if (active) setPinned(z.boolean().parse(value));
      }).catch((error: unknown) => { if (active) setError(actionFailure(error, 'The pin state could not be loaded.')); });
    };
    refreshPin();
    window.addEventListener('focus', refreshPin);
    return () => { active = false; window.removeEventListener('focus', refreshPin); };
  }, [request, editable]);
  const currentResource: WorkstreamResource = resource ?? {
    id: request.resourceId, title: request.title, currentVersion: request.version,
    mimeType: preview.kind === 'site' ? SITE_MANIFEST_MIME_TYPE : preview.sourceMimeType ?? preview.mimeType,
    resourceType: preview.kind === 'site' ? 'site' : 'file', direction: 'artifact', relationshipType: 'attachment',
    refreshSupported: false, watchEnabled: false, watchStatus: 'unsupported', contentAvailable: true,
  };
  const shownResource = selected ? { ...currentResource, title: selected.title, currentVersion: selected.version } : currentResource;
  const loadContent = async (original: boolean, version?: number): Promise<Blob> => {
    const value = z.object({ content: z.instanceof(Uint8Array), mimeType: z.string() }).parse(await command({ type: 'content', original, ...(version ? { version } : {}) }));
    return new Blob([Uint8Array.from(value.content)], { type: value.mimeType });
  };
  const draft = useAnnotationDraft();
  const [src,setSrc] = useState<string>();
  const [sending,setSending] = useState(false);
  useEffect(() => {
    if (preview.kind !== 'generated' || !/^(image|audio|video)\//u.test(preview.mimeType)) { setSrc(undefined); return; }
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
  return <main className="artifact-annotation-window">
    <InspectorRail
      panel={{ resourceId: preview.resourceId, onClose: () => window.close(), detached: true,
        ...(!request.annotationScope ? { commentDisabledReason: 'Open this artifact from a conversation to comment on it.' } : {}) }}
      resource={shownResource}
      resourceVersions={versions}
      resourceVersionsFailed={versionsFailed}
      {...(editable ? {
        onRenameResource: async (_resource: WorkstreamResource, title: string) => {
          await command({ type: 'rename', title });
          setResource((current) => ({ ...(current ?? currentResource), title }));
        },
        onDetachResource: async () => { await command({ type: 'archive' }); window.close(); },
        resourceLink: () => async () => { await desktopBridge().copyText(z.string().parse(await command({ type: 'link' }))); },
        resourcePin: () => pinned === undefined ? undefined : { on: pinned, onChange: (next: boolean) => {
          void command({ type: 'pin', pinned: next }).then(() => setPinned(next)).catch((error: unknown) => setError(actionFailure(error, 'The pin could not be updated.')));
        } },
      } : {})}
      loadOriginalResourceContent={() => loadContent(true, selected?.version)}
      onOpenResourceVersion={request.kind === 'site' ? undefined : (_resource, version) => {
        void loadContent(false, version.version).then(async (blob) => {
          setSelected({ kind: 'generated', resourceId: preview.resourceId, version: version.version,
            title: version.title ?? preview.title, mimeType: blob.type, content: new Uint8Array(await blob.arrayBuffer()),
            ...(preview.annotationScope ? { annotationScope: preview.annotationScope } : {}) });
        }).catch((error: unknown) => setError(actionFailure(error, 'The version could not be opened.')));
      }}
    >
    {selected && <p className="attachment-lightbox-superseded attachment-panel-superseded" role="status">Version {selected.version} · not current <button onClick={() => setSelected(null)} type="button">Return to current</button></p>}
    {preview.kind==='generated' ? <div className="artifact-annotation-window-body">{preview.mimeType.startsWith('audio/') ? <audio controls src={src} aria-label={preview.title} /> : preview.mimeType.startsWith('video/') ? <video controls src={src} aria-label={preview.title} /> : <AnnotationSurface resourceId={preview.resourceId} version={preview.version} name={preview.title} mimeType={preview.sourceMimeType ?? preview.mimeType} src={src} text={preview.mimeType.startsWith('image/')?undefined:new TextDecoder().decode(preview.content)} />}</div>
      : <ArtifactSiteWindow preview={preview} />}
    </InspectorRail>
    <footer><AnnotationChips />{error && <p role="alert">{error}</p>}<button disabled={!preview.annotationScope||!draft?.pins.length||draft.uploading||sending} onClick={()=>void send()} type="button">{sending?'Adding pins…':'Add pins to message'}</button></footer>
  </main>;
}

function ArtifactSiteWindow({preview}: {preview: Extract<DesktopArtifactWindowRequest,{kind:'site'}>}): React.JSX.Element {
  const options = useMemo(() => {
    const bridge=desktopBridge();
    // The initial navigation was minted by the parent. Every departure mints again.
    let initial = true;
    return {openArtifact:async()=>{
      if (initial && preview.stateful !== undefined) { initial = false; return {openUrl:preview.url,canonicalUrl:preview.canonicalUrl ?? new URL('/',preview.url).href,artifactId:preview.artifactId,mode:preview.mode ?? 'static',stateful:preview.stateful ?? false}; }
      initial = false;
      return z.object({ openUrl:z.string(), canonicalUrl:z.string(), artifactId:z.string(), mode:z.enum(['static','active']), stateful:z.boolean() }).parse(await command({ type:'open' }));
    }, describeData:async()=>z.object({tables:z.array(z.object({name:z.string(),columns:z.array(z.object({name:z.string(),type:z.string()})),rowCount:z.number()}))}).parse(await command({type:'data'})),
    loadTable:async(_resourceId:string,table:string)=>z.object({rows:z.array(z.record(z.string(),z.unknown())),csv:z.string()}).parse(await command({type:'table',table})),
      surface:{present:bridge.presentArtifactPreview,setBounds:bridge.setArtifactPreviewBounds,snapshot:bridge.snapshotArtifactPreview,pick:bridge.pickArtifactPreview,stopPicking:bridge.stopPickingArtifactPreview,comments:bridge.showArtifactPreviewComments,close:bridge.closeArtifactPreview,popOut:async()=>false,copyText:bridge.copyText,openExternal:bridge.openExternal}};
  },[preview]);
  return <SiteResourceDetail resourceId={preview.resourceId} version={preview.version} title={preview.title} {...options} />;
}
