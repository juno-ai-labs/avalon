import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTranscriptHistory } from './use-transcript-history';

let frames: Map<number, FrameRequestCallback>;
let nextFrame = 0;
let resize: () => void;
let observed: Element[];
let observers = 0;
let disconnects = 0;
let geometry: { clientHeight: number; scrollHeight: number; scrollTop: number };

function Feed({ address = 'a', enabled = true, canLoad = true, load = () => {} }: {
  address?: string;
  enabled?: boolean;
  canLoad?: boolean;
  load?: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useTranscriptHistory({
    scrollRef: ref, contentRef, conversationAddress: address, enabled, canLoad, loadOlder: load,
  });
  return <div ref={(element) => {
    ref.current = element;
    if (element) {
      for (const property of ['clientHeight', 'scrollHeight', 'scrollTop'] as const) {
        Object.defineProperty(element, property, { configurable: true, get: () => geometry[property] });
      }
    }
  }} data-testid="feed"><div ref={contentRef} data-testid="content" /></div>;
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
  observed = [];
  observers = 0;
  disconnects = 0;
  geometry = { clientHeight: 600, scrollHeight: 600, scrollTop: 0 };
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; observers += 1; }
    observe(element: Element): void { observed.push(element); }
    disconnect(): void { disconnects += 1; }
  });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('opening transcript history', () => {
  it('loads after layout and stops when the viewport leaves the history edge', async () => {
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

  it('keeps observers and pending checks across streaming commits while using current permission', async () => {
    const load = vi.fn();
    const view = render(<Feed load={load} />);
    expect(observed).toEqual([screen.getByTestId('feed'), screen.getByTestId('content')]);
    view.rerender(<Feed load={load} />);
    view.rerender(<Feed load={load} />);
    expect(observers).toBe(1);
    expect(disconnects).toBe(0);
    expect(frames.size).toBe(1);
    await frame();
    expect(load).toHaveBeenCalledOnce();
    view.rerender(<Feed canLoad={false} load={load} />);
    resize();
    await frame();
    expect(load).toHaveBeenCalledOnce();
    expect(observers).toBe(1);
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
