import { SITE_MANIFEST_MIME_TYPE } from '@rally/contracts';
import type { RallyDesktopBridge } from '../../common/desktop';
import type { WorkstreamResource } from './types';
import { MAX_RESOURCE_PREVIEW_WAIT_MS, readResourcePreview } from './resource-preview';
import { ApiError } from './api';
import type { DesktopRestorableArtifactWindow } from '../../common/desktop';

export async function restorePoppedOutArtifacts(input: {
  bridge: Pick<RallyDesktopBridge, 'getRestorableArtifactWindows' | 'popOutArtifact' | 'forgetRestorableArtifactWindow'>;
  getResourceVersions: (resourceId: string) => Promise<{ version: number; title: string; mimeType: string | null }[]>;
  loadResourceContent: (resourceId: string, signal?: AbortSignal) => Promise<Blob>;
  openSiteArtifact: (resourceId: string) => Promise<{ artifactId: string; openUrl: string }>;
  signal: AbortSignal;
}): Promise<void> {
  const windows = await input.bridge.getRestorableArtifactWindows();
  await Promise.all(windows.map(async (saved: DesktopRestorableArtifactWindow) => {
    if (input.signal.aborted) return;
    try {
      const current = (await input.getResourceVersions(saved.resourceId))[0];
      if (input.signal.aborted) return;
      const version = current?.version ?? saved.version;
      const title = current?.title ?? saved.title;
      if ((current?.mimeType ?? saved.mimeType) === SITE_MANIFEST_MIME_TYPE
        || (!current?.mimeType && saved.kind === 'site')) {
        const access = await input.openSiteArtifact(saved.resourceId);
        if (input.signal.aborted) return;
        await input.bridge.popOutArtifact({
          kind: 'site', ...(saved.annotationScope?{annotationScope:saved.annotationScope}:{}), restoreId: saved.id, resourceId: saved.resourceId,
          version, title, artifactId: access.artifactId, url: access.openUrl,
        });
      } else {
        const content = await readResourcePreview(input.loadResourceContent, saved.resourceId,
          input.signal, MAX_RESOURCE_PREVIEW_WAIT_MS);
        const bytes = new Uint8Array(await content.arrayBuffer());
        if (input.signal.aborted) return;
        await input.bridge.popOutArtifact({
          kind: 'generated', ...(saved.annotationScope?{annotationScope:saved.annotationScope}:{}), restoreId: saved.id, resourceId: saved.resourceId,
          version, title, content: bytes, sourceMimeType:current ? current.mimeType ?? 'application/octet-stream' : saved.mimeType ?? 'application/octet-stream',
          mimeType: content.type || current?.mimeType || saved.mimeType || 'text/plain',
        });
      }
    } catch (error) {
      if (!input.signal.aborted && error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        await input.bridge.forgetRestorableArtifactWindow(saved.id);
      }
    }
  }));
}

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
  resources: readonly Pick<WorkstreamResource, 'id' | 'currentVersion' | 'mimeType' | 'title'>[];
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
    if (!resource || resource.currentVersion <= openVersion) return;
    const key = `${resourceId}:${resource.currentVersion}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
      if (resource.mimeType === SITE_MANIFEST_MIME_TYPE) {
        if (!openSiteArtifact) return;
        let stale = true;
        while (stale) {
          const navigation = await openSiteArtifact(resource.id);
          stale = await bridge.updatePoppedOutArtifact({
            kind: 'site',
            resourceId: resource.id,
            version: resource.currentVersion,
            artifactId: navigation.artifactId,
            url: navigation.openUrl,
            title: resource.title,
          });
        }
        return;
      }
      const content = await readResourcePreview(
        loadResourceContent,
        resource.id,
        signal,
        MAX_RESOURCE_PREVIEW_WAIT_MS,
      );
      const bytes = new Uint8Array(await content.arrayBuffer());
      let stale = true;
      while (stale) {
        stale = await bridge.updatePoppedOutArtifact({
          kind: 'generated',
          resourceId: resource.id,
          version: resource.currentVersion,
          content: bytes,
          mimeType: content.type || resource.mimeType || 'text/plain',
          sourceMimeType:resource.mimeType ?? 'application/octet-stream',
          title: resource.title,
        });
      }
    } finally {
      inFlight.delete(key);
    }
  }));
}
