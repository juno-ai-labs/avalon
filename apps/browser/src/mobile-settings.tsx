import { useEffect } from 'react';
import { useAppSession } from '../../desktop/src/renderer/lib/app-session';
import { useWorkspaceQuery } from '../../desktop/src/renderer/lib/use-workspace';
import { WorkspaceSettingsScreen } from '../../desktop/src/renderer/screens/workspace-settings';
import { mobileScreenReady } from './mobile-bridge';

/**
 * A shared Settings page in the mobile presentation. The native shell lists
 * the sections and owns the header, so the page draws one section's content
 * and nothing around it (`mobile.css`). It is the desktop's own screen, so a
 * setting changed here is the same write, through the same API, as on desktop.
 */
export function MobileSettings(): React.JSX.Element | null {
  const { api, session } = useAppSession();
  const workspace = useWorkspaceQuery({ api, session });
  const loaded = Boolean(workspace.data);
  useEffect(() => { if (loaded) mobileScreenReady(); }, [loaded]);
  if (!workspace.data) return null;
  return <WorkspaceSettingsScreen nativeShell workspace={workspace.data} />;
}
