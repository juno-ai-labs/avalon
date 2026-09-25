import { sidekickCanonicalUrl, spaceCanonicalUrl, workstreamCanonicalUrl } from '@rally/contracts/workstream-links';
import type { WorkspaceTarget } from '@rally/contracts/workspace-target';
import { desktopBridge } from './platform';
import { reportTelemetryProductIntent } from './telemetry';

/** Callers own error presentation; every surface shares the address and copy receipt. */
export async function copyWorkstreamLink(workspace: WorkspaceTarget, spaceId: string, workstreamId: string, substreamId = '0'): Promise<void> {
  const bridge = desktopBridge();
  const { webBaseUrl } = await bridge.getRuntimeConfig();
  await bridge.copyText(workstreamCanonicalUrl(webBaseUrl, {
    ...workspace, spaceId, workstreamId,
    ...(substreamId === '0' ? {} : { substreamId }),
  }));
  reportTelemetryProductIntent({
    kind: 'content_copied', contentType: 'workstream_link', resourceType: 'workstream', resourceId: workstreamId,
  });
}

export async function copySpaceLink(workspace: WorkspaceTarget, spaceId: string): Promise<void> {
  const bridge = desktopBridge();
  const { webBaseUrl } = await bridge.getRuntimeConfig();
  await bridge.copyText(spaceCanonicalUrl(webBaseUrl, { ...workspace, spaceId }));
}

export async function copySidekickLink(workspace: WorkspaceTarget, sidekickId: string): Promise<void> {
  const bridge = desktopBridge();
  const { webBaseUrl } = await bridge.getRuntimeConfig();
  await bridge.copyText(sidekickCanonicalUrl(webBaseUrl, { ...workspace, sidekickId }));
}
