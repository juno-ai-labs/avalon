import { describe, expect, it, vi } from 'vitest';
import { writeMobilePins } from '../src/mobile-pins';

describe('mobile pin placement', () => {
  it('waits for membership before ordering a newly pinned canvas', async () => {
    let acceptPin: (() => void) | undefined;
    const api = {
      setCanvasPinned: vi.fn(() => new Promise<void>((resolve) => { acceptPin = resolve; })),
      reorderCanvasPins: vi.fn(async () => {}),
    };
    const write = writeMobilePins(api, ['a', 'b', 'c'], { type: 'pin', id: 'new', pinned: true, beforeId: 'b' });
    expect(api.setCanvasPinned).toHaveBeenCalledWith('new', true);
    expect(api.reorderCanvasPins).not.toHaveBeenCalled();
    acceptPin?.();
    await write;
    expect(api.reorderCanvasPins).toHaveBeenCalledWith(['a', 'new', 'b', 'c']);
  });
  it('does not reorder after a refused pin', async () => {
    const api = { setCanvasPinned: vi.fn(async () => { throw Error('pin refused'); }), reorderCanvasPins: vi.fn(async () => {}) };
    await expect(writeMobilePins(api, ['a'], { type: 'pin', id: 'new', pinned: true, beforeId: 'a' })).rejects.toThrow('pin refused');
    expect(api.reorderCanvasPins).not.toHaveBeenCalled();
  });
  it('propagates placement failure so the UI reports the partial write', async () => {
    const api = { setCanvasPinned: vi.fn(async () => {}), reorderCanvasPins: vi.fn(async () => { throw Error('order refused'); }) };
    await expect(writeMobilePins(api, ['a'], { type: 'pin', id: 'new', pinned: true, beforeId: 'a' })).rejects.toThrow('order refused');
  });
  it('uses only membership for unpin and append, and only order for reordering', async () => {
    const api = { setCanvasPinned: vi.fn(async () => {}), reorderCanvasPins: vi.fn(async () => {}) };
    await writeMobilePins(api, ['a'], { type: 'pin', id: 'a', pinned: false });
    await writeMobilePins(api, ['a'], { type: 'pin', id: 'new', pinned: true });
    expect(api.reorderCanvasPins).not.toHaveBeenCalled();
    await writeMobilePins(api, ['a', 'b'], { type: 'reorder', ids: ['b', 'a'] });
    expect(api.setCanvasPinned.mock.calls).toEqual([['a', false], ['new', true]]);
    expect(api.reorderCanvasPins).toHaveBeenCalledWith(['b', 'a']);
  });
});
