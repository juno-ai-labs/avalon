import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaneVisibility } from './pane-visibility';
import { useVisibleReadAcknowledgement } from './use-visible-read-acknowledgement';

function Reader({ onRead }: { onRead: () => void }): null {
  useVisibleReadAcknowledgement(onRead);
  return null;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PaneVisibility', () => {
  it('acknowledges no read in a pane the layout is not drawing, and reads once it is drawn', () => {
    vi.useFakeTimers();
    const onRead = vi.fn();
    const { rerender } = render(<PaneVisibility visible={false}><Reader onRead={onRead} /></PaneVisibility>);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(onRead).not.toHaveBeenCalled();

    rerender(<PaneVisibility visible><Reader onRead={onRead} /></PaneVisibility>);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(onRead).toHaveBeenCalledTimes(1);
  });
});
