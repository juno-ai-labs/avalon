import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopUpdateStatus } from '../../common/desktop';
import { useDownloadedUpdate } from './use-downloaded-update';

const getUpdateStatus = vi.hoisted(() => vi.fn());
const statusListeners = vi.hoisted(() => new Set<(status: DesktopUpdateStatus) => void>());

vi.mock('./platform', () => ({
  desktopBridge: () => ({
    getUpdateStatus,
    onUpdateStatusChanged: (listener: (status: DesktopUpdateStatus) => void) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
  }),
}));

function announce(status: DesktopUpdateStatus): void {
  act(() => {
    for (const listener of statusListeners) listener(status);
  });
}

describe('useDownloadedUpdate', () => {
  beforeEach(() => {
    statusListeners.clear();
    getUpdateStatus.mockReset();
    getUpdateStatus.mockResolvedValue({ kind: 'idle' });
  });

  it('adopts an update that was already downloaded when it mounted', async () => {
    getUpdateStatus.mockResolvedValue({ kind: 'downloaded', version: '1.2.0' });
    const { result } = renderHook(() => useDownloadedUpdate());

    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe('1.2.0'));
  });

  it('follows the broadcast in and out of the downloaded state', async () => {
    const { result } = renderHook(() => useDownloadedUpdate());
    await waitFor(() => expect(getUpdateStatus).toHaveBeenCalled());

    announce({ kind: 'downloaded', version: '1.2.0' });
    expect(result.current).toBe('1.2.0');

    announce({ kind: 'checking' });
    expect(result.current).toBeNull();
  });

  it('keeps a live downloaded version when an older idle snapshot settles', async () => {
    let resolveInitial!: (status: DesktopUpdateStatus) => void;
    getUpdateStatus.mockReturnValue(new Promise((resolve) => {
      resolveInitial = resolve;
    }));
    const { result } = renderHook(() => useDownloadedUpdate());
    await waitFor(() => expect(statusListeners.size).toBe(1));

    announce({ kind: 'downloaded', version: '1.2.0' });
    expect(result.current).toBe('1.2.0');

    await act(async () => {
      resolveInitial({ kind: 'idle' });
      await Promise.resolve();
    });
    expect(result.current).toBe('1.2.0');
  });

  it('stays hidden when the status cannot be read', async () => {
    getUpdateStatus.mockRejectedValue(new Error('Update status could not be read.'));
    const { result } = renderHook(() => useDownloadedUpdate());

    await waitFor(() => expect(getUpdateStatus).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });
});
