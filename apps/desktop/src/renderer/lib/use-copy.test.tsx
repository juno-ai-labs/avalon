import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COPY_FEEDBACK_MS, useCopy } from './use-copy';

const bridgeCopyText = vi.hoisted(() => vi.fn<(text: string) => Promise<void>>(async () => undefined));
vi.mock('./platform', () => ({ desktopBridge: () => ({ copyText: bridgeCopyText }) }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  bridgeCopyText.mockReset().mockResolvedValue(undefined);
});

describe('useCopy', () => {
  it('writes through the desktop bridge and reports the outcome only after the write lands', async () => {
    vi.useFakeTimers();
    const onCopied = vi.fn();
    const { result } = renderHook(() => useCopy({ value: 'whsec_one', onCopied }));
    expect(result.current.state).toBe('idle');

    await act(async () => { await result.current.copy(); });
    expect(bridgeCopyText).toHaveBeenCalledWith('whsec_one');
    expect(onCopied).toHaveBeenCalledOnce();
    expect(result.current.state).toBe('copied');

    // The outcome is shown for a bounded time and then the control is ready
    // for the same click again, without the caller clearing anything.
    act(() => { vi.advanceTimersByTime(COPY_FEEDBACK_MS - 1); });
    expect(result.current.state).toBe('copied');
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.state).toBe('idle');
  });

  it('settles into failed rather than rejecting when the clipboard refuses, and reports nothing', async () => {
    bridgeCopyText.mockRejectedValueOnce(new Error('clipboard unavailable'));
    const onCopied = vi.fn();
    const { result } = renderHook(() => useCopy({ value: 'anything', onCopied }));

    await act(async () => { await expect(result.current.copy()).resolves.toBeUndefined(); });
    expect(result.current.state).toBe('failed');
    expect(onCopied).not.toHaveBeenCalled();

    // The same click is the retry.
    await act(async () => { await result.current.copy(); });
    expect(result.current.state).toBe('copied');
  });

  it('resolves a value that is built on demand, and writes it through the clipboard it was given', async () => {
    const copyText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    const { result } = renderHook(() => useCopy({ copyText, value: async () => '"name"\r\n"Ada"' }));

    await act(async () => { await result.current.copy(); });
    expect(copyText).toHaveBeenCalledWith('"name"\r\n"Ada"');
    expect(bridgeCopyText).not.toHaveBeenCalled();
    expect(result.current.state).toBe('copied');
  });

  it('fails when the value cannot be built, before touching the clipboard', async () => {
    const { result } = renderHook(() => useCopy({ value: () => Promise.reject(new Error('table gone')) }));
    await act(async () => { await result.current.copy(); });
    expect(result.current.state).toBe('failed');
    expect(bridgeCopyText).not.toHaveBeenCalled();
  });

  it('reads the latest value at click time through one stable copy function', async () => {
    const { rerender, result } = renderHook(({ value }) => useCopy({ value }), { initialProps: { value: 'first' } });
    const { copy } = result.current;
    rerender({ value: 'second' });
    expect(result.current.copy).toBe(copy);
    await act(async () => { await copy(); });
    expect(bridgeCopyText).toHaveBeenCalledWith('second');
  });

  it('does not update after unmounting, and leaves no timer behind', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    bridgeCopyText.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const { result, unmount } = renderHook(() => useCopy({ value: 'late' }));
    let pending: Promise<void> | undefined;
    act(() => { pending = result.current.copy(); });
    unmount();
    release?.();
    await act(async () => { await pending; });
    expect(vi.getTimerCount()).toBe(0);
  });
});
