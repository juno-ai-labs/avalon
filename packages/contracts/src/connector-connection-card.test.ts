import { describe, expect, it } from "vitest";
import {
  CONNECTOR_CONNECTION_CARD_WIRE_NAME,
  CONNECTOR_CONNECTION_STATE_WIRE_NAME,
  ConnectorConnectionCardCatalog,
  ConnectorConnectionCardIds,
  ConnectorConnectionCardInputSchema,
  ConnectorConnectionCardScopes,
  ConnectorConnectionStateInputSchema,
  ConnectorConnectionStateResultSchema,
  bestConnectorConnectionState,
  connectorAuthorizationStatus,
  connectorConnectionCardSummary,
  connectorConnectionStateSummary,
  connectorConnectionCardInputFromToolEvent,
  isConnectorConnectionCardWireName,
  LEGACY_CONNECTOR_CONNECTION_CARD_WIRE_NAME,
} from "./connector-connection-card";

describe("connector connection card contract", () => {
  it("accepts Apollo personal cards and refuses workspace cards", () => {
    expect(ConnectorConnectionCardInputSchema.parse({ connectorId: "apollo", scope: "personal" }))
      .toEqual({ connectorId: "apollo", scope: "personal" });
    expect(ConnectorConnectionCardInputSchema.safeParse({ connectorId: "apollo", scope: "workspace" }).success).toBe(false);
  });

  it("accepts a trusted Slack personal card request", () => {
    expect(ConnectorConnectionCardInputSchema.parse({
      connectorId: "slack",
      scope: "personal",
    })).toEqual({ connectorId: "slack", scope: "personal" });
    expect(CONNECTOR_CONNECTION_CARD_WIRE_NAME).toBe("show_connector_connection");
    expect(CONNECTOR_CONNECTION_STATE_WIRE_NAME).toBe("get_connector_connection_state");
  });

  it("accepts only closed connector connection states", () => {
    expect(ConnectorConnectionStateResultSchema.parse({
      connectorId: "slack",
      state: "connected",
      connections: [{ scope: "personal", state: "connected" }],
    })).toEqual({ connectorId: "slack", state: "connected", connections: [{ scope: "personal", state: "connected" }] });
    expect(ConnectorConnectionStateResultSchema.safeParse({
      connectorId: "slack",
      state: "probably_connected",
      connections: [{ scope: "personal", state: "connected" }],
    }).success).toBe(false);
    expect(ConnectorConnectionStateResultSchema.safeParse({
      connectorId: "slack",
      state: "connected",
      connections: [],
    }).success).toBe(false);
  });

  it("lets the state check leave scope out, and accepts any scope it is sent", () => {
    expect(ConnectorConnectionStateInputSchema.parse({ connectorId: "slack" })).toEqual({ connectorId: "slack" });
    // Ignored by the check, so a scope the connector lacks is no reason to fail the call.
    expect(ConnectorConnectionStateInputSchema.parse({ connectorId: "granola", scope: "workspace" }))
      .toEqual({ connectorId: "granola", scope: "workspace" });
  });

  it("folds per-scope states to the best one and names each in the summary", () => {
    expect(bestConnectorConnectionState(["not_connected", "connected"])).toBe("connected");
    expect(bestConnectorConnectionState(["not_connected", "reconnect_required"])).toBe("reconnect_required");
    expect(bestConnectorConnectionState(["unavailable"])).toBe("unavailable");
    expect(connectorConnectionStateSummary({
      connectorId: "slack",
      state: "connected",
      connections: [{ scope: "personal", state: "not_connected" }, { scope: "workspace", state: "connected" }],
    })).toBe("slack: personal not_connected, workspace connected");
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

  it("still recognizes a card row stored under the retired core_ wire name", () => {
    // `rally:core` dropped its wire prefix. Rows written before that keep the
    // prefixed name, and a card that stops being recognized silently degrades
    // to a plain tool row with no connect button on it.
    expect(connectorConnectionCardInputFromToolEvent({
      name: LEGACY_CONNECTOR_CONNECTION_CARD_WIRE_NAME,
      status: "completed",
      output: { connectorId: "slack", scope: "personal" },
    })).toEqual({ connectorId: "slack", scope: "personal" });
    expect(isConnectorConnectionCardWireName(LEGACY_CONNECTOR_CONNECTION_CARD_WIRE_NAME)).toBe(true);
    expect(isConnectorConnectionCardWireName(CONNECTOR_CONNECTION_CARD_WIRE_NAME)).toBe(true);
    expect(isConnectorConnectionCardWireName(CONNECTOR_CONNECTION_STATE_WIRE_NAME)).toBe(false);
    expect(isConnectorConnectionCardWireName(undefined)).toBe(false);
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

describe("shared connector authorization status", () => {
  it.each([
    ["healthy", "healthy"], ["error", "healthy"],
    ["needs_reconnect", "reconnect_required"], ["disabled", "disabled"],
  ])("maps stored %s to %s for model and UI", (stored, expected) => {
    expect(connectorAuthorizationStatus(stored)).toBe(expected);
  });
});
