import { describe, expect, it } from "vitest";

import {
  ConnectorListResultSchema,
  ConnectorProductIds,
  ConnectorProductStateSchema,
  bestConnectorConnectionState,
  connectorAuthorizationStatus,
  connectorConnectionAccount,
  connectorConnectionName,
  connectorConnectionProductName,
  connectorListSummary,
  connectorProductStateSummary,
  connectorProductsForConnection,
  foldConnectorProductStates,
  groupConnectorProductsByFamily,
  type ConnectorConnectionRecord,
} from "./connector-catalog";

const everyProvider = new Set([
  "google", "github", "apollo", "ashby", "canva", "fireflies", "granola", "linear", "slack", "notion", "x",
  "custom_mcp", "generic_webhook",
]);

function record(overrides: Partial<ConnectorConnectionRecord>): ConnectorConnectionRecord {
  return { connectorType: "slack", scope: "personal", status: "healthy", capabilities: [], displayName: "Slack · Acme", ...overrides };
}

describe("connector product catalog", () => {
  it("splits one Google connection into the products its grants serve", () => {
    expect(connectorProductsForConnection({ connectorType: "google", capabilities: ["gmail.read", "drive.read"] }))
      .toEqual(["google-mail-calendar", "google-drive"]);
    expect(connectorProductsForConnection({ connectorType: "google", capabilities: ["sheets.write"] }))
      .toEqual(["google-drive"]);
    expect(connectorProductsForConnection({ connectorType: "google", capabilities: [] })).toEqual([]);
    expect(connectorProductsForConnection({ connectorType: "linear", capabilities: [] })).toEqual(["linear"]);
  });

  it("names a connection after the one product its grants serve, or else its provider", () => {
    expect(connectorConnectionProductName({ connectorType: "google", capabilities: ["drive.read"] }, "Google Workspace"))
      .toBe("Google Drive + Docs + Sheets");
    expect(connectorConnectionProductName({ connectorType: "google", capabilities: ["gmail.read", "drive.read"] }, "Google Workspace"))
      .toBe("Google Workspace");
    expect(connectorConnectionProductName({ connectorType: "x", capabilities: [] }, "X")).toBe("Public X via TwitterAPI.io");
  });

  it("names a connection after its product and account, and reads the account back", () => {
    const name = connectorConnectionName("Google Mail + Calendar", " ada@example.com\n");
    expect(name).toBe("Google Mail + Calendar · ada@example.com");
    expect(connectorConnectionAccount("account", name)).toBe("ada@example.com");
    expect(connectorConnectionAccount("account", "Linear · Ada · Acme")).toBe("Ada · Acme");
    expect(connectorConnectionAccount("account", "Canva")).toBeNull();
    expect(connectorConnectionAccount("account", "Ashby workspace events")).toBeNull();
    // A custom server's name is the one a person typed, separator or not.
    expect(connectorConnectionAccount("name", "Acme CRM · prod")).toBe("Acme CRM · prod");
    expect(connectorConnectionName("GitHub", "x".repeat(400))).toHaveLength(180);
  });

  it.each([
    ["healthy", "healthy"], ["error", "healthy"],
    ["needs_reconnect", "reconnect_required"], ["disabled", "disabled"],
  ])("maps stored %s to %s for model and UI", (stored, expected) => {
    expect(connectorAuthorizationStatus(stored)).toBe(expected);
  });

  it("folds per-scope states to the best one", () => {
    expect(bestConnectorConnectionState(["not_connected", "connected"])).toBe("connected");
    expect(bestConnectorConnectionState(["not_connected", "reconnect_required"])).toBe("reconnect_required");
    expect(bestConnectorConnectionState(["unavailable"])).toBe("unavailable");
  });
});

describe("folding saved connections into product states", () => {
  it("reports each account, every offered scope, and where a missing one is made", () => {
    const [mail] = foldConnectorProductStates(["google-mail-calendar"], [
      record({ connectorType: "google", capabilities: ["gmail.read"], displayName: "Google Mail + Calendar · ada@example.com" }),
      record({ connectorType: "google", capabilities: ["calendar.read"], status: "needs_reconnect", displayName: "Google Mail + Calendar · ada@other.example" }),
      record({ connectorType: "google", capabilities: ["drive.read"], displayName: "Google Drive + Docs + Sheets · ada@example.com" }),
      record({ connectorType: "google", capabilities: ["gmail.read"], status: "disabled", displayName: "Google Mail + Calendar · old@example.com" }),
    ], everyProvider);
    expect(mail).toEqual({
      connectorId: "google-mail-calendar",
      name: "Google Mail + Calendar",
      description: "Gmail messages, drafts, sent mail, and calendar events.",
      state: "connected",
      connections: [{ scope: "personal", state: "connected", connectIn: "conversation" }],
      accounts: [
        { scope: "personal", state: "connected", account: "ada@example.com" },
        { scope: "personal", state: "reconnect_required", account: "ada@other.example" },
      ],
    });
    expect(ConnectorProductStateSchema.parse(mail)).toEqual(mail);
    expect(connectorProductStateSummary(mail!)).toBe("google-mail-calendar: personal connected");
  });

  it("says a scope only Settings can connect is made there", () => {
    const [ashby, x] = foldConnectorProductStates(["ashby", "x"], [], everyProvider);
    expect(ashby!.connections).toEqual([
      { scope: "personal", state: "not_connected", connectIn: "conversation" },
      { scope: "workspace", state: "not_connected", connectIn: "settings" },
    ]);
    expect(x!.connections).toEqual([{ scope: "workspace", state: "not_connected", connectIn: "settings" }]);
  });

  it("counts a connection in a scope closed to new ones, and says only Settings makes it", () => {
    // Fireflies stopped taking workspace keys; ones pasted before still serve tools.
    const [fireflies] = foldConnectorProductStates(["fireflies"], [
      record({ connectorType: "fireflies", scope: "workspace", displayName: "Fireflies · Acme" }),
    ], everyProvider);
    expect(fireflies).toMatchObject({
      state: "connected",
      connections: [
        { scope: "personal", state: "not_connected", connectIn: "conversation" },
        { scope: "workspace", state: "connected", connectIn: "settings" },
      ],
      accounts: [{ scope: "workspace", state: "connected", account: "Acme" }],
    });
  });

  it("calls a product whose provider this deployment lacks unavailable in every scope", () => {
    const [github] = foldConnectorProductStates(["github"], [record({ connectorType: "github" })], new Set(["slack"]));
    expect(github).toMatchObject({
      state: "unavailable",
      connections: [
        { scope: "personal", state: "unavailable" },
        { scope: "workspace", state: "unavailable" },
      ],
      accounts: [],
    });
  });
});

describe("grouping products by family", () => {
  it("lists families in catalog order, a product under each of its families", () => {
    const result = groupConnectorProductsByFamily(foldConnectorProductStates(
      ["slack", "linear", "github"],
      [record({ connectorType: "github", displayName: "GitHub · octo-org" })],
      everyProvider,
    ));
    expect(result.families.map(({ family, connectors }) => [family, connectors.map(({ connectorId }) => connectorId)]))
      .toEqual([
        ["team_chat", ["slack"]],
        ["issue_tracking", ["linear", "github"]],
        ["code", ["github"]],
      ]);
    expect(result.families[0]!.label).toBe("Team chat");
    expect(ConnectorListResultSchema.parse(result)).toEqual(result);
    expect(connectorListSummary(result)).toBe("Listed connectors in 3 families; connected: github");
  });

  it("puts every product in a family", () => {
    const listed = groupConnectorProductsByFamily(foldConnectorProductStates(ConnectorProductIds, [], everyProvider))
      .families.flatMap(({ connectors }) => connectors.map(({ connectorId }) => connectorId));
    expect(new Set(listed)).toEqual(new Set(ConnectorProductIds));
    expect(ConnectorProductIds).toHaveLength(14);
  });
});
