import { describe, expect, it } from "vitest";

import { connectorCatalogConsistencyIssue } from "./index";
import type { ConnectorAdapter } from "./types";

type Checked = Pick<ConnectorAdapter, "manifest" | "connectableScopes">;

function adapter(type: string, supportedScopes: string[], capabilities: string[], connectableScopes?: string[], host: string[] = []): Checked {
  return {
    manifest: { type, supportedScopes, capabilities: [
      ...capabilities.map((id) => ({ id, kind: "tool" })),
      ...host.map((id) => ({ id, kind: "host" })),
    ] },
    ...(connectableScopes ? { connectableScopes } : {}),
  } as unknown as Checked;
}

describe("connector catalog consistency", () => {
  it("accepts an adapter that agrees with its products", () => {
    expect(connectorCatalogConsistencyIssue(adapter("google", ["personal", "workspace"], ["gmail.read", "drive.read"])))
      .toBeNull();
    expect(connectorCatalogConsistencyIssue(adapter("ashby", ["personal", "workspace"], ["ashby.personal.mcp"], ["personal"], ["ashby.workspace.events"])))
      .toBeNull();
    // A scope closed to new connections may stay supported for old ones.
    expect(connectorCatalogConsistencyIssue(adapter("fireflies", ["personal", "workspace"], ["fireflies.personal.read"], ["personal"])))
      .toBeNull();
  });

  it("names a provider the catalog has no product for", () => {
    expect(connectorCatalogConsistencyIssue(adapter("jira", ["personal"], [])))
      .toBe("has no product in the connector catalog");
  });

  it("names a scope a product offers that the adapter does not support", () => {
    expect(connectorCatalogConsistencyIssue(adapter("linear", ["personal"], [])))
      .toBe("product linear offers workspace, which the adapter does not support");
  });

  it("names a card scope the adapter no longer accepts", () => {
    expect(connectorCatalogConsistencyIssue(adapter("slack", ["personal", "workspace"], [], ["personal"])))
      .toBe("product slack lets a card connect workspace, which the adapter does not accept");
  });

  it("names a host grant the catalog and the manifest disagree about", () => {
    // Declared tool-bearing by the adapter, host-only by the catalog: the agent would undercount.
    expect(connectorCatalogConsistencyIssue(adapter("ashby", ["personal", "workspace"], ["ashby.personal.mcp", "ashby.workspace.events"], ["personal"])))
      .toBe("host grants ashby.workspace.events differ between the catalog's hostCapabilities and the manifest");
  });

  it("names a grant no product owns", () => {
    expect(connectorCatalogConsistencyIssue(adapter("google", ["personal", "workspace"], ["gmail.read", "photos.read"])))
      .toBe("grants photos.read belong to no catalog product");
  });
});
