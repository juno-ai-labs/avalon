import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SidelineSidebar } from "@rally/ui/components/sideline-sidebar";

function render(downloadedUpdate: string | null): string {
  return renderToStaticMarkup(<SidelineSidebar
    currentUser={{ id: "user", name: "Jordan Lee", email: "jordan@example.com", timezone: "America/Los_Angeles" }}
    workspaceName="Northstar"
    downloadedUpdate={downloadedUpdate}
    onRestartToUpdate={() => undefined}
    onSignOut={() => undefined}
  >
    <p>Composer</p>
  </SidelineSidebar>);
}

describe("Sideline sidebar", () => {
  it("draws the Impersonate row, the account footer, and the page beside them", () => {
    const html = render(null);

    expect(html).toContain('aria-label="Sideline navigation"');
    expect(html).toContain("Impersonate");
    expect(html).toContain('aria-label="Jordan Lee, Northstar"');
    expect(html).toContain("<p>Composer</p>");
  });

  it("offers a restart in the header only while an update is downloaded", () => {
    expect(render(null)).not.toContain("Restart to update");
    expect(render("0.2.0")).toContain('aria-label="Restart to update to Sideline 0.2.0"');
  });
});
