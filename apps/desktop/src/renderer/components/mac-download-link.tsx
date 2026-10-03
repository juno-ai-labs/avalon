import { SidebarNavigationRowContent } from '@rally/ui/components/navigation';
import { ConnectorMark } from '@rally/ui/components/primitives';
import { SidebarRow } from '@rally/ui/components/resizable-sidebar';
import { MAC_APP_DOWNLOAD_URL } from '../lib/browser-connectors';

/**
 * The Mac app's download, pinned above the account menu when the shell runs in
 * a browser tab. A Space-style row, so a compact rail collapses it to the same
 * lone tile a Space becomes.
 */
export function MacDownloadLink(): React.JSX.Element {
  return <div className="sidebar-download-slot">
    <SidebarRow as="a" href={MAC_APP_DOWNLOAD_URL} download aria-label="Download the Mac app">
      <SidebarNavigationRowContent
        icon={<span className="spaces-sidebar-mark"><ConnectorMark mark="apple" /></span>}
        title="Download the Mac app"
      />
    </SidebarRow>
  </div>;
}
