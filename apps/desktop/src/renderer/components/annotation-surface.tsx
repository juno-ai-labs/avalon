import { isComposingKeyEvent } from '@rally/ui/lib/ime';
import { Tip } from './primitives';
import { annotationRange } from '../lib/annotation-cells';
import { resolveAnnotationCells } from '../lib/annotation-cells';
import { IconPointerCollaboration } from '@tabler/icons-react';
import { useDetailHeaderActions } from './detail-header-actions';
import { AnnotationSheet } from './annotation-sheet';
import { useEffect, useRef, useState, useMemo } from 'react';
import { ARTIFACT_COMMENT_CURSOR, isHtmlResource, ANNOTATION_CONTEXT_CHARACTERS, AnnotationCommentActionSchema, ArtifactPickerPinSchema, AnnotationLocatorSchema, buildAnnotation, classifyAttachmentKind, type Annotation, type AnnotationLocator } from '@rally/contracts';
import { AnchoredAnnotationComment, AnnotationComment, annotationQuote, useAnnotationDraft } from './artifact-annotations';
import { annotationDomRange, sourceSelectionPoint } from '../lib/annotation-source';
import { MarkdownBody } from './workstream-blocks';

export function annotationHtml(source: string, nonce?: string, saved?: Annotation, picking = true): string {
  const policy = `default-src 'none'; img-src data: blob:; font-src data:; style-src 'unsafe-inline';${nonce ? ` script-src 'nonce-${nonce}';` : ''}`;
  // Policy and trusted script precede file markup, including malformed heads.
  const scriptUrl = new URL('/annotation-frame.js',window.location.href).href;
  const data = saved?.target.locator.type === 'element' ? JSON.stringify({locator:saved.target.locator,exact:saved.content.exact}).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;') : '';
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"></head><body>${nonce ? `<script nonce="${nonce}" data-annotation-picking="${picking}" src="${scriptUrl}"${data ? ` data-annotation-saved="${data}"` : ''}></script>` : ''}${source}</body></html>`;
}
export interface AnnotationSurfaceProps {
  className?: string | undefined;
  preparePicking?: (()=>Promise<void>) | undefined;
  resourceId: string;
  version: number;
  name: string;
  mimeType?: string | null | undefined;
  sizeBytes?: number | undefined;
  text?: string | undefined;
  src?: string | undefined;
  saved?: Annotation | undefined;
  loadSavedImage?: ((signal?: AbortSignal) => Promise<Blob>) | undefined;
}
const highlightedRanges = new Map<string, Range[]>();
const blockSelector = 'p,li,pre,blockquote,h1,h2,h3,h4,h5,h6,table,td,th,[data-annotation-paragraph],[data-annotation-container]';
export function AnnotationSurface(props: AnnotationSurfaceProps): React.JSX.Element {
  const { resourceId, version, name, mimeType, text, src, saved } = props;
  const draft = useAnnotationDraft();
  const [picking, setPicking] = useState(false);
  const retry=draft?.retry;
  useEffect(()=>{retry?.();},[resourceId,version,retry]);
  useEffect(()=>{if(draft?.repairing && draft.pins.some((pin)=>pin.id===draft.repairing&&pin.annotation.target.resourceId===resourceId))setPicking(true);},[draft?.repairing,resourceId]);
  const [hover, setHover] = useState<{ element: HTMLElement; start: number; end: number } | null>(null);
  const leaf = useRef<HTMLElement | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [anchor, setAnchor] = useState({ x: 12, y: 60 });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preparing,setPreparing]=useState(false);
  const [imageReady,setImageReady]=useState(false);
  const [missing, setMissing] = useState(false);
  useEffect(()=>{setImageReady(false);setMissing(false);},[src]);
  const surfaceKey = useRef(crypto.randomUUID());
  const hoverLevel = useRef(0);
  const lastPin = useRef<string | undefined>(undefined);
  const startDrag = useRef<{ x: number; y: number } | null>(null);
  const [draftRegion, setDraftRegion] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [imageHover,setImageHover]=useState(false);
  const kind = classifyAttachmentKind({ fileName: name, mimeType: mimeType ?? null });
  const html = isHtmlResource({fileName:name,mimeType});
  const nonce = useMemo(() => crypto.randomUUID().replaceAll('-', ''), [resourceId,version,picking,text,saved]);
  const [savedImage,setSavedImage]=useState<string>();
  useEffect(() => {
    if (!props.loadSavedImage) return;
    const controller=new AbortController(); let url:string|undefined;
    void props.loadSavedImage(controller.signal).then((blob)=>{if(!controller.signal.aborted){url=URL.createObjectURL(blob);setSavedImage(url);}}).catch(()=>{});
    return ()=>{controller.abort();if(url)URL.revokeObjectURL(url);};
  },[props.loadSavedImage]);
  const htmlPins = draft?.pins.filter((pin)=>pin.annotation.target.resourceId===resourceId && pin.annotation.target.version===version) ?? [];
  const syncHtmlComments = (): void => frame.current?.contentWindow?.postMessage({type:'rally-annotation-comments',pins:htmlPins.filter((pin)=>pin.id!==editing).map(({id,annotation})=>({id,annotation}))},'*');
  useEffect(()=>{if(html)syncHtmlComments();},[draft?.pins,editing,html]);
  useEffect(()=>{
    if(!html)return;
    const receive=(event:MessageEvent):void=>{
      if(event.source!==frame.current?.contentWindow || event.data?.type!=='rally-annotation-comment-action')return;
      const parsed=AnnotationCommentActionSchema.safeParse(event.data.action);
      if(!parsed.success || !htmlPins.some((pin)=>pin.id===parsed.data.id))return;
      if(parsed.data.action==='remove')draft?.remove(parsed.data.id);
      else {const box=frame.current?.getBoundingClientRect();if(box && parsed.data.point)setAnchor({x:box.x+parsed.data.point.x,y:box.y+parsed.data.point.y-12});setEditing(parsed.data.id);}
    };
    window.addEventListener('message',receive);return()=>window.removeEventListener('message',receive);
  },[html,draft,htmlPins]);
  const current = draft?.selections.find((p) => p.id === editing);

  const commit = (locator: AnnotationLocator, exact: string, start = 0, end = 0, replace = false, imageAttachmentId?: string, context?: {before?:string;after?:string}): void => {
    if (!draft) return;
    const annotation = buildAnnotation({ target: { resourceId, version, locator }, content: { exact,
      source: locator.type === 'element' ? 'rendered' : ['pdf', 'document', 'presentation', 'spreadsheet'].includes(kind) ? 'converted' : 'exact',
      before: context?.before ?? text?.slice(Math.max(0, start - ANNOTATION_CONTEXT_CHARACTERS), start) ?? '', after: context?.after ?? text?.slice(end, end + ANNOTATION_CONTEXT_CHARACTERS) ?? '', truncated: false,
      ...(imageAttachmentId ? { imageAttachmentId } : {}),
    }, comment: replace ? draft.selections.find((p) => p.id === lastPin.current)?.annotation.comment ?? '' : '' });
    let pinId = '';
    const reveal = (): boolean => { if(!root.current?.isConnected)return false; const range = text !== undefined && 'start' in locator && root.current ? annotationDomRange(root.current,text,locator.start,locator.end) : null; (range?.startContainer.parentElement ?? root.current)?.scrollIntoView({ block:'center' }); setEditing(pinId); return true; };
    const id = draft.add(annotation, name, reveal, replace ? lastPin.current : undefined, true);
    pinId = id;
    lastPin.current = id; setEditing(id);
  };
  const resolveCommentAnchor = (annotation: Annotation): DOMRect | null => {
    const container = root.current;
    if (!container) return null;
    const locator = annotation.target.locator;
    if ('start' in locator && text !== undefined) {
      const range = annotationDomRange(container,text,locator.start,locator.end);
      if (range?.getBoundingClientRect) return range.getBoundingClientRect();
      return [...container.querySelectorAll<HTMLElement>('[data-annotation-start]')].find((node) => Number(node.dataset.annotationStart) <= locator.start && Number(node.dataset.annotationEnd) >= locator.end)?.getBoundingClientRect() ?? null;
    }
    if (locator.type === 'region') {
      const image = container.querySelector('img')?.getBoundingClientRect();
      return image ? new DOMRect(image.x+image.width*locator.x,image.y+image.height*locator.y,image.width*locator.w,image.height*locator.h) : null;
    }
    if (locator.type === 'cells') {
      const range = annotationRange(locator.range);
      const sheet = container.querySelector<HTMLElement>('[data-annotation-sheet]');
      if (!range || sheet?.dataset.annotationSheet !== locator.sheet) return null;
      return sheet.querySelector(`[data-annotation-cell="${range.start[0]},${range.start[1]}"]`)?.getBoundingClientRect() ?? null;
    }
    return locator.type === 'file' ? container.querySelector('.annotation-body')?.getBoundingClientRect() ?? null : null;
  };
  const offsets = (element: HTMLElement): { element: HTMLElement; start: number; end: number } | null => {
    if (text === undefined) return null;
    if (element.dataset.annotationStart !== undefined) return { element, start: Number(element.dataset.annotationStart), end: Number(element.dataset.annotationEnd) };
    const container=element.closest<HTMLElement>('[data-annotation-start]');
    if(container)return{element:container,start:Number(container.dataset.annotationStart),end:Number(container.dataset.annotationEnd)};
    if (element.tagName === 'PRE') return { element, start: 0, end: text.length };
    return null;
  };
  const locatorFor = (start: number, end: number): AnnotationLocator => {
    const headingPath = [...(text?.slice(0, start).matchAll(/^(#{1,6})\s+(.+)$/gmu) ?? [])].reduce<string[]>((path, h) => { path.length = Math.min(path.length, (h[1]?.length ?? 1) - 1); path.push(h[2] ?? ''); return path; }, []);
    if (kind === 'pdf') return { type: 'pdf-text', start, end, page: Number([...(text?.slice(0,start).matchAll(/^# Page (\d+)/gmu) ?? [])].at(-1)?.[1] ?? 1) };
    if (kind === 'document') return { type: 'document-text', start, end, headingPath };
    if (kind === 'presentation') return { type: 'slide-text', start, end, slide: Number([...(text?.slice(0, start).matchAll(/^# Slide (\d+)/gmu) ?? [])].at(-1)?.[1] ?? 1) };
    if (kind === 'markdown') return { type: 'markdown', start, end, headingPath };
    return { type: 'text', start, end, lines: [(text?.slice(0, start).split('\n').length ?? 1), (text?.slice(0, end).split('\n').length ?? 1)] };
  };
  const grow = (up: boolean): void => {
    if (!hover || !leaf.current || !root.current || text === undefined) return;
    const chain: { element: HTMLElement; start: number; end: number }[] = [];
    let node: HTMLElement | null = leaf.current;
    while (node && root.current.contains(node)) {
      const item = offsets(node);
      if (item && !chain.some((entry) => entry.start === item.start && entry.end === item.end)) chain.push(item);
      node = node.parentElement?.closest<HTMLElement>('[data-annotation-start]') ?? null;
    }
    const headings = [...text.matchAll(/^(#{1,6})\s+.+$/gmu)];
    let level = 7;
    for (const h of headings.filter((h) => h.index <= hover.start).reverse()) {
      const depth = h[1]?.length ?? 1;
      if (depth >= level) continue;
      const next = headings.find((next) => next.index > h.index && (next[1]?.length ?? 1) <= depth);
      const item = { element: leaf.current, start: h.index, end: next?.index ?? text.length };
      if (!chain.some((entry) => entry.start === item.start && entry.end === item.end)) chain.push(item);
      level = depth;
    }
    hoverLevel.current = Math.min(chain.length - 1, Math.max(0, hoverLevel.current + (up ? 1 : -1)));
    setHover(chain[hoverLevel.current] ?? hover);
  };
  useEffect(() => {
    if(!picking)return;
    const key=(event:KeyboardEvent):void=>{
      if(isComposingKeyEvent(event))return;
      if(event.target instanceof HTMLElement && event.target.closest('textarea,input,[role=menu],[role=dialog]'))return;
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(editing)draft?.discard(editing);setEditing(null);setPicking(false);return;}
      if(hover&&['Alt','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();event.stopPropagation();grow(event.key!=='ArrowDown');}
    };
    window.addEventListener('keydown',key,true);return()=>window.removeEventListener('keydown',key,true);
  });
  useEffect(() => {
    if ((!picking && !saved) || !html) return;
    const receive = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === 'rally-annotation-restored' && saved) { setMissing(event.data.resolved !== true); return; }
      if (!picking || event.data?.type !== 'rally-artifact-pin') return;
      if (event.data.pin === null) { if(editing)draft?.discard(editing);setEditing(null);setPicking(false); return; }
      const parsedPin = ArtifactPickerPinSchema.safeParse(event.data.pin);
      if (!parsedPin.success) return;
      const pin = parsedPin.data;
      const locator = AnnotationLocatorSchema.safeParse({ type: 'element', css: pin.css, box: pin.box, visibleText: pin.visibleText });
      if (!locator.success || typeof pin.html !== 'string') return;
      const frameBox = frame.current?.getBoundingClientRect();
      if (pin.point && frameBox) setAnchor({x:frameBox.x+pin.point.x,y:frameBox.y+pin.point.y});
      commit(locator.data, pin.html, 0, 0, pin.replace === true, undefined, pin);
    };
    window.addEventListener('message', receive); return () => window.removeEventListener('message', receive);
  });
  useEffect(() => {
    const container = root.current;
    if (!container) return;
    container.querySelectorAll('[data-annotation-start].annotation-highlight').forEach((e) => e.classList.remove('annotation-highlight'));
    const pins = saved ? [saved] : (draft?.selections.filter((p) => p.annotation.target.resourceId === resourceId && p.annotation.target.version === version).map((p) => p.annotation) ?? []);
    let resolved = !saved;
    const ranges: Range[] = [];
    for (const pin of pins) {
      const locator = pin.target.locator;
      if ('start' in locator && text?.slice(locator.start, locator.end) === pin.content.exact) {
        const candidates = [...container.querySelectorAll<HTMLElement>('[data-annotation-start]')];
        candidates.sort((a,b) => (Number(a.dataset.annotationEnd)-Number(a.dataset.annotationStart))-(Number(b.dataset.annotationEnd)-Number(b.dataset.annotationStart)));
        const match = candidates.find((e) => Number(e.dataset.annotationStart) <= locator.start && Number(e.dataset.annotationEnd) >= locator.end && !e.querySelector('[data-annotation-start]'))
          ?? candidates.find((e) => Number(e.dataset.annotationStart) === locator.start);
        const range = text === undefined ? null : annotationDomRange(container,text,locator.start,locator.end);
        if (range) { ranges.push(range); if (saved) range.startContainer.parentElement?.scrollIntoView({block:'center'}); resolved=true; }
        else if (match) { match.classList.add('annotation-highlight'); if (saved) match.scrollIntoView({ block: 'center' }); resolved = true; }
      }
      if (locator.type === 'cells' && text !== undefined && (!saved || resolveAnnotationCells(text,locator.sheet,locator.range,pin.content.exact))) resolved = true;
      if (locator.type === 'file') resolved = true;
      if (locator.type === 'region' && src && imageReady) resolved = true;
    }
    highlightedRanges.set(surfaceKey.current,ranges);
    if (typeof Highlight !== 'undefined') CSS.highlights.set('rally-annotations',new Highlight(...[...highlightedRanges.values()].flat()));
    if(saved?.target.locator.type==='element'&&text!==undefined)return;
    if(saved?.target.locator.type==='region'&&src&&!imageReady)return;
    setMissing(!resolved);
    return () => { highlightedRanges.delete(surfaceKey.current); if (typeof Highlight !== 'undefined') CSS.highlights.set('rally-annotations',new Highlight(...[...highlightedRanges.values()].flat())); };
  }, [draft?.selections, resourceId, saved, src, text, version,imageReady]);
  useEffect(()=>{
    if(!picking||!root.current||typeof ResizeObserver==='undefined')return;
    const observer=new ResizeObserver(()=>setHover((current)=>current?{...current}:null));
    observer.observe(root.current);return()=>observer.disconnect();
  },[picking]);
  const imagePin = async (event: React.PointerEvent<HTMLImageElement>): Promise<void> => {
    const start = startDrag.current; startDrag.current = null;
    if (!picking || !start) return;
    const img = event.currentTarget; const rect = img.getBoundingClientRect();
    const end = { x: Math.max(0, Math.min(1, (event.clientX - rect.x) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.y) / rect.height)) };
    const selected = Math.hypot(end.x - start.x, end.y - start.y) < 0.01 ? { x: 0, y: 0, w: 1, h: 1 } : { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) };
    setDraftRegion(selected); setBusy(true); setError(null);
    try {
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(img.naturalWidth * selected.w)); canvas.height = Math.max(1, Math.round(img.naturalHeight * selected.h));
      canvas.getContext('2d')?.drawImage(img, selected.x * img.naturalWidth, selected.y * img.naturalHeight, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error('Crop failed')), 'image/png'));
      if (!draft?.upload) throw new Error('Image upload is unavailable');
      const id = await draft.upload(new File([blob], `Annotation — ${name}.png`, { type: 'image/png' }));
      commit({ type: 'region', ...selected }, `Region of ${name}`, 0, 0, false, id);
      setDraftRegion(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'The crop could not be uploaded.'); }
    finally { setBusy(false); }
  };
  const hoverRange = hover && text !== undefined && root.current ? annotationDomRange(root.current,text,hover.start,hover.end) : null;
  const hoverBox = hoverRange?.getBoundingClientRect?.() ?? hover?.element.getBoundingClientRect();
  const bodyBox = root.current?.querySelector('.annotation-body')?.getBoundingClientRect();
  const imageRegions=(saved?[saved]:(draft?.selections.filter((p)=>p.annotation.target.resourceId===resourceId&&p.annotation.target.version===version).map((p)=>p.annotation)??[])).flatMap((a)=>a.target.locator.type==='region'?[a.target.locator]:[]);
  const hoverRegion=draftRegion??(picking&&imageHover?{x:0,y:0,w:1,h:1}:null);
  const canPick = Boolean(draft && (version > 0 || props.preparePicking) && (!html || window.rally) && kind !== 'audio' && (text !== undefined || src || kind === 'other'));
  const disabledReason = html && !window.rally ? 'Website comments require the Rally Mac app.' : undefined;
  const showComment = canPick || Boolean(draft && version > 0 && html && disabledReason);
  const togglePicking = async ():Promise<void> => {
    if (preparing || !canPick) return;
    if (picking) {setPicking(false);return;}
    setPreparing(true);setError(null);
    try {if(version===0) await props.preparePicking?.();setPicking(true);} catch(e){setError(e instanceof Error?e.message:'The preview could not be prepared for comments.');} finally{setPreparing(false);}
  };
  const headerActions = useMemo(() => showComment ? [{key:'comment-mode', className:'annotation-mode-button', label:'Comment mode', disabledReason, disabled:preparing, icon:<IconPointerCollaboration aria-hidden="true" size={16} stroke={1.9} />, pressed:picking, onSelect:() => {void togglePicking();}}] : [], [showComment,disabledReason,canPick,picking,preparing,version,props.preparePicking]);
  const headerHosted = useDetailHeaderActions(headerActions);
  return <div className={`annotation-surface ${props.className??''}${picking ? ' is-picking' : ''}${kind === 'other' ? ' is-whole-file' : ''}`} ref={root} tabIndex={-1} style={{'--annotation-cursor':ARTIFACT_COMMENT_CURSOR} as React.CSSProperties}
>
    {showComment && !headerHosted && <div className="annotation-toolbar">{disabledReason ? <Tip label={disabledReason}><button aria-label="Comment mode" aria-disabled="true" aria-pressed={false} type="button"><IconPointerCollaboration aria-hidden="true" size={16} /> Comment mode</button></Tip> : <button aria-label="Comment mode" aria-pressed={picking} onClick={() => void togglePicking()} type="button"><IconPointerCollaboration aria-hidden="true" size={16} /> Comment mode</button>}</div>}
    <div className="annotation-body" onMouseLeave={() => setHover(null)} onScrollCapture={() => setHover((current) => current ? {...current} : null)} onPointerUpCapture={(e) => setAnchor({x:e.clientX,y:e.clientY})} onMouseMove={(e) => { if (!picking || html || kind === 'image' || (e.target as Element).closest('.annotation-comment')) return; const element = (e.target as Element).closest<HTMLElement>(blockSelector); if (!element || !root.current?.contains(element)) return; if (leaf.current !== element || !hover) { leaf.current = element; hoverLevel.current = 0; setHover(offsets(element)); } }}
      onClick={(e) => {
        if (picking && kind === 'other') { commit({type:'file'},`${name} · ${mimeType ?? 'unknown type'}${props.sizeBytes !== undefined ? ` · ${props.sizeBytes} bytes` : ''}`); return; }
        if (!picking || html || !text || kind === 'spreadsheet') return;
        e.preventDefault(); e.stopPropagation(); setAnchor({ x: e.clientX, y: e.clientY });
        const selection = window.getSelection(); let start: number | null = null; let end: number | null = null;
        if (selection?.rangeCount && !selection.isCollapsed && root.current?.contains(selection.anchorNode) && root.current.contains(selection.focusNode)) {
          const r = selection.getRangeAt(0); start = sourceSelectionPoint(r.startContainer, r.startOffset, text); end = sourceSelectionPoint(r.endContainer, r.endOffset, text);
        }
        if (start === null || end === null) { if (!hover) return; start = hover.start; end = hover.end; }
        commit(locatorFor(start, end), text.slice(start, end), start, end, e.detail > 1);
      }} onDoubleClick={(e) => { if (!picking || html || !text) return; e.preventDefault(); const sel = window.getSelection(); if (!sel?.rangeCount) return; const r = sel.getRangeAt(0); const start = sourceSelectionPoint(r.startContainer, r.startOffset, text); const end = sourceSelectionPoint(r.endContainer, r.endOffset, text); if (start !== null && end !== null && end > start) commit(locatorFor(start, end), text.slice(start,end), start,end,true); }}>
      {html && text !== undefined ? <iframe ref={frame} onLoad={syncHtmlComments} sandbox={(picking || saved || htmlPins.length > 0) && window.rally ? 'allow-scripts' : ''} srcDoc={annotationHtml(text, (picking || saved || htmlPins.length > 0) && window.rally ? nonce : undefined, picking ? undefined : saved, picking)} title={`Preview of ${name}`} />
        : src ? <div className="annotation-image"><img alt={name} style={{display:saved&&missing?'none':undefined}} src={src} onLoad={()=>setImageReady(true)} onError={()=>{setImageReady(false);setMissing(Boolean(saved));}} draggable={false} onPointerEnter={()=>setImageHover(true)} onPointerLeave={()=>setImageHover(false)} onPointerMove={(e)=>{const start=startDrag.current;if(!picking||!start)return;const r=e.currentTarget.getBoundingClientRect();const x=Math.max(0,Math.min(1,(e.clientX-r.x)/r.width));const y=Math.max(0,Math.min(1,(e.clientY-r.y)/r.height));setDraftRegion({x:Math.min(start.x,x),y:Math.min(start.y,y),w:Math.abs(start.x-x),h:Math.abs(start.y-y)});}} onPointerDown={(e) => { if (!picking) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); const r = e.currentTarget.getBoundingClientRect(); startDrag.current = { x: (e.clientX-r.x)/r.width, y: (e.clientY-r.y)/r.height }; }} onPointerUp={(e) => void imagePin(e)} />{[...imageRegions,...(hoverRegion?[hoverRegion]:[])].map((region,index)=><div key={index} className="annotation-image-region" style={{left:`${region.x*100}%`,top:`${region.y*100}%`,width:`${region.w*100}%`,height:`${region.h*100}%`}} />)}</div>
          : text !== undefined ? kind === 'spreadsheet' ? <AnnotationSheet text={text} pins={draft?.selections.filter((p)=>p.annotation.target.resourceId===resourceId&&p.annotation.target.version===version).map((p)=>p.annotation)??[]} picking={picking} onPin={commit} saved={saved} /> : kind === 'text' && !html ? <PlainAnnotationText text={text} /> : <MarkdownBody verbatim sourcePositions={picking||Boolean(saved)||Boolean(draft?.selections.some((p)=>p.annotation.target.resourceId===resourceId))}>{text}</MarkdownBody> : <p>{name}</p>}
      {picking && hover && !html && <div className="annotation-hover" style={{ left: (hoverBox?.x ?? 0) - (bodyBox?.x ?? 0), top: (hoverBox?.y ?? 0) - (bodyBox?.y ?? 0), width: hoverBox?.width, height: hoverBox?.height }} />}
    </div>
    {!html && draft?.pins.filter((pin) => pin.id !== editing && pin.annotation.comment.trim() && pin.annotation.target.resourceId === resourceId && pin.annotation.target.version === version).map((pin) => <AnchoredAnnotationComment key={pin.id} pin={pin} resolveAnchor={() => resolveCommentAnchor(pin.annotation)} onEdit={() => {if(editing)draft.discard(editing);const box=resolveCommentAnchor(pin.annotation);if(box)setAnchor({x:box.right,y:box.top-12});setEditing(pin.id);}} onRemove={() => draft.remove(pin.id)} />)}
    {current && <AnnotationComment pin={current} style={{ left: Math.min(anchor.x, window.innerWidth - 320), top: Math.min(anchor.y + 12, window.innerHeight - 190) }} onClose={() => {draft?.discard(current.id);setEditing(null); root.current?.focus();}} onEscape={() => setPicking(false)} />}
    {busy && <p role="status">Uploading annotation image…</p>}{error && <p role="alert">{error}</p>}
    {missing && saved && <aside className="annotation-saved-quote"><p>The original page cannot be shown again.</p><q>{annotationQuote(saved,name)}</q>{savedImage && <img alt="Saved selection" src={savedImage} />}{saved.comment && <p>{saved.comment}</p>}</aside>}
  </div>;
}

function PlainAnnotationText({text}:{text:string}):React.JSX.Element {
  let offset=0;
  return <pre className="attachment-lightbox-text">{text.split(/(\n[ \t]*\n)/u).map((part,index)=>{const start=offset;offset+=part.length;return /^\n[ \t]*\n$/u.test(part)?part:<span key={index} data-annotation-paragraph data-annotation-text data-annotation-start={start} data-annotation-end={offset}>{part}</span>;})}</pre>;
}
