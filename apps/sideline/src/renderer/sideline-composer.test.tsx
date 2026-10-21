import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SidelineCatalogSchema } from "@rally/contracts";
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

function render(model: SidelineCardModel, shown = catalog): string {
  return renderToStaticMarkup(<SidelineComposer
    catalog={shown}
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

  describe("when a refreshed catalog drops a choice the card made", () => {
    const destination = {
      workstreamId: "00000000-0000-7000-8000-00000000d005",
      substreamId: "00000000-0000-7000-8000-00000000d007",
      label: "Pricing review",
      workstreamLabel: "Launch readiness",
    };
    const priya = catalog.participants[0]!;
    const withDestination = SidelineCatalogSchema.parse({
      ...catalog,
      participants: [{ ...priya, destinations: [destination] }],
    });
    const chosen = card({
      workstreamId: destination.workstreamId,
      substreamId: destination.substreamId,
      representedName: "Priya",
      destinationLabel: "Pricing review",
    });

    it("sends while the destination is still listed", () => {
      const html = render(chosen, withDestination);
      expect(html).not.toContain('role="status">');
      expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>.*Send/su);
    });

    it("names the destination that went away, announces it, and ties it to the disabled Send", () => {
      const html = render(chosen, catalog);
      expect(html).toContain('role="status">Priya is no longer in Pricing review. Choose another destination.');
      expect(html).toContain("to <strong>Pricing review</strong>");
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="card-gone"[^>]*>.*Send/su);
      expect(html).not.toContain("This participant has no eligible destination.");
    });

    it("names the participant who went away", () => {
      const html = render(card({ ...chosen, representedUserId: "00000000-0000-7000-8000-00000000d006" }), withDestination);
      expect(html).toContain('role="status">You can no longer send as Priya. Choose another participant.');
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="card-gone"[^>]*>.*Send/su);
    });

    it("says nothing on a card that was already sent", () => {
      const html = render({ ...chosen, state: "sent", result: "Sent" }, catalog);
      expect(html).not.toContain("is no longer in");
    });
  });

});
