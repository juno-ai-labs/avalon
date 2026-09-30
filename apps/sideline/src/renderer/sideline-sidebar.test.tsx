import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SidelineSidebar } from "@rally/ui/components/sideline-sidebar";

function render(downloadedUpdate: string | null): string {
  return renderToStaticMarkup(<SidelineSidebar
    currentUser={{ id: "user", name: "Jordan Lee", email: "jordan@example.com", timezone: "America/Los_Angeles" }}
    workspaceName="Northstar"
    activeOrganizationId="org-1"
    organizations={[{ id: "org-1", name: "Northstar" }, { id: "org-2", name: "Juno Labs" }]}
    onMenuOpen={() => undefined}
    onSwitchOrganization={async () => "switched" as const}
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

  describe("saved size", () => {
    const stored = new Map<string, string>();
    beforeEach(() => {
      stored.clear();
      vi.stubGlobal("window", {
        localStorage: {
          getItem: (key: string) => stored.get(key) ?? null,
          setItem: (key: string, value: string) => { stored.set(key, value); },
        },
      });
    });
    afterEach(() => vi.unstubAllGlobals());

    it("opens at the width this device saved", () => {
      stored.set("sideline.sidebar-width", "320");

      expect(render(null)).toContain("--spaces-sidebar-width:320px");
    });

    it("opens collapsed when this device saved it collapsed", () => {
      stored.set("sideline.sidebar-width", "320");
      stored.set("sideline.sidebar-collapsed", "true");

      const html = render(null);
      expect(html).toContain("--spaces-sidebar-width:88px");
      expect(html).toContain("is-compact");
    });

    it("falls back to the default width when the saved one is unreadable", () => {
      stored.set("sideline.sidebar-width", "wide");

      expect(render(null)).toContain("--spaces-sidebar-width:280px");
    });
  });
});
