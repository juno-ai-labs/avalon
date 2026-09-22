import { RefreshCcw } from 'lucide-react';

import { SidebarNavigationRowContent } from './navigation';
import { SidebarRow } from './resizable-sidebar';

interface SidebarRefreshRowProps {
  onRefresh: () => void;
}

/** A recovery action that belongs to a navigation list without becoming warning copy. */
export function SidebarRefreshRow({ onRefresh }: SidebarRefreshRowProps): React.JSX.Element {
  return (
    <SidebarRow aria-label="Refresh" onClick={onRefresh} type="button">
      <SidebarNavigationRowContent
        icon={<RefreshCcw aria-hidden="true" size={20} strokeWidth={1.7} />}
        title="Refresh"
      />
    </SidebarRow>
  );
}
