import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RELATIVE_TIME_REFRESH_MS, useNow } from './clock';

describe('useNow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shares one interval across every subscriber and stops it with the last', () => {
    const first = renderHook(() => useNow());
    const second = renderHook(() => useNow());

    expect(vi.getTimerCount()).toBe(1);
    expect(first.result.current).toBe(Date.parse('2026-09-10T12:00:00.000Z'));

    act(() => {
      vi.advanceTimersByTime(RELATIVE_TIME_REFRESH_MS);
    });

    expect(first.result.current).toBe(Date.parse('2026-09-10T12:00:10.000Z'));
    expect(second.result.current).toBe(Date.parse('2026-09-10T12:00:10.000Z'));

    first.unmount();
    expect(vi.getTimerCount()).toBe(1);
    second.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('re-reads the clock as soon as the window is visible again', () => {
    const hook = renderHook(() => useNow());
    // The system clock moves without any timer firing, which is what Chromium's
    // throttling of a hidden window looks like from inside the page.
    vi.setSystemTime(new Date('2026-09-10T12:05:00.000Z'));
    expect(hook.result.current).toBe(Date.parse('2026-09-10T12:00:00.000Z'));

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(hook.result.current).toBe(Date.parse('2026-09-10T12:05:00.000Z'));
  });

  it('paints a late subscriber\'s first frame against the live clock', () => {
    // Every value this component was rendered with, not just the one it settled
    // on. Subscribing re-reads the clock, so a stale first frame is corrected a
    // moment later and an assertion on the final value passes either way — the
    // defect is the frame a person sees before that, showing a label the store
    // stopped updating when the last subscriber left.
    const painted: number[] = [];
    function Probe(): null {
      painted.push(useNow());
      return null;
    }

    renderHook(() => useNow()).unmount();
    vi.setSystemTime(new Date('2026-09-10T13:00:00.000Z'));
    render(<Probe />);

    expect(painted[0]).toBe(Date.parse('2026-09-10T13:00:00.000Z'));
  });
});
