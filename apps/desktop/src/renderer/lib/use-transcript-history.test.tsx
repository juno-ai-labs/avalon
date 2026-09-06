import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTranscriptHistory } from './use-transcript-history';

let frames: Map<number, FrameRequestCallback>;
let nextFrame = 0;
let resize: () => void;
let geometry: { clientHeight: number; scrollHeight: number; scrollTop: number };

function Feed({ address = 'a', enabled = true, load = async () => {} }: {
  address?: string;
  enabled?: boolean;
  load?: () => Promise<void>;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useTranscriptHistory({
    scrollRef: ref, conversationAddress: address, enabled, loadOlder: load,
  });
  return <div ref={(element) => {
    ref.current = element;
    if (element) {
      for (const property of ['clientHeight', 'scrollHeight', 'scrollTop'] as const) {
        Object.defineProperty(element, property, { configurable: true, get: () => geometry[property] });
      }
    }
  }} data-testid="feed"><div /></div>;
}

async function frame(): Promise<void> {
  await act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  });
}

beforeEach(() => {
  frames = new Map();
  geometry = { clientHeight: 600, scrollHeight: 600, scrollTop: 0 };
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe(): void {}
    disconnect(): void {}
  });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('opening transcript history', () => {
  it('fills after layout without a scroll, continuing until measured content overflows', async () => {
    const load = vi.fn(async () => {});
    const view = render(<Feed load={load} />);
    expect(load).not.toHaveBeenCalled();
    await frame();
    expect(load).toHaveBeenCalledTimes(1);
    view.rerender(<Feed load={load} />);
    await frame();
    expect(load).toHaveBeenCalledTimes(2);
    geometry.scrollHeight = 800;
    geometry.scrollTop = 200;
    view.rerender(<Feed load={load} />);
    await frame();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('loads from scroll position without requiring wheel or pointer intent', async () => {
    geometry.scrollHeight = 2000;
    geometry.scrollTop = 1400;
    const load = vi.fn(async () => {});
    render(<Feed load={load} />);
    await frame();
    expect(load).not.toHaveBeenCalled();
    geometry.scrollTop = 159;
    fireEvent.scroll(screen.getByTestId('feed'));
    await frame();
    expect(load).toHaveBeenCalledOnce();
    geometry.scrollTop = 160;
    fireEvent.scroll(screen.getByTestId('feed'));
    await frame();
    expect(load).toHaveBeenCalledOnce();
  });

  it('rechecks a resized viewport and starts fresh on a conversation change', async () => {
    geometry.scrollTop = 200;
    const load = vi.fn(async () => {});
    const view = render(<Feed load={load} />);
    await frame();
    expect(load).not.toHaveBeenCalled();
    geometry.scrollTop = 0;
    resize();
    await frame();
    expect(load).toHaveBeenCalledOnce();
    view.rerender(<Feed address="b" load={load} />);
    await frame();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not duplicate an in-flight page, including resize notifications', async () => {
    let finish = (): void => {};
    const load = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const view = render(<Feed load={load} />);
    await frame();
    view.rerender(<Feed load={load} />);
    resize();
    await frame();
    expect(load).toHaveBeenCalledOnce();
    await act(async () => { finish(); });
  });

  it('lets a new conversation fill while a departed conversation has a pending page', async () => {
    let finish = (): void => {};
    const oldLoad = () => new Promise<void>((resolve) => { finish = resolve; });
    const newLoad = vi.fn(async () => {});
    const view = render(<Feed load={oldLoad} />);
    await frame();
    view.rerender(<Feed address="b" load={newLoad} />);
    await frame();
    expect(newLoad).toHaveBeenCalledOnce();
    await act(async () => { finish(); });
  });

  it('does not fill without permission, or after permission is withdrawn before layout', async () => {
    const load = vi.fn(async () => {});
    const view = render(<Feed enabled={false} load={load} />);
    await frame();
    view.rerender(<Feed load={load} />);
    view.rerender(<Feed enabled={false} load={load} />);
    await frame();
    expect(load).not.toHaveBeenCalled();
  });

  it('waits for a visible, laid-out viewport and resumes when the window is shown', async () => {
    const load = vi.fn(async () => {});
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    render(<Feed load={load} />);
    await frame();
    expect(load).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    geometry.clientHeight = 0;
    fireEvent(document, new Event('visibilitychange'));
    await frame();
    expect(load).not.toHaveBeenCalled();
    geometry.clientHeight = 600;
    resize();
    await frame();
    expect(load).toHaveBeenCalledOnce();
  });
});
