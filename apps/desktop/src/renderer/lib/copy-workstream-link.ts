import { workstreamCanonicalUrl } from '@rally/contracts/workstream-links';
import type { WorkspaceTarget } from '@rally/contracts/workspace-target';
import { desktopBridge } from './platform';
import { reportTelemetryProductIntent } from './telemetry';

/** Callers own error presentation; every surface shares the address and copy receipt. */
export async function copyWorkstreamLink(workspace: WorkspaceTarget, workstreamId: string, substreamId = '0'): Promise<void> {
  const bridge = desktopBridge();
  const { webBaseUrl } = await bridge.getRuntimeConfig();
  await bridge.copyText(workstreamCanonicalUrl(webBaseUrl, {
    ...workspace, workstreamId,
    ...(substreamId === '0' ? {} : { substreamId }),
  }));
  reportTelemetryProductIntent({
    kind: 'content_copied', contentType: 'workstream_link', resourceType: 'workstream', resourceId: workstreamId,
  });
}
