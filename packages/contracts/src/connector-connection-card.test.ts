import { describe, expect, it } from "vitest";
import {
  CONNECTOR_CONNECTION_CARD_WIRE_NAME,
  CONNECTOR_CONNECTION_STATE_WIRE_NAME,
  ConnectorConnectionCardIds,
  ConnectorConnectionCardInputSchema,
  ConnectorConnectionStateInputSchema,
  sourceConnectionCardId,
  connectorConnectionCardSummary,
  connectorConnectionCardInputFromToolEvent,
  isConnectorConnectionCardWireName,
  LEGACY_CONNECTOR_CONNECTION_CARD_WIRE_NAME,
} from "./connector-connection-card";
import { ConnectorScopes } from "./connector-catalog";

describe("connector connection card contract", () => {
  it("accepts google-drive in either scope and retires the old id for new requests", () => {
    for (const scope of ["personal", "workspace"]) {
      expect(ConnectorConnectionCardInputSchema.parse({ connectorId: "google-drive", scope }))
        .toEqual({ connectorId: "google-drive", scope });
      expect(ConnectorConnectionCardInputSchema.safeParse({ connectorId: "google-drive-workspace", scope }).success)
        .toBe(false);
      expect(ConnectorConnectionStateInputSchema.safeParse({ connectorId: "google-drive-workspace" }).success)
        .toBe(false);
    }
  });

  it("normalizes historical Drive cards from input, output, or exact summary", () => {
    for (const name of ["show_connector_connection", "core_show_connector_connection"]) {
      for (const scope of ["personal", "workspace"]) {
        for (const facts of [
          { input: { connectorId: "google-drive-workspace", scope } },
          { output: { connectorId: "google-drive-workspace", scope } },
          { summary: `Presented the google-drive-workspace ${scope} connection card` },
        ]) {
          expect(connectorConnectionCardInputFromToolEvent({ name, status: "completed", ...facts }))
            .toEqual({ connectorId: "google-drive", scope });
        }
      }
    }
    expect(connectorConnectionCardInputFromToolEvent({
      name: "show_connector_connection", status: "completed",
      input: { connectorId: "google-drive-workspace", scope: "invalid" },
    })).toBeNull();
    expect(connectorConnectionCardInputFromToolEvent({
      name: "show_connector_connection", status: "completed",
      input: { connectorId: "google-drive-workspace", scope: "personal", authorizationUrl: "https://example.com" },
    })).toBeNull();
  });

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

  it("takes a connector alone, and refuses a scope rather than ignoring it", () => {
    expect(ConnectorConnectionStateInputSchema.parse({ connectorId: "slack" })).toEqual({ connectorId: "slack" });
    const withScope = ConnectorConnectionStateInputSchema.safeParse({ connectorId: "google-drive", scope: "workspace" });
    expect(withScope.success).toBe(false);
    expect(withScope.error?.issues).toMatchObject([{ code: "unrecognized_keys", keys: ["scope"] }]);
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

  it("offers a card for exactly the products a conversation can connect, in their card scopes", () => {
    expect(ConnectorConnectionCardIds).toEqual([
      "google-mail-calendar", "google-drive", "github", "apollo", "ashby",
      "fireflies", "granola", "linear", "slack", "notion",
    ]);
    // Made in Settings only: an administrator's key, or a server somebody configures.
    for (const connectorId of ["x", "custom-mcp"]) {
      expect(ConnectorConnectionCardInputSchema.safeParse({ connectorId, scope: "workspace" }).success).toBe(false);
    }
    expect(ConnectorConnectionCardInputSchema.safeParse({ connectorId: "ashby", scope: "personal" }).success).toBe(true);
    expect(ConnectorConnectionCardInputSchema.safeParse({ connectorId: "ashby", scope: "workspace" }).success).toBe(false);
    for (const scope of ConnectorScopes) {
      expect(ConnectorConnectionCardInputSchema.safeParse({ connectorId: "linear", scope }).success).toBe(true);
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

describe("the card that connects the account a source's events come from", () => {
  it.each([
    ["google", ["email.received"], "google-mail-calendar"],
    ["google", ["calendar.event_created", "email.received"], "google-mail-calendar"],
    ["google", ["drive.file_changed"], "google-drive"],
    // Mail and Drive are two connections: no one card connects both.
    ["google", ["email.received", "drive.file_changed"], null],
    ["granola", ["meeting.completed"], "granola"],
  ] as const)("names %s %j as %s", (connectorType, eventTypes, expected) => {
    expect(sourceConnectionCardId(connectorType, eventTypes)).toBe(expected);
  });
});
