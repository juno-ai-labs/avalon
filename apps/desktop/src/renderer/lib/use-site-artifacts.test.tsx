import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type SiteArtifactsApi, useSiteArtifacts } from './use-site-artifacts';

function bridge() {
  return {
    presentArtifactPreview: vi.fn(),
    setArtifactPreviewBounds: vi.fn(),
    snapshotArtifactPreview: vi.fn(),
    artifactPreviewReady: vi.fn(),
    pickArtifactPreview: vi.fn(),
    showArtifactPreviewComments: vi.fn(),
    stopPickingArtifactPreview: vi.fn(),
    closeArtifactPreview: vi.fn(),
    popOutArtifact: vi.fn(),
    copyText: vi.fn(),
    openExternal: vi.fn(),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('useSiteArtifacts', () => {
  it('offers the site surfaces to any signed-in desktop window', async () => {
    const desktop = bridge();
    vi.stubGlobal('rally', desktop);
    const opened = {
      openUrl: 'https://open.site.example/',
      canonicalUrl: 'https://site.example/',
      artifactId: 'artifact-1',
      mode: 'static' as const,
      stateful: false,
    };
    const api = {
      openArtifact: vi.fn(async () => opened),
      describeArtifactData: vi.fn(),
      readArtifactTable: vi.fn(),
    } satisfies SiteArtifactsApi;

    const { result } = renderHook(() => useSiteArtifacts(api));

    expect(result.current).toBeDefined();
    expect(result.current?.surface.present).toBe(desktop.presentArtifactPreview);
    expect(result.current?.surface).not.toHaveProperty('framed');
    await expect(result.current?.openArtifact('resource-1')).resolves.toEqual({
      openUrl: 'https://open.site.example/',
      canonicalUrl: 'https://site.example/',
      artifactId: 'artifact-1',
      mode: 'static',
      stateful: false,
    });
    expect(api.openArtifact).toHaveBeenCalledWith('resource-1');
  });

  it('offers nothing without an API session to mint access with', () => {
    vi.stubGlobal('rally', bridge());

    const { result } = renderHook(() => useSiteArtifacts(null));

    expect(result.current).toBeUndefined();
  });
});
