import { sidekickCanonicalUrl } from '@rally/contracts/workstream-links';
import type { WorkspaceTarget } from '@rally/contracts/workspace-target';
import { desktopBridge } from './platform';

/** Copies a Sidekick's canonical link. Callers own error presentation. */
export async function copySidekickLink(workspace: WorkspaceTarget, sidekickId: string): Promise<void> {
  const bridge = desktopBridge();
  const { webBaseUrl } = await bridge.getRuntimeConfig();
  await bridge.copyText(sidekickCanonicalUrl(webBaseUrl, { ...workspace, sidekickId }));
}
