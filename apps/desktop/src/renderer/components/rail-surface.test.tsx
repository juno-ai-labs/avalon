import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RAIL_CROSSFADE_MS, RailSurface, useRailCrossFade } from './rail-surface';

describe('useRailCrossFade', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds the panel that lost the sidebar until its fade is over', () => {
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useRailCrossFade(id), {
      initialProps: { id: 'preview' as string | null },
    });
    expect(result.current).toBeNull();

    rerender({ id: 'inspector' });
    expect(result.current).toBe('preview');

    act(() => vi.advanceTimersByTime(RAIL_CROSSFADE_MS));
    expect(result.current).toBeNull();
  });

  it('has nothing to fade from when the sidebar opens, and fades the panel out when it closes', () => {
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useRailCrossFade(id), {
      initialProps: { id: null as string | null },
    });

    rerender({ id: 'inspector' });
    expect(result.current).toBeNull();

    rerender({ id: null });
    expect(result.current).toBe('inspector');

    act(() => vi.advanceTimersByTime(RAIL_CROSSFADE_MS));
    expect(result.current).toBeNull();
  });

  // Preview takes the slot a microtask after the inspector lets go of it, so
  // the hook sees an empty slot in between. The outgoing panel has to survive it
  // or that direction never cross-fades.
  it('carries the outgoing panel through a slot that is briefly empty mid-hand-off', () => {
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useRailCrossFade(id), {
      initialProps: { id: 'inspector' as string | null },
    });

    rerender({ id: null });
    rerender({ id: 'preview' });
    expect(result.current).toBe('inspector');

    act(() => vi.advanceTimersByTime(RAIL_CROSSFADE_MS));
    expect(result.current).toBeNull();
  });

  it('shows a panel that takes the slot straight back as itself, not as its own ghost', () => {
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useRailCrossFade(id), {
      initialProps: { id: 'inspector' as string | null },
    });

    rerender({ id: null });
    expect(result.current).toBe('inspector');

    rerender({ id: 'inspector' });
    expect(result.current).toBeNull();
  });

  // The panel is on screen for a fade it started twice over; the first fade's
  // timer must not be the one that ends the second.
  it('gives a panel that leaves twice a full fade the second time', () => {
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useRailCrossFade(id), {
      initialProps: { id: 'inspector' as string | null },
    });

    rerender({ id: null });
    act(() => vi.advanceTimersByTime(RAIL_CROSSFADE_MS - 10));
    rerender({ id: 'inspector' });
    rerender({ id: 'preview' });
    expect(result.current).toBe('inspector');

    // The first departure's timer would have fired here.
    act(() => vi.advanceTimersByTime(10));
    expect(result.current).toBe('inspector');

    act(() => vi.advanceTimersByTime(RAIL_CROSSFADE_MS));
    expect(result.current).toBeNull();
  });

  // A work-stream switch is not a hand-off. Nothing takes the slot in the stream
  // arrived at, so a panel carried into it would dissolve over another stream's
  // feed while that feed is laid out around it.
  it('does not fade a panel out of a scope it has left', () => {
    const { result, rerender } = renderHook(
      ({ id, scope }: { id: string | null; scope: string }) => useRailCrossFade(id, scope),
      { initialProps: { id: 'inspector' as string | null, scope: 'workstream-one' } },
    );

    rerender({ id: null, scope: 'workstream-two' });
    expect(result.current).toBeNull();
  });

  // The close and the scope do not always reach the hook in one render: the
  // screen's own state settles first, and the store it reads catches up in a
  // layout effect. A fade started in between still belongs to the scope it
  // started in.
  it('drops a fade already running when the scope changes under it', () => {
    const { result, rerender } = renderHook(
      ({ id, scope }: { id: string | null; scope: string }) => useRailCrossFade(id, scope),
      { initialProps: { id: 'inspector' as string | null, scope: 'workstream-one' } },
    );

    rerender({ id: null, scope: 'workstream-one' });
    expect(result.current).toBe('inspector');

    rerender({ id: null, scope: 'workstream-two' });
    expect(result.current).toBeNull();

    act(() => vi.advanceTimersByTime(RAIL_CROSSFADE_MS));
    expect(result.current).toBeNull();
  });

  // Only a change of scope forgets. Within one work stream the hand-off is
  // exactly what it was.
  it('still cross-fades a hand-off inside one scope', () => {
    const { result, rerender } = renderHook(
      ({ id, scope }: { id: string | null; scope: string }) => useRailCrossFade(id, scope),
      { initialProps: { id: 'inspector' as string | null, scope: 'workstream-one' } },
    );

    rerender({ id: 'preview', scope: 'workstream-one' });
    expect(result.current).toBe('inspector');

    act(() => vi.advanceTimersByTime(RAIL_CROSSFADE_MS));
    expect(result.current).toBeNull();
  });

  // Switching back mid-fade turns the hand-off around rather than stacking a
  // second one on it: the panel that was on its way out is the one on screen.
  it('turns the fade around when the sidebar changes hands again mid-fade', () => {
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useRailCrossFade(id), {
      initialProps: { id: 'inspector' as string | null },
    });

    rerender({ id: 'preview' });
    expect(result.current).toBe('inspector');

    rerender({ id: 'inspector' });
    expect(result.current).toBe('preview');

    act(() => vi.advanceTimersByTime(RAIL_CROSSFADE_MS));
    expect(result.current).toBeNull();
  });
});

describe('RailSurface', () => {
  function renderSurface(leaving: boolean): void {
    render(
      <RailSurface
        label="Preview"
        leaving={leaving}
        onClose={vi.fn()}
        onResize={vi.fn()}
        resizeLabel="Resize Preview"
        scrimLabel="Dismiss Preview"
        width={360}
      >
        <div>panel</div>
      </RailSurface>,
    );
  }

  it('gives the sidebar one scrim and one grab handle while it holds the slot', () => {
    renderSurface(false);

    expect(screen.getByRole('complementary', { name: 'Preview' })).not.toHaveClass('is-leaving');
    expect(screen.getByRole('button', { name: 'Dismiss Preview' })).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: 'Resize Preview' })).toBeInTheDocument();
  });

  // The panel on its way out is on screen over the one that replaced it, so a
  // second scrim, a second handle, or anything still reachable would belong to
  // a sidebar that is already gone.
  it('leaves the scrim, the handle, and every control to the panel that took over', () => {
    renderSurface(true);

    const surface = screen.getByRole('complementary', { name: 'Preview', hidden: true });
    expect(surface).toHaveClass('is-leaving');
    expect(surface).toHaveAttribute('inert');
    expect(screen.queryByRole('button', { name: 'Dismiss Preview', hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('separator', { name: 'Resize Preview', hidden: true })).not.toBeInTheDocument();
  });
});
