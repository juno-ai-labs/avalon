import { describe, expect, it } from "vitest";
import {
  CONNECTOR_CONNECTION_CARD_WIRE_NAME,
  CONNECTOR_CONNECTION_STATE_WIRE_NAME,
  ConnectorConnectionCardCatalog,
  ConnectorConnectionCardIds,
  ConnectorConnectionCardInputSchema,
  ConnectorConnectionCardScopes,
  ConnectorConnectionStateResultSchema,
  connectorConnectionCardSummary,
  connectorConnectionCardInputFromToolEvent,
} from "./connector-connection-card";

describe("connector connection card contract", () => {
  it("accepts a trusted Slack personal card request", () => {
    expect(ConnectorConnectionCardInputSchema.parse({
      connectorId: "slack",
      scope: "personal",
    })).toEqual({ connectorId: "slack", scope: "personal" });
    expect(CONNECTOR_CONNECTION_CARD_WIRE_NAME).toBe("core_show_connector_connection");
    expect(CONNECTOR_CONNECTION_STATE_WIRE_NAME).toBe("core_get_connector_connection_state");
  });

  it("accepts only closed connector connection states", () => {
    expect(ConnectorConnectionStateResultSchema.parse({
      connectorId: "slack",
      scope: "personal",
      state: "connected",
    })).toEqual({ connectorId: "slack", scope: "personal", state: "connected" });
    expect(ConnectorConnectionStateResultSchema.safeParse({
      connectorId: "slack",
      scope: "personal",
      state: "probably_connected",
    }).success).toBe(false);
    expect(ConnectorConnectionStateResultSchema.parse({
      connectorId: "slack",
      scope: "personal",
      state: "unavailable",
    }).state).toBe("unavailable");
  });

  it("recovers durable card identity without accepting arbitrary summary prose", () => {
    expect(connectorConnectionCardInputFromToolEvent({
      name: CONNECTOR_CONNECTION_CARD_WIRE_NAME,
      status: "completed",
      output: { connectorId: "slack", scope: "personal" },
    })).toEqual({ connectorId: "slack", scope: "personal" });
    expect(connectorConnectionCardInputFromToolEvent({
      name: CONNECTOR_CONNECTION_CARD_WIRE_NAME,
      status: "completed",
      summary: connectorConnectionCardSummary({ connectorId: "slack", scope: "personal" }),
    })).toEqual({ connectorId: "slack", scope: "personal" });
    expect(connectorConnectionCardInputFromToolEvent({
      name: CONNECTOR_CONNECTION_CARD_WIRE_NAME,
      status: "completed",
      summary: "Please present the slack personal connection card",
    })).toBeNull();
  });

  it("derives every accepted id and scope from the shared non-UI catalog", () => {
    expect(ConnectorConnectionCardIds).toEqual(Object.keys(ConnectorConnectionCardCatalog));
    for (const [connectorId, entry] of Object.entries(ConnectorConnectionCardCatalog)) {
      expect(entry.iconName).not.toBe("");
      for (const scope of ConnectorConnectionCardScopes) {
        const supported = (entry.scopes as readonly string[]).includes(scope);
        expect(ConnectorConnectionCardInputSchema.safeParse({ connectorId, scope }).success).toBe(supported);
      }
    }
  });

  it("rejects display data and unknown connectors from the model", () => {
    expect(ConnectorConnectionCardInputSchema.safeParse({
      connectorId: "slack",
      scope: "personal",
      authorizationUrl: "https://example.com/phishing",
    }).success).toBe(false);
    expect(ConnectorConnectionCardInputSchema.safeParse({
      connectorId: "made-up-provider",
      scope: "personal",
    }).success).toBe(false);
    expect(ConnectorConnectionCardInputSchema.safeParse({
      connectorId: "granola",
      scope: "workspace",
    }).success).toBe(false);
  });
});
