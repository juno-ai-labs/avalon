import { describe, expect, it } from "vitest";
import {
  CONNECTOR_CATEGORY_DESCRIPTIONS,
  CONNECTOR_CARDS_MAX,
  CONNECTOR_OFFERINGS,
  CONNECTOR_OFFERING_IDS,
  ConnectorCardsBlockSchema,
  ConnectorOfferingIdSchema,
  connectorCardsFallbackText,
  ConnectorCategorySchema,
  connectionMatchesOffering,
  connectorOffering,
  connectorOfferingCapabilities,
  connectorOfferingsInCategory,
} from "./connector-offerings";

describe("connector offerings", () => {
  it("keeps the id schema and the registry in step", () => {
    // The schema is the gate every producer validates against and the registry
    // is what every surface renders from. An offering missing from one of them
    // is either an id nothing can render or a card nothing can publish.
    expect([...ConnectorOfferingIdSchema.options].sort()).toEqual([...CONNECTOR_OFFERING_IDS].sort());
  });

  it("gives every offering a unique id", () => {
    expect(new Set(CONNECTOR_OFFERING_IDS).size).toBe(CONNECTOR_OFFERINGS.length);
  });

  it("only claims an OAuth start for a scope the offering supports", () => {
    for (const offering of CONNECTOR_OFFERINGS) {
      for (const scope of offering.oauthScopes) {
        expect(offering.scopes).toContain(scope);
      }
    }
  });

  it("declares capabilities for every scope it offers", () => {
    for (const offering of CONNECTOR_OFFERINGS) {
      for (const scope of offering.scopes) {
        // The webhook and X offerings request no OAuth capabilities at all;
        // every other scope a person can be sent to has to ask for something,
        // or the authorization it starts grants nothing.
        if (offering.oauthScopes.includes(scope)) {
          expect(connectorOfferingCapabilities(offering, scope).length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("resolves an offering by id", () => {
    expect(connectorOffering("slack").connectorType).toBe("slack");
    expect(connectorOffering("google-drive-workspace").connectorType).toBe("google");
  });

  it("presents Google as two offerings of one connector type", () => {
    const google = CONNECTOR_OFFERINGS.filter((offering) => offering.connectorType === "google");
    expect(google).toHaveLength(2);
    expect(google[0]!.personalCapabilities).not.toEqual(google[1]!.personalCapabilities);
  });

  it("rejects a block naming an unknown offering", () => {
    const parsed = ConnectorCardsBlockSchema.safeParse({
      kind: "connector_cards",
      cards: [{ offeringId: "jira" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an empty block and one past the card limit", () => {
    expect(ConnectorCardsBlockSchema.safeParse({ kind: "connector_cards", cards: [] }).success).toBe(false);
    expect(ConnectorCardsBlockSchema.safeParse({
      kind: "connector_cards",
      cards: Array.from({ length: CONNECTOR_CARDS_MAX + 1 }, () => ({ offeringId: "slack" })),
    }).success).toBe(false);
  });

  it("writes a fallback sentence naming every offering in the block", () => {
    expect(connectorCardsFallbackText({
      kind: "connector_cards",
      cards: [{ offeringId: "slack" }, { offeringId: "github" }],
    })).toBe("Connect Slack or GitHub to Avalon.");
    expect(connectorCardsFallbackText({
      kind: "connector_cards",
      heading: "Pick where your work lives",
      cards: [{ offeringId: "notion" }],
    })).toBe("Pick where your work lives — Notion");
  });
});

describe("connector categories", () => {
  it("describes every category it declares", () => {
    expect(Object.keys(CONNECTOR_CATEGORY_DESCRIPTIONS).sort())
      .toEqual([...ConnectorCategorySchema.options].sort());
  });

  it("puts every offering in at least one category", () => {
    // An offering in no category cannot be found from a request that describes
    // a need rather than a product name, which is how most requests arrive.
    for (const offering of CONNECTOR_OFFERINGS) {
      expect(offering.categories.length).toBeGreaterThan(0);
    }
  });

  it("leaves no category without an offering", () => {
    for (const category of ConnectorCategorySchema.options) {
      expect(connectorOfferingsInCategory(category).length).toBeGreaterThan(0);
    }
  });

  it("answers a request that spans two categories with the one authorization covering both", () => {
    // "Email my boss three open slots from my calendar" — the case the whole
    // category model exists for. One Google grant covers it, so the person is
    // asked to connect once rather than twice.
    const email = connectorOfferingsInCategory("email").map((offering) => offering.id);
    const calendar = connectorOfferingsInCategory("calendar").map((offering) => offering.id);
    expect(email).toContain("google-mail-calendar");
    expect(calendar).toContain("google-mail-calendar");
    // And the other Google offering answers neither, which is the distinction
    // categories exist to keep.
    expect([...email, ...calendar]).not.toContain("google-drive-workspace");
  });
});

describe("connectionMatchesOffering", () => {
  const gmail = {
    connectorType: "google",
    scope: "personal" as const,
    grantedCapabilities: ["gmail.read", "calendar.read"],
  };

  it("tells two offerings of one connector type apart by capability", () => {
    expect(connectionMatchesOffering(gmail, connectorOffering("google-mail-calendar"))).toBe(true);
    expect(connectionMatchesOffering(gmail, connectorOffering("google-drive-workspace"))).toBe(false);
  });

  it("does not match a different connector type", () => {
    expect(connectionMatchesOffering(gmail, connectorOffering("slack"))).toBe(false);
  });

  it("narrows to a scope when one is asked for", () => {
    expect(connectionMatchesOffering(gmail, connectorOffering("google-mail-calendar"), "personal")).toBe(true);
    expect(connectionMatchesOffering(gmail, connectorOffering("google-mail-calendar"), "workspace")).toBe(false);
  });

  it("matches an offering that asks for no capabilities on type alone", () => {
    // The inbound webhook grants nothing, so there is nothing narrower to
    // compare and a type match is the whole answer.
    expect(connectionMatchesOffering(
      { connectorType: "generic_webhook", scope: "workspace", grantedCapabilities: [] },
      connectorOffering("generic-webhook"),
    )).toBe(true);
  });
});
