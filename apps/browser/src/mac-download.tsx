import { SidebarNavigationRowContent } from "@rally/ui/components/navigation";
import { ConnectorMark } from "@rally/ui/components/primitives";
import { SidebarRow } from "@rally/ui/components/resizable-sidebar";

/** The public macOS build, the same file the marketing site links to. */
const MAC_DOWNLOAD_URL = "https://downloads.rallywith.ai/stable/darwin/arm64/Rally.dmg";

/**
 * Pinned above the account menu, in whichever rail holds it. It is a Space-style
 * row, so a compact rail collapses it to the same lone tile a Space becomes.
 */
export function MacDownloadLink() {
  return <div className="browser-download-slot">
    <SidebarRow as="a" href={MAC_DOWNLOAD_URL} download aria-label="Download the Mac app">
      <SidebarNavigationRowContent
        icon={<span className="spaces-sidebar-mark"><ConnectorMark mark="apple" /></span>}
        title="Download the Mac app"
      />
    </SidebarRow>
  </div>;
}
