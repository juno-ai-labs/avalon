import { isComposingKeyEvent } from '@rally/ui/lib/ime';
import { createContext, useContext, useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from 'react';
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
  readResourceVersion?: ((id:string,version:number,signal:AbortSignal)=>Promise<Blob>) | undefined;
  upload?: ((file: File) => Promise<string>) | undefined;
  add: (annotation: Annotation, name: string, reveal: () => boolean | void, replaceId?: string) => string;
  remove: (id: string) => void;
  comment: (id: string, comment: string) => void;
  clear: (ids: string[]) => void;
  setPreviewOpener: (open:((preview:AttachmentPreview)=>void)|null)=>void;
  reveal: (pin:AnnotationPin)=>boolean;
}
const Context = createContext<AnnotationDraft | null>(null);
export const useAnnotationDraft = (): AnnotationDraft | null => useContext(Context);
export function AnnotationDraftProvider({ children, upload, readResource, readResourceVersion, scopeKey }: { children: ReactNode; readResourceVersion?: ((id:string,version:number,signal:AbortSignal)=>Promise<Blob>) | undefined; scopeKey?: string; readResource?: ((id: string) => Promise<{ currentVersion: number }>) | undefined; upload?: ((file: File) => Promise<string>) | undefined }): React.JSX.Element {
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
      const transferUpload=uploadRef.current;
      void (async () => {
        const incoming: AnnotationPin[] = [];
        for (const pin of value.pins) {
          const annotation = structuredClone(pin.annotation);
          if (pin.image) {
            if (!transferUpload) throw new Error('Annotation image upload unavailable');
            annotation.content.imageAttachmentId = await transferUpload(new File([Uint8Array.from(pin.image)], `Annotation — ${value.name}.png`, { type: 'image/png' }));
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
  const readers=useRef({readResource,readResourceVersion}); readers.current={readResource,readResourceVersion};
  const read=useCallback((id:string)=>readers.current.readResource!(id),[]);
  const readVersion=useCallback((id:string,version:number,signal:AbortSignal)=>readers.current.readResourceVersion!(id,version,signal),[]);
  const reveal=useCallback((pin:AnnotationPin):boolean=>{if(pin.reveal()===false){previewOpener.current?.({name:pin.name,resourceId:pin.annotation.target.resourceId,annotation:pin.annotation});return false;}return true;},[]);
  const add=useCallback((annotation:Annotation,name:string,reveal:AnnotationPin['reveal'],replaceId?:string):string=>{
    const id=replaceId??crypto.randomUUID();
    if(scopeRef.current!==scopeKey)return id;
    setPins((current)=>[...current.filter((pin)=>pin.id!==id),{id,annotation,name,reveal}]);
    return id;
  },[scopeKey]);
  const remove=useCallback((id:string)=>setPins((current)=>current.filter((pin)=>pin.id!==id)),[]);
  const comment=useCallback((id:string,comment:string)=>setPins((current)=>current.map((pin)=>pin.id===id?{...pin,annotation:{...pin.annotation,comment}}:pin)),[]);
  const clear=useCallback((ids:string[])=>setPins((current)=>current.filter((pin)=>!ids.includes(pin.id))),[]);
  const uploadFile=useCallback(async(file:File):Promise<string>=>{if(scopeRef.current!==scopeKey)throw new Error('The conversation changed.');const upload=uploadRef.current;if(!upload)throw new Error('Annotation image upload unavailable');setUploads((count)=>count+1);try{return await upload(file);}finally{setUploads((count)=>count-1);}},[scopeKey]);
  const value=useMemo(()=>({setPreviewOpener,reveal,pins,scopeKey,uploading:uploads>0,readResource:readResource?read:undefined,readResourceVersion:readResourceVersion?readVersion:undefined,upload:upload?uploadFile:undefined,add,remove,comment,clear}),[setPreviewOpener,reveal,pins,scopeKey,uploads,Boolean(readResource),read,Boolean(readResourceVersion),readVersion,Boolean(upload),uploadFile,add,remove,comment,clear]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function AnnotationChips(): React.JSX.Element | null {
  const draft = useAnnotationDraft();
  const [editing,setEditing] = useState<string|null>(null);
  if (!draft?.pins.length) return null;
  return <div className="annotation-chips" aria-label="Annotation pins">{draft.pins.map((pin, i) => <div className="annotation-chip" key={pin.id}>
    <button className="annotation-chip-quote" onClick={() => { setEditing(draft.reveal(pin)?null:pin.id); }} type="button"><span className="annotation-number">{i + 1}</span><span><q>{annotationQuote(pin.annotation, pin.name)}</q>{pin.annotation.comment && <small>{pin.annotation.comment}</small>}</span></button>
    <button aria-label={`Remove pin ${i + 1}`} onClick={() => draft.remove(pin.id)} type="button">×</button>
    {editing===pin.id && <textarea autoFocus aria-label={`Comment on pin ${i+1}`} placeholder="Ask Rally to change this…" value={pin.annotation.comment} onChange={(e)=>draft.comment(pin.id,e.target.value)} onKeyDown={(e)=>{if(isComposingKeyEvent(e.nativeEvent))return;if((e.key==='Enter'&&!e.shiftKey)||e.key==='Escape'){e.preventDefault();e.stopPropagation();setEditing(null);}}} />}
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
