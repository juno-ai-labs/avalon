import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkstreamResource } from './types';
import { useUiStore } from './ui-store';
import { useCitations } from './use-citations';

const openExternal = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./platform', () => ({ desktopBridge: () => ({ openExternal }) }));

const DECK: WorkstreamResource = {
  id: 'board-deck',
  title: 'Q3 board deck',
  resourceType: 'document',
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
    });
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

  it('opens the context rail first and selects the resource second', () => {
    const { result } = renderHook(() => useCitations({ resources: [DECK] }));

    act(() => { result.current.open({ scheme: 'resource', resourceId: 'board-deck' }); });

    // The order is the contract: `openRail` deliberately clears the inspector,
    // so selecting first would leave the rail on its list instead of the detail.
    expect(useUiStore.getState().railOpen).toBe(true);
    expect(useUiStore.getState().railVariant).toBe('context');
    expect(useUiStore.getState().inspector).toEqual({ type: 'resource', id: 'board-deck' });
  });

  it('sends an external source to the system browser and never to the rail', () => {
    const { result } = renderHook(() => useCitations({ resources: [DECK] }));

    act(() => { result.current.open({ scheme: 'external', url: 'https://example.com/memo' }); });

    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/memo');
    expect(useUiStore.getState().railOpen).toBe(false);
    expect(useUiStore.getState().inspector).toBeNull();
  });

  it('opens nothing for a target that names an identity or nothing at all', () => {
    const { result } = renderHook(() => useCitations({ resources: [DECK] }));

    act(() => {
      result.current.open({ scheme: 'person' });
      result.current.open({ scheme: 'connector' });
      result.current.open({ scheme: 'unknown' });
    });

    expect(openExternal).not.toHaveBeenCalled();
    expect(useUiStore.getState().railOpen).toBe(false);
    expect(useUiStore.getState().inspector).toBeNull();
  });
});
