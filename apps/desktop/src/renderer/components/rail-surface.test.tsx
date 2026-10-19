import * as Tooltip from '@radix-ui/react-tooltip';
import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { RAIL_EXIT_FADE_MS, RailSurface, useRailExitFade } from './rail-surface';

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
  function renderSurface(leaving: boolean): void {
    render(
      <Tooltip.Provider>
        <RailSurface
          label="Preview"
          leaving={leaving}
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
