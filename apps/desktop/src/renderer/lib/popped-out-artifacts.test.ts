import { SITE_MANIFEST_MIME_TYPE } from '@rally/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { WorkstreamResource } from './types';
import { refreshPoppedOutArtifacts } from './popped-out-artifacts';

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
        updatePoppedOutArtifact: vi.fn(async () => true),
      },
      inFlight: new Set(),
      loadResourceContent,
      resources: [artifact],
    });
    expect(loadResourceContent).not.toHaveBeenCalled();
  });

  it('replaces a generated window from authorized bytes when its version advances', async () => {
    const updatePoppedOutArtifact = vi.fn(async () => true);
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

  it('mints a fresh one-shot URL when a detached live site advances', async () => {
    const site = { ...artifact, id: 'resource-site', mimeType: SITE_MANIFEST_MIME_TYPE };
    const updatePoppedOutArtifact = vi.fn(async () => true);
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
      })),
      resources: [site],
    });
    expect(updatePoppedOutArtifact).toHaveBeenCalledWith({
      kind: 'site',
      resourceId: site.id,
      version: 3,
      artifactId: 'artifact-site',
      url: 'https://artifact-site-g.rallyusercontent.test/__rally/open#fresh',
      title: site.title,
    });
  });
});
