import '../../../../../tests/isolated-region';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllDrafts, clearWorkspaceDrafts, closeDraftCache, DRAFT_CACHE_TTL_MS, draftCacheEpoch, readAnnotationDrafts, writeAnnotationDraft } from './draft-cache';
import { useAnnotationPins, type AnnotationPin } from './use-annotation-pins';
import type { Annotation } from '@rally/contracts';

const key = 'workspace:global:workspace:workstream:thread';
const annotation: Annotation = { target: { resourceId: '00000000-0000-7000-8000-000000000001', version: 1, locator: { type: 'text', start: 0, end: 5, lines: [1, 1] } }, content: { exact: 'Hello', before: '', after: '', source: 'exact', truncated: false }, comment: 'Make it warmer' };
const pin = (id = 'pin'): AnnotationPin => ({ id, annotation, name: 'Notes.txt', reveal: () => false });
const reader = { readResource: async () => ({ currentVersion: 1 }), readResourceVersion: async () => new Blob(['Hello']) };
beforeEach(async () => { await clearAllDrafts(); });
afterEach(() => { closeDraftCache(); });
describe('annotation drafts', () => {
  it('restores confirmed comments after unmount, including edits made before hydration', async () => {
    const first = renderHook(() => useAnnotationPins(key, reader));
    act(() => first.result.current.mutate(() => [pin()]));
    first.unmount();
    await waitFor(async () => expect((await readAnnotationDrafts(key))[0]?.annotation.comment).toBe('Make it warmer'));
    const restored = renderHook(() => useAnnotationPins(key, reader));
    await waitFor(() => expect(restored.result.current.pins[0]?.state).toBe('ready'));
    expect(restored.result.current.pins[0]?.annotation.content.exact).toBe('Hello');
  });
  it('does not cache unfinished selections', async () => {
    const hook = renderHook(() => useAnnotationPins(key, reader));
    act(() => hook.result.current.mutate(() => [{ ...pin(), pending: true }]));
    expect(await readAnnotationDrafts(key)).toEqual([]);
  });
  it('keeps concurrent comments from two mounted composers and propagates removal', async () => {
    const first = renderHook(() => useAnnotationPins(key, reader));
    const second = renderHook(() => useAnnotationPins(key, reader));
    act(() => { first.result.current.mutate(() => [pin('a')]); second.result.current.mutate(() => [pin('b')]); });
    await waitFor(() => expect(first.result.current.pins.map((p) => p.id).sort()).toEqual(['a', 'b']));
    await waitFor(() => expect(second.result.current.pins.map((p) => p.id).sort()).toEqual(['a', 'b']));
    act(() => first.result.current.mutate((pins) => pins.filter((p) => p.id !== 'a')));
    await waitFor(() => expect(second.result.current.pins.map((p) => p.id)).toEqual(['b']));
  });
  it('clears only the sent edit and preserves edits made during submission', async () => {
    const hook = renderHook(() => useAnnotationPins(key, reader));
    act(() => hook.result.current.mutate(() => [pin()]));
    let submitted: AnnotationPin[] = [];
    await act(async () => { submitted = await hook.result.current.check(); });
    act(() => hook.result.current.mutate((pins) => pins.map((p) => ({ ...p, annotation: { ...p.annotation, comment: 'Newer feedback' } }))));
    act(() => hook.result.current.clearAccepted(submitted));
    await waitFor(async () => expect((await readAnnotationDrafts(key))[0]?.annotation.comment).toBe('Newer feedback'));
    expect(hook.result.current.pins[0]?.annotation.comment).toBe('Newer feedback');
    await act(async () => { submitted = await hook.result.current.check(); });
    act(() => hook.result.current.clearAccepted(submitted));
    await waitFor(async () => expect(await readAnnotationDrafts(key)).toEqual([]));
  });
  it('excludes unresolved comments from the submission snapshot', async () => {
    const hook = renderHook(() => useAnnotationPins(key, { ...reader, readResource: async () => ({ currentVersion: 2 }), readResourceVersion: async () => new Blob(['Changed']) }));
    act(() => hook.result.current.mutate(() => [pin(), { ...pin('file'), annotation: { ...annotation, target: { ...annotation.target, locator: { type: 'file' } } } }]));
    let submitted: AnnotationPin[] = [];
    await act(async () => { submitted = await hook.result.current.check(); });
    expect(submitted.map((p) => p.id)).toEqual(['file']);
    expect(hook.result.current.pins.find((p) => p.id === 'pin')?.state).toBe('needs-attention');
    act(() => hook.result.current.clearAccepted(submitted));
    expect(hook.result.current.pins.map((p) => p.id)).toEqual(['pin']);
  });
  it('isolates breakout keys and does not flush old comments into a new conversation', async () => {
    const hook = renderHook(({ draftKey }) => useAnnotationPins(draftKey, reader), { initialProps: { draftKey: key } });
    act(() => hook.result.current.mutate(() => [pin()]));
    hook.rerender({ draftKey: `${key}:substream:child` });
    expect(hook.result.current.pins).toEqual([]);
    act(() => hook.result.current.mutate(() => [pin('child')]));
    await waitFor(async () => expect((await readAnnotationDrafts(key)).map((p) => p.id)).toEqual(['pin']));
    await waitFor(async () => expect((await readAnnotationDrafts(`${key}:substream:child`)).map((p) => p.id)).toEqual(['child']));
  });
  it('expires from the last user edit, not from restoration', async () => {
    await writeAnnotationDraft({ draftKey: key, id: 'old', generation: 'edit', annotation, original: annotation, name: 'Notes', updatedAt: Date.now() - DRAFT_CACHE_TTL_MS - 1 }, draftCacheEpoch());
    expect(await readAnnotationDrafts(key)).toEqual([]);
  });
  it('fences delayed writes after sign-out and clears mounted comments', async () => {
    const hook = renderHook(() => useAnnotationPins(key, reader));
    act(() => hook.result.current.mutate(() => [pin()]));
    await act(async () => { await clearAllDrafts(); });
    expect(hook.result.current.pins).toEqual([]);
    expect(await readAnnotationDrafts(key)).toEqual([]);
  });
  it('reuploads cached crop bytes and retries a failed upload without dropping the comment', async () => {
    const cropped: Annotation = {...annotation,target:{...annotation.target,locator:{type:'region',x:0,y:0,w:1,h:1}},content:{...annotation.content,imageAttachmentId:'00000000-0000-7000-8000-000000000002'}};
    await writeAnnotationDraft({draftKey:key,id:'crop',generation:'edit',annotation:cropped,original:cropped,name:'Image',updatedAt:Date.now(),image:{bytes:new Uint8Array([1,2,3]).buffer,name:'crop.png',type:'image/png'}},draftCacheEpoch());
    let fail=true;
    const uploads:File[]=[];
    const hook=renderHook(()=>useAnnotationPins(key,reader,async(file)=>{uploads.push(file);if(fail)throw new Error('offline');return '00000000-0000-7000-8000-000000000003';}));
    await waitFor(()=>expect(hook.result.current.pins[0]?.state).toBe('needs-attention'));
    fail=false;
    await act(async()=>{await hook.result.current.check();});
    expect(hook.result.current.pins[0]?.annotation.content.imageAttachmentId).toBe('00000000-0000-7000-8000-000000000003');
    expect(new Uint8Array(await uploads[1]!.arrayBuffer())).toEqual(new Uint8Array([1,2,3]));
    expect(hook.result.current.pins[0]?.state).toBe('ready');
  });
  it('does not apply resolution from a conversation that has been left', async () => {
    let finish!: (value:{currentVersion:number})=>void;
    const delayed={...reader,readResource:()=>new Promise<{currentVersion:number}>((resolve)=>{finish=resolve;})};
    const hook=renderHook(({draftKey})=>useAnnotationPins(draftKey,delayed),{initialProps:{draftKey:key}});
    act(()=>hook.result.current.mutate(()=>[pin()]));
    let checking!:Promise<AnnotationPin[]>;
    act(()=>{checking=hook.result.current.check();});
    hook.rerender({draftKey:key+':substream:other'});
    await act(async()=>{finish({currentVersion:1});expect(await checking).toEqual([]);});
    expect(hook.result.current.pins).toEqual([]);
  });
  it('keeps the in-memory comment usable when IndexedDB cannot save it', async () => {
    const write=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(()=>{throw new Error('quota');});
    const hook=renderHook(()=>useAnnotationPins(key,reader));
    act(()=>hook.result.current.mutate(()=>[pin()]));
    await act(async()=>{await hook.result.current.check();});
    expect(hook.result.current.pins[0]?.annotation.comment).toBe('Make it warmer');
    expect(await readAnnotationDrafts(key)).toEqual([]);
    write.mockRestore();
  });
  it('workspace departure preserves other regional workspaces', async () => {
    const row = { id: 'pin', generation: 'edit', annotation, original: annotation, name: 'Notes', updatedAt: Date.now() };
    await writeAnnotationDraft({ ...row, draftKey: key }, draftCacheEpoch());
    await writeAnnotationDraft({ ...row, draftKey: key.replace(':workspace:', ':other:') }, draftCacheEpoch());
    await clearWorkspaceDrafts('global', 'workspace');
    expect(await readAnnotationDrafts(key)).toEqual([]);
    expect((await readAnnotationDrafts(key.replace(':workspace:', ':other:'))).length).toBe(1);
  });
});
