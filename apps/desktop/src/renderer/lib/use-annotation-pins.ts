import { useCallback, useEffect, useRef, useState } from 'react';
import { AnnotationsSchema, type Annotation } from '@rally/contracts';
import { describeZodIssues } from '@rally/contracts/zod-diagnostics';
import { MAX_ATTACHMENTS } from './attachment-limits';
import { deleteAnnotationDraft, draftCacheEpoch, nextDraftSortKey, subscribeDraftClears, readAnnotationDrafts, writeAnnotationDraft, type CachedAnnotationDraft } from './draft-cache';
import { resolveAnnotation, type AnnotationReader } from './annotation-resolution';

export interface AnnotationPin {
  id: string;
  annotation: Annotation;
  name: string;
  reveal: () => boolean | void;
  pending?: boolean;
  original?: Annotation;
  generation?: string;
  updatedAt?: number;
  sortKey?: number;
  image?: CachedAnnotationDraft['image'];
  state?: 'checking' | 'ready' | 'needs-attention';
  reason?: string | undefined;
  repairOf?: string;
  imageUploaded?: boolean;
}
/** Validate the resolved snapshot, including comments that were still checking at click time. */
export function validateAnnotationSend(pins: AnnotationPin[], attachmentCount: number): void {
  const parsed = AnnotationsSchema.safeParse(pins.map((pin)=>pin.annotation));
  if (!parsed.success) throw new Error(`Artifact comments could not be sent: ${describeZodIssues(parsed.error)}`);
  const images = pins.filter((pin)=>pin.annotation.content.imageAttachmentId).length;
  if (images + attachmentCount > MAX_ATTACHMENTS) throw new Error('Send no more than 10 images and attachments together.');
}
const listeners = new Set<(key: string) => void>();
function notify(key: string): void { for (const listener of listeners) listener(key); }

/** Per-comment writes avoid list replacement and hydration overwriting a local edit. */
export function useAnnotationPins(draftKey: string | undefined, reader: { readResource?: AnnotationReader['readResource'] | undefined; readResourceVersion?: AnnotationReader['readResourceVersion'] | undefined }, upload?: (file: File) => Promise<string>, resourceId?: string) {
  const [pins, render] = useState<AnnotationPin[]>([]);
  const held = useRef({ key: draftKey, epoch: draftCacheEpoch(), pins, dirty: new Map<string, number>(), disabled: false, memoryOnly: new Set<string>(), queue: Promise.resolve() });
  if (held.current.key !== draftKey) {
    held.current = { key: draftKey, epoch: draftCacheEpoch(), pins: [], dirty: new Map<string, number>(), disabled: false, memoryOnly: new Set<string>(), queue: Promise.resolve() };
    render([]);
  }
  const options = useRef({ reader, upload }); options.current = { reader, upload };
  const channel = useRef<BroadcastChannel | null>(null);
  const scope = held.current;
  const publish = useCallback((next: AnnotationPin[]): void => {
    const ordered = [...next].sort((a,b)=>(a.sortKey??a.updatedAt??0)-(b.sortKey??b.updatedAt??0));
    scope.pins = ordered;
    if (held.current === scope) render(ordered);
  }, [scope]);
  const enqueue = useCallback((id: string, task: () => Promise<boolean>): void => {
    if (scope.disabled) return;
    scope.dirty.set(id, (scope.dirty.get(id)??0)+1);
    scope.queue = scope.queue.then(task).then((saved) => {
      if(saved)scope.memoryOnly.delete(id);else scope.memoryOnly.add(id);
      const remaining=(scope.dirty.get(id)??1)-1;
      if(remaining)scope.dirty.set(id,remaining);else scope.dirty.delete(id);
      if (saved && scope.key) { notify(scope.key); channel.current?.postMessage(scope.key); }
    });
  }, [scope]);
  const cache = useCallback((pin: AnnotationPin, expected?: string): void => {
    if (!scope.key || pin.pending) return;
    const row: CachedAnnotationDraft = { draftKey: scope.key, id: pin.id, generation: pin.generation!, name: pin.name,
      sortKey: pin.sortKey ?? pin.updatedAt!, annotation: pin.annotation, original: pin.original ?? pin.annotation, updatedAt: pin.updatedAt!, ...(pin.image ? { image: pin.image } : {}) };
    enqueue(pin.id, () => writeAnnotationDraft(row, scope.epoch, expected));
  }, [scope, enqueue]);
  const mutate = useCallback((update: (pins: AnnotationPin[]) => AnnotationPin[]): void => {
    if (scope.disabled) return;
    const previous = scope.pins;
    const next = update(previous).map((pin) => {
      const old = previous.find((entry) => entry.id === pin.id);
      if (old === pin) return pin;
      const changed: AnnotationPin = { ...pin, original: pin.original ?? old?.original ?? pin.annotation,
        sortKey: old?.sortKey ?? pin.sortKey ?? nextDraftSortKey(), generation: crypto.randomUUID(), updatedAt: Date.now(), state: pin.state ?? 'ready' };
      cache(changed);
      return changed;
    });
    for (const pin of previous) if (!next.some((entry) => entry.id === pin.id) && scope.key && !pin.pending) {
      enqueue(pin.id, () => deleteAnnotationDraft(scope.key!, pin.id, scope.epoch));
    }
    publish(next);
  }, [scope, cache, enqueue, publish]);
  const clearAccepted = useCallback((submitted: AnnotationPin[]): void => {
    const matches = (pin: AnnotationPin): boolean => submitted.some((sent) => sent.id === pin.id && sent.generation === pin.generation);
    publish(scope.pins.filter((pin) => !pin.pending && !matches(pin)));
    for (const pin of submitted) if (scope.key) enqueue(pin.id, () => deleteAnnotationDraft(scope.key!, pin.id, scope.epoch, pin.generation));
  }, [scope, enqueue, publish]);

  useEffect(() => {
    if (!draftKey) return;
    let active = true;
    let readSequence = 0;
    const reload = (): void => {
      const sequence = ++readSequence;
      void readAnnotationDrafts(draftKey).then((rows) => {
        if (!active || sequence !== readSequence || scope.epoch !== draftCacheEpoch()) return;
        const restored = rows.filter((row) => (!resourceId || row.annotation.target.resourceId === resourceId) && !scope.dirty.has(row.id) && !scope.memoryOnly.has(row.id)).map((row): AnnotationPin => {
          const current = scope.pins.find((pin) => pin.id === row.id);
          if (current?.generation === row.generation) return current;
          // An authored-text edit does not change the target or its resolved state.
          if (current && JSON.stringify({ ...current.annotation, comment: '' }) === JSON.stringify({ ...row.annotation, comment: '' })) {
            return { ...current, ...row };
          }
          return { ...row, reveal: () => false, state: 'checking' };
        });
        publish([...restored, ...scope.pins.filter((pin) => pin.pending || scope.dirty.has(pin.id) || scope.memoryOnly.has(pin.id))]);
      });
    };
    const listener = (key: string): void => { if (key === draftKey) reload(); };
    listeners.add(listener);
    if (typeof BroadcastChannel !== 'undefined') {
      const broadcast = new BroadcastChannel('rally-annotation-drafts'); channel.current = broadcast;
      broadcast.onmessage = (event: MessageEvent<unknown>) => { if (event.data === draftKey) reload(); };
    }
    reload();
    return () => { active = false; listeners.delete(listener); channel.current?.close(); channel.current = null; };
  }, [draftKey, scope, publish, resourceId]);

  useEffect(()=>subscribeDraftClears((prefix)=>{
    if (!prefix || scope.key?.startsWith(prefix)) {scope.disabled=true;publish([]);}
    else scope.epoch=draftCacheEpoch();
  }),[scope,publish]);
  const sequence = useRef(0);
  const latestCheck = useRef<Promise<AnnotationPin[]>>(Promise.resolve([]));
  const activeCheck = useRef<{ scope: typeof scope; signature: string; promise: Promise<AnnotationPin[]> } | null>(null);
  const check = useCallback((force = false): Promise<AnnotationPin[]> => {
    const signature = scope.pins.filter((pin)=>!pin.pending).map((pin)=>`${pin.id}:${pin.generation}`).join(',');
    if (!force && activeCheck.current?.scope === scope && activeCheck.current.signature === signature) return activeCheck.current.promise;
    const resolve = async (): Promise<AnnotationPin[]> => {
      const run = ++sequence.current;
      if (scope.disabled) return [];
      const captured = scope.pins.filter((pin) => !pin.pending);
      const { reader: readers, upload: uploadFile } = options.current;
      if (!readers.readResource || !readers.readResourceVersion) return captured.filter((pin)=>pin.state==='ready');
      const controller = new AbortController();
      // Share metadata and preview reads across comments on the same resource/page.
      const resources = new Map<string, ReturnType<AnnotationReader['readResource']>>();
      const previews = new Map<string, Promise<Blob>>();
      const sharedReader: AnnotationReader = {
        readResource: (id, refresh = false) => {
          const key = `${id}:${refresh}`;
          if (!resources.has(key)) resources.set(key, readers.readResource!(id, refresh));
          return resources.get(key)!;
        },
        readResourceVersion: (id, version, signal, annotation, mimeType) => {
          const locator = annotation?.target.locator;
          const key = JSON.stringify([id, version, locator?.type === 'element' ? locator.pagePath : null]);
          if (!previews.has(key)) previews.set(key, readers.readResourceVersion!(id, version, signal, annotation, mimeType));
          return previews.get(key)!;
        },
      };
      const results = await Promise.all(captured.map(async (pin): Promise<AnnotationPin> => {
        const resolved = await resolveAnnotation(pin.annotation, sharedReader, controller.signal);
        if (resolved.state !== 'ready') return { ...pin, state: resolved.state, reason: resolved.reason };
        let annotation = resolved.annotation;
        if (annotation.content.imageAttachmentId && !pin.imageUploaded && (!pin.image || !uploadFile)) return {...pin,state:'needs-attention',reason:'The saved comment image is unavailable. Reattach this comment to send it.'};
        // Each restored crop has its bytes, so the normal upload route can recover a missing server draft.
        if (!pin.imageUploaded && annotation.content.imageAttachmentId && pin.image && uploadFile) {
          try {
            const id = await uploadFile(new File([pin.image.bytes], pin.image.name, { type: pin.image.type }));
            annotation = { ...annotation, content: { ...annotation.content, imageAttachmentId: id } };
          } catch { return { ...pin, state: 'needs-attention', reason: 'The comment image could not be uploaded. Retry to send it.' }; }
        }
        const result: AnnotationPin = { ...pin, annotation, imageUploaded: true, state: 'ready', reason: undefined };
        if (!annotation.content.imageAttachmentId) delete result.image;
        return result;
      }));
      if (held.current !== scope || scope.disabled || scope.epoch !== draftCacheEpoch()) return [];
      // A newer revision check owns the result; submission follows it instead of
      // interpreting cancellation as a successful empty annotation snapshot.
      if (run !== sequence.current) return latestCheck.current;
      const eligible: AnnotationPin[] = [];
      publish(scope.pins.map((pin) => {
        const result = results.find((entry) => entry.id === pin.id && entry.generation === pin.generation);
        if (!result) return pin;
        if (result.state === 'ready') eligible.push(result);
        if (JSON.stringify(result.annotation) !== JSON.stringify(pin.annotation)) cache(result, pin.generation);
        return result;
      }));
      return eligible;
    };
    const result = resolve();
    latestCheck.current = result;
    const active = { scope, signature, promise: result };
    activeCheck.current = active;
    void result.finally(()=>{ if(activeCheck.current===active)activeCheck.current=null; });
    return result;
  }, [scope, publish, cache]);
  const checking = pins.filter((pin) => !pin.pending && pin.state === 'checking').map((pin)=>pin.generation).join(':');
  useEffect(() => { if (checking && reader.readResource && reader.readResourceVersion) void check(); }, [checking, check, Boolean(reader.readResource), Boolean(reader.readResourceVersion)]);
  useEffect(() => {
    const refresh = (): void => { void check(); };
    window.addEventListener('focus', refresh);
    return () => { window.removeEventListener('focus', refresh); };
  }, [check]);
  const prepareSend = useCallback(async (): Promise<AnnotationPin[]> => {
    const result = await check();
    if (held.current !== scope || scope.disabled || scope.epoch !== draftCacheEpoch()) throw new Error('The conversation changed before the comments could be sent.');
    return result;
  }, [check, scope]);
  return { pins, mutate, check, prepareSend, clearAccepted };
}
