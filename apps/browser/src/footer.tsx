/** The public macOS build, the same file the marketing site links to. */
const MAC_DOWNLOAD_URL = "https://downloads.rallywith.ai/stable/darwin/arm64/Rally.dmg";

export function BrowserFooter() {
  return <footer className="browser-footer">
    <a className="browser-footer-download" href={MAC_DOWNLOAD_URL} download>Download the Mac app</a>
  </footer>;
}
