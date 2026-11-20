import { useState } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { PanelHost, RAIL_EXIT_FADE_MS, RailSurface, useRailExitFade, visibleRect } from './rail-surface';

describe('how a panel arrives', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const frames = (count = 2): void => { for (let i = 0; i < count; i += 1) act(() => { vi.advanceTimersToNextFrame(); }); };
  const panel = (label: string, leaving = false): React.JSX.Element =>
    <RailSurface focusOnOpen={false} label={label} leaving={leaving} onClose={() => undefined} onResize={() => undefined} resizeLabel={`Resize ${label}`} width={400}>{label}</RailSurface>;
  /** What the shell reads off the frame: where the slot is, whether it is drawn, whether a change animates. */
  const drawn = (label: string): string => {
    const frame = screen.getByRole('complementary', { name: label, hidden: true });
    return ['is-leading', 'is-shown', 'is-travelling'].filter((name) => frame.classList.contains(name)).join(' ');
  };
  const Conversation = ({ side, children }: { side?: 'leading' | 'trailing'; children?: React.ReactNode }): React.JSX.Element =>
    <Tooltip.Provider><PanelHost side={side}>{children}</PanelHost></Tooltip.Provider>;

  it('has an arriving conversation’s panel in place at once, and lets it travel only after that has painted', () => {
    render(<Conversation side="leading">{panel('Artifact')}</Conversation>);
    expect(drawn('Artifact')).toBe('is-leading is-shown');
    frames(1);
    expect(drawn('Artifact')).toBe('is-leading is-shown');
    frames(1);
    expect(drawn('Artifact')).toBe('is-leading is-shown is-travelling');
  });

  it('shows a panel its own conversation opens two frames later, travelling', () => {
    const { rerender } = render(<Conversation side="leading" />);
    frames();
    // The commit that opens it mounts the panel; the slide waits for a frame of its own.
    rerender(<Conversation side="leading">{panel('Artifact')}</Conversation>);
    expect(drawn('Artifact')).toBe('is-leading');
    frames(1);
    expect(drawn('Artifact')).toBe('is-leading');
    frames(1);
    expect(drawn('Artifact')).toBe('is-leading is-shown is-travelling');
  });

  it('closes in the commit that asks, still travelling, and comes back if reopened during its fade', () => {
    const { rerender } = render(<Conversation>{panel('Artifact')}</Conversation>);
    frames();
    rerender(<Conversation>{panel('Artifact', true)}</Conversation>);
    expect(drawn('Artifact')).toBe('is-travelling');
    rerender(<Conversation>{panel('Artifact')}</Conversation>);
    expect(drawn('Artifact')).toBe('is-shown is-travelling');
  });

  it('puts a panel that takes over from one already shown straight in its place', () => {
    const { rerender } = render(<Conversation>{panel('Artifact')}</Conversation>);
    frames();
    // Another kind of panel in the same commit: a different component, so a fresh mount.
    rerender(<Conversation><section>{panel('Attachment')}</section></Conversation>);
    expect(drawn('Attachment')).toBe('is-shown');
  });

  it('takes its host’s side, passes it through a host that names none, and trails outside any', () => {
    const { unmount } = render(<Conversation side="leading">
      {panel('Sidekick')}
      <PanelHost>{panel('Preview')}</PanelHost>
    </Conversation>);
    expect(drawn('Sidekick')).toContain('is-leading');
    // Over the slot the embedded conversation sits in.
    expect(drawn('Preview')).toContain('is-leading');
    unmount();
    render(<Tooltip.Provider>{panel('Alone')}</Tooltip.Provider>);
    expect(drawn('Alone')).toBe('');
  });
});

describe('the part of a panel a native view may cover', () => {
  const box = (x: number, y: number, width: number, height: number): DOMRect => DOMRect.fromRect({ x, y, width, height });
  const window1200 = { width: 1200, height: 800 };

  it('is the whole box when nothing clips it', () => {
    expect(visibleRect(box(400, 64, 500, 600), [undefined], window1200)).toEqual({ x: 400, y: 64, width: 500, height: 600 });
  });

  it('is held to a frame still sliding open, whose content starts out behind the sidebar', () => {
    // A leading frame 200px into its slide: the content's right edge is the frame's.
    expect(visibleRect(box(100, 64, 500, 600), [box(400, 0, 200, 800)], window1200)).toEqual({ x: 400, y: 64, width: 200, height: 600 });
  });

  it('is held to every clip and to the window, and is empty rather than negative when nothing shows', () => {
    expect(visibleRect(box(900, -20, 500, 900), [box(0, 44, 1200, 700), box(800, 0, 400, 800)], window1200)).toEqual({ x: 900, y: 44, width: 300, height: 700 });
    expect(visibleRect(box(100, 64, 300, 600), [box(400, 0, 0, 800)], window1200)).toEqual({ x: 400, y: 64, width: 0, height: 600 });
  });
});

describe('useRailExitFade', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('has nothing to fade from when the sidebar opens, and fades the panel out when it closes', () => {
    const { result, rerender } = renderHook(({ open }: { open: boolean }) => useRailExitFade(open), {
      initialProps: { open: false },
    });

    rerender({ open: true });
    expect(result.current).toBe(false);

    rerender({ open: false });
    expect(result.current).toBe(true);

    act(() => vi.advanceTimersByTime(RAIL_EXIT_FADE_MS));
    expect(result.current).toBe(false);
  });

  it('cancels the exit fade when the sidebar reopens', () => {
    const { result, rerender } = renderHook(({ open }: { open: boolean }) => useRailExitFade(open), {
      initialProps: { open: true },
    });

    rerender({ open: false });
    expect(result.current).toBe(true);

    rerender({ open: true });
    expect(result.current).toBe(false);
  });

  it('gives a second close its full fade duration', () => {
    const { result, rerender } = renderHook(({ open }: { open: boolean }) => useRailExitFade(open), {
      initialProps: { open: true },
    });

    rerender({ open: false });
    act(() => vi.advanceTimersByTime(RAIL_EXIT_FADE_MS - 10));
    rerender({ open: true });
    rerender({ open: false });
    expect(result.current).toBe(true);

    act(() => vi.advanceTimersByTime(10));
    expect(result.current).toBe(true);

    act(() => vi.advanceTimersByTime(RAIL_EXIT_FADE_MS));
    expect(result.current).toBe(false);
  });

  it('does not fade a panel out of a scope it has left', () => {
    const { result, rerender } = renderHook(
      ({ open, scope }: { open: boolean; scope: string }) => useRailExitFade(open, scope),
      { initialProps: { open: true, scope: 'workstream-one' } },
    );

    rerender({ open: false, scope: 'workstream-two' });
    expect(result.current).toBe(false);
  });
});

describe('RailSurface', () => {
  function renderSurface(leaving: boolean, focusOnOpen = true): ReturnType<typeof render> {
    return render(
      <Tooltip.Provider>
        <RailSurface
          label="Preview"
          leaving={leaving}
          focusOnOpen={focusOnOpen}
          onClose={vi.fn()}
          onResize={vi.fn()}
          resizeLabel="Resize Preview"
          width={360}
        >
          <div>panel</div>
        </RailSurface>
      </Tooltip.Provider>,
    );
  }

  it('closes only the nested preview when Escape is pressed inside it', () => {
    const closeHost = vi.fn();
    const closePreview = vi.fn();
    render(<Tooltip.Provider><RailSurface label="Sidekick" onClose={closeHost} onResize={vi.fn()} resizeLabel="Resize Sidekick" width={400}>
      <RailSurface label="Attachment" onClose={closePreview} onResize={vi.fn()} resizeLabel="Resize attachment" width={400}><button>Preview content</button></RailSurface>
    </RailSurface></Tooltip.Provider>);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Preview content' }), { key: 'Escape' });
    expect(closePreview).toHaveBeenCalledOnce();
    expect(closeHost).not.toHaveBeenCalled();
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])('keeps the panel open for IME Escape (%j)', (composition) => {
    const close = vi.fn();
    render(<Tooltip.Provider><RailSurface label="Sidekick" onClose={close} onResize={vi.fn()} resizeLabel="Resize Sidekick" width={400}><textarea aria-label="Message" /></RailSurface></Tooltip.Provider>);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Escape', ...composition });
    expect(close).not.toHaveBeenCalled();
  });

  it('restores focus inside a surviving host so the next Escape closes it', () => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    function Panels(): React.JSX.Element {
      const [host, setHost] = useState(true);
      const [preview, setPreview] = useState(false);
      return <Tooltip.Provider>{host && <RailSurface label="Sidekick" onClose={() => setHost(false)} onResize={vi.fn()} resizeLabel="Resize Sidekick" width={400}>
        <button onClick={() => setPreview(true)}>Open preview</button>
        {preview && <RailSurface label="Preview" onClose={() => setPreview(false)} onResize={vi.fn()} resizeLabel="Resize preview" width={400}>Attachment</RailSurface>}
      </RailSurface>}</Tooltip.Provider>;
    }
    render(<Panels />);
    act(() => vi.advanceTimersToNextFrame());
    const opener = screen.getByRole('button', { name: 'Open preview' });
    opener.focus();
    fireEvent.click(opener);
    act(() => vi.advanceTimersToNextFrame());
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(opener).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: 'Sidekick' })).toBeNull();
  });

  it('leaves focus with a replacement preview when the previous preview unmounts', () => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    function Panels({ stage }: { stage: number }): React.JSX.Element {
      return <Tooltip.Provider><RailSurface label="Sidekick" onClose={vi.fn()} onResize={vi.fn()} resizeLabel="Resize Sidekick" width={400}>
        {stage < 2 && <RailSurface key="previous" label="Previous" leaving={stage > 0} onClose={vi.fn()} onResize={vi.fn()} resizeLabel="Resize previous" width={400}>Previous</RailSurface>}
        {stage > 0 && <RailSurface key="current" label="Current" onClose={vi.fn()} onResize={vi.fn()} resizeLabel="Resize current" width={400}>Current</RailSurface>}
      </RailSurface></Tooltip.Provider>;
    }
    const view = render(<Panels stage={0} />);
    act(() => vi.advanceTimersToNextFrame());
    view.rerender(<Panels stage={1} />);
    act(() => vi.advanceTimersToNextFrame());
    const current = screen.getByRole('complementary', { name: 'Current' });
    current.focus();
    view.rerender(<Panels stage={2} />);
    expect(current).toHaveFocus();
  });

  it.each([true, false])('moves focus on arrival only when requested (%s)', (focusOnOpen) => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const composer = document.createElement('textarea');
    document.body.append(composer);
    onTestFinished(() => composer.remove());
    composer.focus();
    const { unmount } = renderSurface(false, focusOnOpen);
    act(() => vi.advanceTimersToNextFrame());
    expect(document.activeElement).toBe(focusOnOpen ? screen.getByRole('complementary', { name: 'Preview' }) : composer);
    // An automatically revealed panel also must not reclaim focus on removal.
    const other = document.createElement('button');
    document.body.append(other);
    onTestFinished(() => other.remove());
    other.focus();
    unmount();
    expect(document.activeElement).toBe(focusOnOpen ? composer : other);
  });

  it('does not reclaim focus from a control opened before its arrival frame',()=>{
    let arrive:FrameRequestCallback=()=>{};
    const frame=vi.spyOn(window,'requestAnimationFrame').mockImplementation((callback)=>{arrive=callback;return 1;});
    onTestFinished(()=>frame.mockRestore());
    renderSurface(false);
    const menu=document.createElement('button');menu.textContent='Open menu item';document.body.append(menu);
    onTestFinished(()=>menu.remove());
    menu.focus();
    act(()=>arrive(0));
    expect(document.activeElement).toBe(menu);
  });

  it('gives the sidebar one grab handle while it holds the slot', () => {
    renderSurface(false);

    expect(screen.getByRole('complementary', { name: 'Preview' })).not.toHaveClass('is-leaving');
    expect(screen.getByRole('separator', { name: 'Resize Preview' })).toBeInTheDocument();
  });

  // The panel on its way out is on screen over the one that replaced it, so a
  // second handle, or anything still reachable, would belong to a sidebar that
  // is already gone.
  it('leaves the handle and every control to the panel that took over', () => {
    renderSurface(true);

    const surface = screen.getByRole('complementary', { name: 'Preview', hidden: true });
    expect(surface).toHaveClass('is-leaving');
    expect(surface).toHaveAttribute('inert');
    expect(screen.queryByRole('separator', { name: 'Resize Preview', hidden: true })).not.toBeInTheDocument();
  });
});

describe('dragging the rail handle', () => {
  it('applies each step without saving it, and saves the width it ends at once', () => {
    const onResize = vi.fn();
    render(<Tooltip.Provider>
      <RailSurface label="Preview" leaving={false} onClose={vi.fn()} onResize={onResize} resizeLabel="Resize Preview" width={300}>
        <div>panel</div>
      </RailSurface>
    </Tooltip.Provider>);
    const handle = screen.getByRole('separator', { name: 'Resize Preview' });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 600 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 590 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 580 });
    expect(onResize.mock.calls.every(([, options]) => options?.remember === false)).toBe(true);
    expect(onResize).toHaveBeenCalledTimes(2);
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 580 });
    expect(onResize).toHaveBeenCalledTimes(3);
    expect(onResize.mock.calls[2]).toEqual([onResize.mock.calls[1]![0]]);
  });
});
