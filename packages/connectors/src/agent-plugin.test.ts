import { describe, expect, it } from "vitest";
import {
  ConnectorRegistry,
  createGenericWebhookConnector,
  createGitHubConnector,
  createGoogleConnector,
  createLinearConnector,
  createNotionConnector,
  createWebMonitorConnector,
  type ConnectorAdapter,
  type ConnectorConnectionContext,
} from "./index";

const REMOTE_MARKERS = [
  "ACME-ACCOUNT-NAME",
  "TOP-SECRET-CREDENTIAL",
  "REMOTE-RESOURCE-TITLE",
] as const;

describe("connector agent plugins", () => {
  it("provides one trusted provider descriptor whose tools match the manifest", () => {
    for (const adapter of configuredAdapters()) {
      expect(adapter.agentPlugin.providerType).toBe(adapter.manifest.type);
      expect(adapter.agentPlugin.tools.map((tool) => tool.name)).toEqual(
        adapter.manifest.tools.map((tool) => tool.name),
      );
      expect(adapter.agentPlugin.description.trim()).not.toBe("");
      expect(adapter.agentPlugin.systemMessage.trim()).not.toBe("");
      expect(Object.isFrozen(adapter.agentPlugin)).toBe(true);
      expect(Object.isFrozen(adapter.agentPlugin.tools)).toBe(true);
    }
  });

  it("keeps credentials, account labels, and resource metadata out of trusted instructions", () => {
    const connection: ConnectorConnectionContext = {
      id: "connection-with-remote-content",
      workspaceId: "workspace",
      scope: "personal",
      ownerUserId: "user",
      grantedScopes: [],
      credentials: { accessToken: REMOTE_MARKERS[1] },
      cursor: {},
      config: {
        accountName: REMOTE_MARKERS[0],
        resourceTitle: REMOTE_MARKERS[2],
      },
    };

    // A connection is intentionally not an input to the provider descriptor.
    expect(connection.config.accountName).toBe(REMOTE_MARKERS[0]);
    for (const adapter of configuredAdapters()) {
      const trustedInstructions = `${adapter.agentPlugin.description}\n${adapter.agentPlugin.systemMessage}`;
      for (const marker of REMOTE_MARKERS) {
        expect(trustedInstructions).not.toContain(marker);
      }
    }
  });

  it("rejects provider metadata or tool mappings that diverge from the manifest", () => {
    const adapter = createGenericWebhookConnector();
    const mismatchedProvider: ConnectorAdapter = {
      ...adapter,
      agentPlugin: { ...adapter.agentPlugin, providerType: "other" },
    };
    expect(() => new ConnectorRegistry([mismatchedProvider])).toThrow(/provider type must match/u);

    const mismatchedTools: ConnectorAdapter = {
      ...createWebMonitorConnector(),
      agentPlugin: { ...createWebMonitorConnector().agentPlugin, tools: [] },
    };
    expect(() => new ConnectorRegistry([mismatchedTools])).toThrow(/tools must match/u);
  });
});

function configuredAdapters(): ConnectorAdapter[] {
  return [
    createGenericWebhookConnector(),
    createWebMonitorConnector(),
    createGoogleConnector({
      clientId: REMOTE_MARKERS[0],
      clientSecret: REMOTE_MARKERS[1],
      redirectUri: "https://api.with-avalon.test/connections/google/callback",
    }),
    createGitHubConnector({
      appId: "1",
      clientId: REMOTE_MARKERS[0],
      clientSecret: REMOTE_MARKERS[1],
      privateKey: "-----BEGIN PRIVATE KEY-----\nTOP-SECRET-CREDENTIAL\n-----END PRIVATE KEY-----",
      redirectUri: "https://api.with-avalon.test/connections/github/callback",
      webhookSecret: REMOTE_MARKERS[1],
    }),
    createLinearConnector({
      clientId: REMOTE_MARKERS[0],
      clientSecret: REMOTE_MARKERS[1],
      redirectUri: "https://api.with-avalon.test/connections/linear/callback",
    }),
    createNotionConnector({
      clientId: REMOTE_MARKERS[0],
      clientSecret: REMOTE_MARKERS[1],
      redirectUri: "https://api.with-avalon.test/connections/notion/callback",
    }),
  ];
}
