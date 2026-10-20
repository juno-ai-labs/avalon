import { SITE_MANIFEST_MIME_TYPE } from '@rally/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { WorkstreamResource } from './types';
import { refreshPoppedOutArtifacts } from './popped-out-artifacts';
import { restorePoppedOutArtifacts } from './popped-out-artifacts';
import { ApiError } from './api';

const artifact: WorkstreamResource = {
  id: 'resource-document',
  title: 'Launch brief',
  resourceType: 'document',
  mimeType: 'text/markdown',
  contentAvailable: true,
  refreshSupported: false,
  watchEnabled: false,
  watchStatus: 'unsupported',
  currentVersion: 3,
  relationshipType: 'context',
  direction: 'artifact',
};

describe('refreshing detached artifact windows', () => {
  it('does not read content when no detached window needs it', async () => {
    const loadResourceContent = vi.fn();
    await refreshPoppedOutArtifacts({
      bridge: {
        getPoppedOutArtifactVersions: vi.fn(async () => ({})),
        updatePoppedOutArtifact: vi.fn(async () => false),
      },
      inFlight: new Set(),
      loadResourceContent,
      resources: [artifact],
    });
    expect(loadResourceContent).not.toHaveBeenCalled();
  });

  it('replaces a generated window from authorized bytes when its version advances', async () => {
    const updatePoppedOutArtifact = vi.fn(async () => false);
    await refreshPoppedOutArtifacts({
      bridge: {
        getPoppedOutArtifactVersions: vi.fn(async () => ({ [artifact.id]: 2 })),
        updatePoppedOutArtifact,
      },
      inFlight: new Set(),
      loadResourceContent: vi.fn(async () => new Blob(['Version three'], { type: 'text/markdown' })),
      resources: [artifact],
    });
    expect(updatePoppedOutArtifact).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'generated',
      resourceId: artifact.id,
      version: 3,
      mimeType: 'text/markdown',
    }));
  });

  it('leaves a window alone that already shows a newer version than the one it is told of', async () => {
    const loadResourceContent = vi.fn();
    const updatePoppedOutArtifact = vi.fn(async () => false);
    await refreshPoppedOutArtifacts({
      bridge: {
        getPoppedOutArtifactVersions: vi.fn(async () => ({ [artifact.id]: 5 })),
        updatePoppedOutArtifact,
      },
      inFlight: new Set(),
      loadResourceContent,
      resources: [artifact],
    });
    expect(loadResourceContent).not.toHaveBeenCalled();
    expect(updatePoppedOutArtifact).not.toHaveBeenCalled();
  });

  it('mints a fresh one-shot URL when a detached live site advances', async () => {
    const site = { ...artifact, id: 'resource-site', mimeType: SITE_MANIFEST_MIME_TYPE };
    const updatePoppedOutArtifact = vi.fn(async () => false);
    await refreshPoppedOutArtifacts({
      bridge: {
        getPoppedOutArtifactVersions: vi.fn(async () => ({ [site.id]: 2 })),
        updatePoppedOutArtifact,
      },
      inFlight: new Set(),
      loadResourceContent: vi.fn(),
      openSiteArtifact: vi.fn(async () => ({
        artifactId: 'artifact-site',
        openUrl: 'https://artifact-site-g.rallyusercontent.test/__rally/open#fresh',
        canonicalUrl: 'https://artifact-site-g.rallyusercontent.test', mode: 'active' as const, stateful: true,
      })),
      resources: [site],
    });
    expect(updatePoppedOutArtifact).toHaveBeenCalledWith({
      kind: 'site',
      resourceId: site.id,
      version: 3,
      artifactId: 'artifact-site',
      url: 'https://artifact-site-g.rallyusercontent.test/__rally/open#fresh',
      canonicalUrl: 'https://artifact-site-g.rallyusercontent.test', mode: 'active' as const, stateful: true,
      title: site.title,
    });
  });

  it('mints one URL per stale live-site window', async () => {
    const site = { ...artifact, id: 'resource-site', mimeType: SITE_MANIFEST_MIME_TYPE };
    const updatePoppedOutArtifact = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const openSiteArtifact = vi.fn()
      .mockResolvedValueOnce({ artifactId: 'artifact-site', openUrl: 'https://example.test/one' })
      .mockResolvedValueOnce({ artifactId: 'artifact-site', openUrl: 'https://example.test/two' });
    await refreshPoppedOutArtifacts({
      bridge: {
        getPoppedOutArtifactVersions: vi.fn(async () => ({ [site.id]: 2 })),
        updatePoppedOutArtifact,
      },
      inFlight: new Set(),
      loadResourceContent: vi.fn(),
      openSiteArtifact,
      resources: [site],
    });
    expect(openSiteArtifact).toHaveBeenCalledTimes(2);
    expect(updatePoppedOutArtifact.mock.calls.map(([request]) => request.url)).toEqual([
      'https://example.test/one',
      'https://example.test/two',
    ]);
  });
});

describe('restoring detached artifact windows', () => {
  it('retains the originating composer and generic source MIME for converted previews',async()=>{
    const popOutArtifact=vi.fn(async()=>true);
    await restorePoppedOutArtifacts({bridge:{getRestorableArtifactWindows:async()=>[{id:'saved',kind:'generated',resourceId:'resource',version:1,title:'Plan.docx',annotationScope:'conversation:0'}],popOutArtifact,forgetRestorableArtifactWindow:async()=>{}},getResourceVersions:async()=>[{version:2,title:'Plan.docx',mimeType:null}],loadResourceContent:async()=>new Blob(['# Converted text'],{type:'text/markdown'}),openSiteArtifact:async()=>{throw new Error('Not a site');},signal:new AbortController().signal});
    expect(popOutArtifact).toHaveBeenCalledWith(expect.objectContaining({kind:'generated',version:2,mimeType:'text/markdown',sourceMimeType:'application/octet-stream',annotationScope:'conversation:0'}));
  });

  it('reads current authorized bytes before opening a saved generated window', async () => {
    const popOutArtifact = vi.fn(async () => true);
    const loadResourceContent = vi.fn(async () => new Blob(['current'], { type: 'text/plain' }));
    await restorePoppedOutArtifacts({
      bridge: {
        getRestorableArtifactWindows: vi.fn(async () => [{ id: 'saved', kind: 'generated' as const,
          resourceId: 'resource', version: 1, title: 'Old', mimeType: 'text/plain' }]),
        popOutArtifact, forgetRestorableArtifactWindow: vi.fn(async () => undefined),
      },
      getResourceVersions: vi.fn(async () => [{ version: 2, title: 'Current', mimeType: 'text/plain' }]),
      loadResourceContent,
      openSiteArtifact: vi.fn(), signal: new AbortController().signal,
    });
    expect(loadResourceContent).toHaveBeenCalledWith('resource', expect.any(AbortSignal));
    expect(popOutArtifact).toHaveBeenCalledWith(expect.objectContaining({
      restoreId: 'saved', version: 2, title: 'Current', content: new Uint8Array([99, 117, 114, 114, 101, 110, 116]),
    }));
  });

  it('forgets a saved window whose resource is no longer authorized', async () => {
    const forgetRestorableArtifactWindow = vi.fn(async () => undefined);
    const popOutArtifact = vi.fn(async () => true);
    await restorePoppedOutArtifacts({
      bridge: {
        getRestorableArtifactWindows: vi.fn(async () => [{ id: 'saved', kind: 'site' as const,
          resourceId: 'resource', version: 1, title: 'Old' }]),
        popOutArtifact, forgetRestorableArtifactWindow,
      },
      getResourceVersions: vi.fn(async () => { throw new ApiError('Gone', 404); }),
      loadResourceContent: vi.fn(), openSiteArtifact: vi.fn(), signal: new AbortController().signal,
    });
    expect(forgetRestorableArtifactWindow).toHaveBeenCalledWith('saved');
    expect(popOutArtifact).not.toHaveBeenCalled();
  });
});
