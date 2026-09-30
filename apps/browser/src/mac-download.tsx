import { Download } from "lucide-react";

/** The public macOS build, the same file the marketing site links to. */
const MAC_DOWNLOAD_URL = "https://downloads.rallywith.ai/stable/darwin/arm64/Rally.dmg";

/** Pinned above the account menu, in whichever rail holds it. A compact rail shows the icon alone. */
export function MacDownloadLink() {
  return <div className="browser-download-slot">
    <a className="browser-download" href={MAC_DOWNLOAD_URL} download aria-label="Download the Mac app">
      <Download size={16} aria-hidden="true" /><span className="browser-download-label">Download the Mac app</span>
    </a>
  </div>;
}
