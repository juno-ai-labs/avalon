import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MESSAGE_MAX_CHARACTERS, SidelineCatalogSchema } from "@rally/contracts";
import { SidelineComposer, type SidelineCardModel } from "@rally/ui/components/sideline-composer";

const catalog = SidelineCatalogSchema.parse({
  workspace: { id: "00000000-0000-7000-8000-00000000d001", name: "Northstar" },
  operator: { userId: "00000000-0000-7000-8000-00000000d002", name: "Jordan" },
  participants: [{
    userId: "00000000-0000-7000-8000-00000000d003",
    name: "Priya",
    avatarUrl: null,
    destinations: [],
  }],
});

function card(patch: Partial<SidelineCardModel> = {}): SidelineCardModel {
  return {
    id: "card",
    idempotencyKey: "00000000-0000-7000-8000-00000000d004",
    representedUserId: catalog.participants[0]!.userId,
    workstreamId: "",
    substreamId: "0",
    message: "Draft",
    state: "idle",
    ...patch,
  };
}

function render(model: SidelineCardModel): string {
  return renderToStaticMarkup(<SidelineComposer
    catalog={catalog}
    workspaceName={catalog.workspace.name}
    operatorName={catalog.operator.name}
    cards={[model]}
    status="ready"
    onAdd={() => undefined}
    onRemove={() => undefined}
    onChange={() => undefined}
    onSend={() => undefined}
    onRetryCatalog={() => undefined}
    onOpenInRally={() => undefined}
    onSignOut={() => undefined}
  />);
}

describe("Sideline shared composer", () => {
  it("labels mixed self and represented messaging without implying a self-send audit", () => {
    const html = render(card());

    expect(html).toContain("Messaging");
    expect(html).toContain("Sending as another participant is audited.");
    expect(html).toContain('aria-label="Messages"');
    expect(html).toContain('placeholder="Write a message"');
    expect(html).not.toContain("Impersonation");
  });

  it("names the selected participant's empty-destination state and disables send", () => {
    const html = render(card());

    expect(html).toContain("This participant has no eligible destination.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Send/su);
  });

  it("says so when a refreshed catalog no longer lists the chosen destination", () => {
    const html = render(card({ workstreamId: "00000000-0000-7000-8000-00000000d005" }));

    expect(html).toContain("Priya is no longer in this destination. Choose another.");
    expect(html).not.toContain("This participant has no eligible destination.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Send/su);
  });

  it("says so when a refreshed catalog no longer lists the chosen participant", () => {
    const html = render(card({ representedUserId: "00000000-0000-7000-8000-00000000d006" }));

    expect(html).toContain("This participant is no longer available. Choose another.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Send/su);
  });

  it("names Message when the existing platform length guard is exceeded", () => {
    const html = render(card({ message: "x".repeat(MESSAGE_MAX_CHARACTERS + 1) }));

    expect(html).toContain("<strong>Message:</strong>");
    expect(html).toContain("This message is over 100,000 characters, please shorten it.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Send/su);
  });
});
