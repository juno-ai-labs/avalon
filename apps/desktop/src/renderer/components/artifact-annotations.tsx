import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import { AnnotatedMessageContentSchema, type Annotation } from '@rally/contracts';
import type { AttachmentPreview } from './attachments';

/** Website markup is agent context; people see the selected visible words. */
export function annotationQuote(annotation: Annotation, name: string): string {
  const locator = annotation.target.locator;
  if (locator.type === 'element') return locator.visibleText.replace(/\s+/gu, ' ').trim() || 'Selected area';
  return annotation.content.exact || name;
}

export interface AnnotationPin { id: string; annotation: Annotation; name: string; reveal: () => boolean | void }
interface AnnotationDraft {
  scopeKey?: string | undefined;
  pins: AnnotationPin[];
  uploading: boolean;
  readResource?: ((id: string) => Promise<{ currentVersion: number }>) | undefined;
  upload?: ((file: File) => Promise<string>) | undefined;
  add: (annotation: Annotation, name: string, reveal: () => boolean | void, replaceId?: string) => string;
  remove: (id: string) => void;
  comment: (id: string, comment: string) => void;
  clear: (ids: string[]) => void;
  setPreviewOpener: (open:((preview:AttachmentPreview)=>void)|null)=>void;
  reveal: (pin:AnnotationPin)=>void;
}
const Context = createContext<AnnotationDraft | null>(null);
export const useAnnotationDraft = (): AnnotationDraft | null => useContext(Context);
export function AnnotationDraftProvider({ children, upload, readResource, scopeKey }: { children: ReactNode; scopeKey?: string; readResource?: ((id: string) => Promise<{ currentVersion: number }>) | undefined; upload?: ((file: File) => Promise<string>) | undefined }): React.JSX.Element {
  const [uploads, setUploads] = useState(0);
  const [pins, setPins] = useState<AnnotationPin[]>([]);
  const [heldScope,setHeldScope]=useState(scopeKey);
  const scopeRef=useRef(scopeKey);scopeRef.current=scopeKey;
  // Reset the draft without remounting the conversation and losing its
  // in-flight history requests when navigation moves between conversations.
  if(heldScope!==scopeKey){setHeldScope(scopeKey);setPins([]);}
  const previewOpener=useRef<((preview:AttachmentPreview)=>void)|null>(null);
  const setPreviewOpener=useCallback((open:((preview:AttachmentPreview)=>void)|null):void=>{previewOpener.current=open;},[]);
  const uploadRef = useRef(upload);
  uploadRef.current = upload;
  useEffect(() => {
    if (!scopeKey) return;
    void window.rally?.registerAnnotationComposer?.(scopeKey, true);
    const stop = window.rally?.onArtifactAnnotations?.((value) => {
      if (value.scope !== scopeKey) return;
      void (async () => {
        const incoming: AnnotationPin[] = [];
        for (const pin of value.pins) {
          const annotation = structuredClone(pin.annotation);
          if (pin.image) {
            if (!uploadRef.current) throw new Error('Annotation image upload unavailable');
            annotation.content.imageAttachmentId = await uploadRef.current(new File([Uint8Array.from(pin.image)], `Annotation — ${value.name}.png`, { type: 'image/png' }));
          }
          incoming.push({ id: crypto.randomUUID(), annotation, name: value.name, reveal: () => false });
        }
        if(scopeRef.current!==scopeKey)throw new Error('Annotation composer changed');
        setPins((current) => [...current, ...incoming]);
        await window.rally?.completeArtifactAnnotationTransfer?.(value.transferId,true);
      })().catch(() => {void window.rally?.completeArtifactAnnotationTransfer?.(value.transferId,false);});
    });
    return () => { stop?.(); void window.rally?.registerAnnotationComposer?.(scopeKey, false); };
  }, [scopeKey]);
  return <Context.Provider value={{ setPreviewOpener, reveal:(pin)=>{if(pin.reveal()===false)previewOpener.current?.({name:pin.name,resourceId:pin.annotation.target.resourceId,annotation:pin.annotation});}, pins, scopeKey, uploading: uploads > 0, readResource,
    upload: upload ? async (file) => { setUploads((n) => n + 1); try { return await upload(file); } finally { setUploads((n) => n - 1); } } : undefined,
    add: (annotation, name, reveal, replaceId) => {
      const id = replaceId ?? crypto.randomUUID();
      if(scopeRef.current!==scopeKey)return id;
      setPins((current) => [...current.filter((p) => p.id !== id), { id, annotation, name, reveal }]);
      return id;
    },
    remove: (id) => setPins((current) => current.filter((p) => p.id !== id)),
    comment: (id, comment) => setPins((current) => current.map((p) => p.id === id ? { ...p, annotation: { ...p.annotation, comment } } : p)),
    clear: (ids) => setPins((current) => current.filter((p) => !ids.includes(p.id))),
  }}>{children}</Context.Provider>;
}
export function AnnotationChips(): React.JSX.Element | null {
  const draft = useAnnotationDraft();
  if (!draft?.pins.length) return null;
  return <div className="annotation-chips" aria-label="Annotation pins">{draft.pins.map((pin, i) => <div className="annotation-chip" key={pin.id}>
    <button className="annotation-chip-quote" onClick={() => draft.reveal(pin)} type="button"><span className="annotation-number">{i + 1}</span><span><q>{annotationQuote(pin.annotation, pin.name)}</q>{pin.annotation.comment && <small>{pin.annotation.comment}</small>}</span></button>
    <button aria-label={`Remove pin ${i + 1}`} onClick={() => draft.remove(pin.id)} type="button">×</button>
  </div>)}</div>;
}
export function MessageAnnotations({ content, onOpen }: { content: unknown; onOpen?: ((preview: AttachmentPreview) => void) | undefined }): React.JSX.Element | null {
  const parsed = AnnotatedMessageContentSchema.safeParse(content);
  if (!parsed.success) return null;
  return <div className="message-annotations">{parsed.data.annotations.map((annotation, i) => {
    const name = parsed.data.names?.[annotation.target.resourceId] ?? 'Artifact';
    return <button className="message-annotation" key={i} onClick={() => onOpen?.({ name, resourceId: annotation.target.resourceId, annotation })} type="button">
      <small><span className="annotation-number">{i + 1}</span>{name} · v{annotation.target.version}</small>
      <q>{annotationQuote(annotation, name)}</q>{annotation.comment && <span>{annotation.comment}</span>}
    </button>;
  })}</div>;
}
