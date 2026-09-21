import { SITE_MANIFEST_MIME_TYPE } from '@rally/contracts';
import type { RallyDesktopBridge } from '../../common/desktop';
import type { WorkstreamResource } from './types';
import { MAX_RESOURCE_PREVIEW_WAIT_MS, readResourcePreview } from './resource-preview';

export interface RefreshPoppedOutArtifactsInput {
  bridge: Pick<
    RallyDesktopBridge,
    'getPoppedOutArtifactVersions' | 'updatePoppedOutArtifact'
  >;
  inFlight: Set<string>;
  loadResourceContent: (resourceId: string, signal?: AbortSignal) => Promise<Blob>;
  openSiteArtifact?: (resourceId: string) => Promise<{
    artifactId: string;
    openUrl: string;
  }>;
  resources: WorkstreamResource[];
  signal?: AbortSignal;
}

/**
 * Bring detached windows forward from the version they opened with.
 *
 * Main owns window lifetime and reports only windows that still exist. The
 * renderer remains the authorization boundary for content: it reads preview
 * bytes or mints a one-shot site navigation only after that report says a
 * window for the resource is stale.
 */
export async function refreshPoppedOutArtifacts({
  bridge,
  inFlight,
  loadResourceContent,
  openSiteArtifact,
  resources,
  signal = new AbortController().signal,
}: RefreshPoppedOutArtifactsInput): Promise<void> {
  const openVersions = await bridge.getPoppedOutArtifactVersions();
  const resourcesById = new Map(resources.map((resource) => [resource.id, resource]));
  await Promise.all(Object.entries(openVersions).map(async ([resourceId, openVersion]) => {
    const resource = resourcesById.get(resourceId);
    if (!resource || resource.currentVersion === openVersion) return;
    const key = `${resourceId}:${resource.currentVersion}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
      if (resource.mimeType === SITE_MANIFEST_MIME_TYPE) {
        if (!openSiteArtifact) return;
        const navigation = await openSiteArtifact(resource.id);
        await bridge.updatePoppedOutArtifact({
          kind: 'site',
          resourceId: resource.id,
          version: resource.currentVersion,
          artifactId: navigation.artifactId,
          url: navigation.openUrl,
          title: resource.title,
        });
        return;
      }
      const content = await readResourcePreview(
        loadResourceContent,
        resource.id,
        signal,
        MAX_RESOURCE_PREVIEW_WAIT_MS,
      );
      await bridge.updatePoppedOutArtifact({
        kind: 'generated',
        resourceId: resource.id,
        version: resource.currentVersion,
        content: new Uint8Array(await content.arrayBuffer()),
        mimeType: content.type || resource.mimeType || 'text/plain',
        title: resource.title,
      });
    } finally {
      inFlight.delete(key);
    }
  }));
}
