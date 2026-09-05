import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import type { WorkstreamResource } from './types';
import { useUiStore } from './ui-store';
import { useCitations } from './use-citations';
import type { AttachmentPreview } from '../components/attachments';

const openExternal = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./platform', () => ({ desktopBridge: () => ({ openExternal }) }));

const DECK: WorkstreamResource = {
  id: 'board-deck',
  title: 'Q3 board deck',
  mimeType: 'text/markdown',
  resourceType: 'document',
  refreshSupported: false,
  watchEnabled: false,
  watchStatus: 'unsupported',
  currentVersion: 1,
  relationshipType: 'context',
  direction: 'source',
};

beforeEach(() => {
  openExternal.mockClear();
  useUiStore.setState({ inspector: null, railOpen: false, railVariant: 'context' });
});

describe('useCitations', () => {
  it('resolves a resource the loaded work stream carries', () => {
    const { result } = renderHook(() => useCitations({ resources: [DECK] }));

    expect(result.current.resolve('board-deck')).toEqual({
      id: 'board-deck',
      title: 'Q3 board deck',
      resourceType: 'document',
      mimeType: 'text/markdown',
    });
  });

  it('resolves the alias the model actually reads, and opens the resource it names', async () => {
    // `list_resources` hands the model both the UUID and the short alias, and
    // the citation grammar accepts either spelling — so the alias is what a
    // model writes when it writes one. Resolving only the UUID would drop the
    // chip silently and leave bare label text where a citation was meant.
    const aliased = { ...DECK, slug: 'amber-crisp-lucid-lantern', contentAvailable: true };
    const onOpenPreview = vi.fn<(preview: AttachmentPreview) => void>();
    const loadResourceContent = vi.fn(async () => new Blob(['deck']));
    const { result } = renderHook(() => useCitations({ resources: [aliased], onOpenPreview, loadResourceContent }));

    expect(result.current.resolve('amber-crisp-lucid-lantern')).toEqual({
      id: 'board-deck',
      title: 'Q3 board deck',
      resourceType: 'document',
      mimeType: 'text/markdown',
    });

    act(() => { result.current.open({ scheme: 'resource', resourceId: 'amber-crisp-lucid-lantern' }); });

    const preview = onOpenPreview.mock.calls[0]![0];
    await preview.loadContent!(new AbortController().signal);
    expect(loadResourceContent).toHaveBeenCalledWith('board-deck', expect.any(AbortSignal));
    expect(useUiStore.getState().inspector).toBeNull();
  });

  it('resolves nothing for a resource outside the loaded work stream', () => {
    // The narrowing is deliberate, and it is what keeps the affordance honest:
    // the rail's detail resolves from the same set, so a chip dressed from a
    // wider lookup would open a panel saying the resource "may have been
    // removed" — of something that exists and that the reader may be entitled
    // to see. Label text says less and says nothing false.
    const { result } = renderHook(() => useCitations({ resources: [DECK] }));

    expect(result.current.resolve('elsewhere')).toBeUndefined();
  });

  it('resolves nothing at all on a surface with no loaded work stream', () => {
    const { result } = renderHook(() => useCitations({ resources: [] }));

    expect(result.current.resolve('board-deck')).toBeUndefined();
  });

  it('keeps a stable identity while the resource set holds still', () => {
    // `MarkdownBody` reads this through React context, and every citation on
    // screen is a consumer — so a new object per commit would re-render all of
    // them at the streaming reveal's rate.
    const resources = [DECK];
    const { result, rerender } = renderHook(() => useCitations({ resources }));
    const first = result.current;
    rerender();

    expect(result.current).toBe(first);
  });

  it('keeps a stable identity across an equivalent socket snapshot', () => {
    const { result, rerender } = renderHook(
      ({ resources }) => useCitations({ resources }),
      { initialProps: { resources: [DECK] } },
    );
    const first = result.current;

    // Query hydration recreates the array and its records even when no
    // citation-facing field changed. Cards must not restart their preview
    // effects merely because the transport allocated new objects.
    rerender({ resources: [{ ...DECK }] });

    expect(result.current).toBe(first);
  });

  it('opens unavailable resources in the lightbox without falling back to the rail', async () => {
    const onOpenPreview = vi.fn<(preview: AttachmentPreview) => void>();
    const { result } = renderHook(() => useCitations({ resources: [DECK], onOpenPreview }));

    act(() => { result.current.open({ scheme: 'resource', resourceId: 'board-deck' }); });

    expect(onOpenPreview).toHaveBeenCalledWith(expect.objectContaining({ name: DECK.title }));
    await expect(onOpenPreview.mock.calls[0]![0].loadContent!(new AbortController().signal)).rejects.toThrow('no preview available');
    expect(useUiStore.getState().railOpen).toBe(false);
    expect(useUiStore.getState().inspector).toBeNull();
  });

  it('sends an external source to the system browser and never to the rail', () => {
    const { result } = renderHook(() => useCitations({ resources: [DECK] }));

    act(() => { result.current.open({ scheme: 'external', url: 'https://example.com/memo' }); });

    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/memo');
    expect(useUiStore.getState().railOpen).toBe(false);
    expect(useUiStore.getState().inspector).toBeNull();
  });

  it('reads a preview once per resource, however many cards cite it', async () => {
    const loadResourceContent = vi.fn(async () => new Blob(['# Q3\n\nUp 14%.']));
    const { result } = renderHook(() => useCitations({ loadResourceContent, resources: [DECK] }));

    const first = result.current.preview!('board-deck');
    const second = result.current.preview!('board-deck');

    // Each read *causes* the conversion — the preview route materializes the
    // derivative inside the request — so a second card citing the same
    // document must join the read in flight rather than start another.
    expect(first).toBe(second);
    expect(await first).toEqual({ kind: 'text', text: '# Q3\n\nUp 14%.' });
    expect(loadResourceContent).toHaveBeenCalledExactlyOnceWith('board-deck', expect.anything());
  });

  it('reads again when the resource advances a version', async () => {
    const loadResourceContent = vi.fn(async () => new Blob(['version one']));
    const { result, rerender } = renderHook(
      ({ resources }) => useCitations({ loadResourceContent, resources }),
      { initialProps: { resources: [DECK] } },
    );
    const first = result.current.preview!('board-deck');

    // A watched source re-ingested in place keeps its id, so a cache keyed by
    // id alone would hand version 2's card version 1's text — a citation
    // substantiating a claim with the wrong revision.
    rerender({ resources: [{ ...DECK, currentVersion: 2 }] });
    const second = result.current.preview!('board-deck');

    expect(second).not.toBe(first);
    expect(loadResourceContent).toHaveBeenCalledTimes(2);
  });

  it('retries after a transient failure but remembers a verdict about the document', async () => {
    const loadResourceContent = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Blob(['the text']));
    const { result } = renderHook(() => useCitations({ loadResourceContent, resources: [DECK] }));

    await expect(result.current.preview!('board-deck')).rejects.toThrow('Failed to fetch');
    // A dropped connection says nothing about the document, so the next ask —
    // a scroll back, a re-render — asks again rather than replaying the failure
    // for as long as the reader stays in the room.
    expect(await result.current.preview!('board-deck')).toEqual({ kind: 'text', text: 'the text' });
    expect(loadResourceContent).toHaveBeenCalledTimes(2);

    const refusing = vi.fn(() => Promise.reject(new ApiError('Cannot convert', 422, 'unsupported_media_type')));
    const { result: verdict } = renderHook(() => useCitations({ loadResourceContent: refusing, resources: [DECK] }));

    await expect(verdict.current.preview!('board-deck')).rejects.toThrow('Cannot convert');
    // 422 is the route's answer about this document and will not change, so
    // re-asking would drive a conversion route to the same refusal every time.
    await expect(verdict.current.preview!('board-deck')).rejects.toThrow('Cannot convert');
    expect(refusing).toHaveBeenCalledTimes(1);
  });

  it('reads a preview by the id an alias stands for, and offers none without a route', async () => {
    const loadResourceContent = vi.fn(async () => new Blob(['text']));
    const aliased = { ...DECK, slug: 'amber-crisp-lucid-lantern' };
    const { result } = renderHook(() => useCitations({ loadResourceContent, resources: [aliased] }));

    await result.current.preview!('amber-crisp-lucid-lantern');

    // The route is keyed by the resource's own id, exactly as `open` is.
    expect(loadResourceContent).toHaveBeenCalledExactlyOnceWith('board-deck', expect.anything());
    expect(result.current.preview!('not-here')).toBeUndefined();

    // A surface with no preview route offers no preview, and the card keeps
    // its empty room rather than a skeleton nothing will ever settle.
    const { result: routeless } = renderHook(() => useCitations({ resources: [DECK] }));
    expect(routeless.current.preview!('board-deck')).toBeUndefined();
  });

  it('keeps image preview bytes as an image instead of decoding them as text', async () => {
    const blob = new Blob(['not text'], { type: 'image/png' });
    const loadResourceContent = vi.fn(async () => blob);
    const image = { ...DECK, title: 'Fjord Kaffe Oslo.png', mimeType: 'image/png' };
    const { result } = renderHook(() => useCitations({ loadResourceContent, resources: [image] }));

    expect(await result.current.preview!('board-deck')).toEqual({ kind: 'image', blob });
    expect(loadResourceContent).toHaveBeenCalledExactlyOnceWith('board-deck', expect.anything());
  });

  it('does not request audio bytes for a text or image card preview', () => {
    // Audio has its own inspector presentation. Asking the feed's preview path
    // for it would either decode binary bytes as prose or revive the retired
    // tall transport card instead of the compact file row.
    const blob = new Blob(['not text'], { type: 'audio/mpeg' });
    const loadResourceContent = vi.fn(async () => blob);
    const recording = { ...DECK, title: 'Inbox Brief.mp3', mimeType: 'audio/mpeg' };
    const { result } = renderHook(() => useCitations({ loadResourceContent, resources: [recording] }));

    expect(result.current.preview!('board-deck')).toBeUndefined();
    expect(loadResourceContent).not.toHaveBeenCalled();
  });

  it('opens nothing for a target that names an identity or nothing at all', () => {
    const { result } = renderHook(() => useCitations({ resources: [DECK] }));

    act(() => {
      result.current.open({ scheme: 'person' });
      result.current.open({ scheme: 'unknown' });
    });

    expect(openExternal).not.toHaveBeenCalled();
    expect(useUiStore.getState().railOpen).toBe(false);
    expect(useUiStore.getState().inspector).toBeNull();
  });
});
