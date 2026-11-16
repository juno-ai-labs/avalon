import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { usePreparedSiteAccess } from '../../../../mobile/src/prepared-site-access';
import type { NativeArtifact } from '../../../../mobile/src/protocol';

// The native hook runs with the DOM harness's React instance.
vi.mock('../../../../mobile/node_modules/react', async () => import('react'));

it('clears a rejected cookie before requesting fresh access and never replays a consumed URL on retry', async () => {
  const canvas = { canvasId: 'canvas', resourceId: 'resource', version: 1, title: 'Shopping' };
  const canonicalUrl = 'https://example.rallyusercontent.com/';
  const access = { ...canvas, canonicalUrl, openUrl: canonicalUrl };
  let finish!: (access: NativeArtifact | null) => void;
  const open = vi.fn(() => new Promise<NativeArtifact | null>(resolve => { finish = resolve; }));
  const hook = renderHook(() => usePreparedSiteAccess(canvas, { canvas: access }, open, 'rallyusercontent.com'));
  try {
    await waitFor(() => expect(hook.result.current.access?.openUrl).toBe(canonicalUrl));
    expect(open).not.toHaveBeenCalled();
    act(() => hook.result.current.retry());
    expect(hook.result.current.access).toBeNull();
    expect(open).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ...access, openUrl: canonicalUrl + '__rally/open#fresh' }));
    expect(hook.result.current.access?.openUrl).toBe(canonicalUrl + '__rally/open#fresh');
    act(() => hook.result.current.retry());
    expect(hook.result.current.access).toBeNull();
    expect(open).toHaveBeenCalledTimes(2);
    await act(async () => finish(null));
    expect(hook.result.current.failed).toBe(true);
    expect(hook.result.current.access).toBeNull();
  } finally { hook.unmount(); }
});

it('opens another artifact chosen in a pin\'s picker on its own access, not the preferred site\'s cookie', async () => {
  const preferred = 'https://reader.rallyusercontent.com/';
  const saved = { canvasId: 'canvas', resourceId: 'reader', version: 1, title: 'Newsletter', canonicalUrl: preferred, openUrl: preferred };
  const other = { canvasId: 'canvas', resourceId: 'archive', version: 4, title: 'Newsletter' };
  const fresh = { ...other, canonicalUrl: 'https://archive.rallyusercontent.com/', openUrl: 'https://archive.rallyusercontent.com/__rally/open#one' };
  const open = vi.fn(async () => fresh);
  const hook = renderHook(() => usePreparedSiteAccess(other, { canvas: saved }, open, 'rallyusercontent.com'));
  try {
    await waitFor(() => expect(hook.result.current.access?.openUrl).toBe(fresh.openUrl));
    expect(open).toHaveBeenCalledWith(other);
  } finally { hook.unmount(); }
});
