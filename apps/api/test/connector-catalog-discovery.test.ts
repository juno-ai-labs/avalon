import { describe, expect, it } from "vitest";

import { createConnectorRegistry } from "@rally/connectors";
import { __integrationTesting } from "../src/services/integrations";

/**
 * What a request has to say to find a connector in the plugin catalog.
 *
 * A run whose visible tool list holds no connector tools reads an empty result
 * as the capability being absent — that is the recorded failure in work stream
 * `019ff17c-d400-7770-bf56-8c943f5e8ab7`, where the run asked a person for two
 * addresses a loaded plugin could have looked up. Aliases and the load-me
 * sentence are what connect the catalog to that decision, and until this file
 * existed a regression that dropped Linear's "ticket" or Slack's "channel"
 * would have restored the failure with the whole suite green.
 */
const oauth = { clientId: "client", clientSecret: "secret", redirectUri: "https://api.example.com/callback" };
const registry = createConnectorRegistry({
  granola: { redirectUri: "https://api.example.com/callback" },
  google: oauth,
  github: {
    appId: "1",
    clientId: "Iv1.client-id",
    clientSecret: "secret",
    privateKey: `${["-----BEGIN", "PRIVATE KEY-----"].join(" ")}\nAA==\n${["-----END", "PRIVATE KEY-----"].join(" ")}`,
    webhookSecret: "webhook",
    redirectUri: "https://api.example.com/callback",
  },
  linear: oauth,
  notion: oauth,
  slack: { ...oauth, signingSecret: "signing" },
  x: { apiKey: "key" },
});

/** The connector types with a tool surface a request would go looking for. */
const TOOL_CONNECTORS = ["slack", "github", "linear", "notion", "granola", "x", "google"] as const;

/**
 * One phrase per connector that a person would plausibly use and that is not
 * the product's own name. If a connector stops matching its own row here, the
 * catalog has gone back to being reachable only by brand.
 */
const REQUEST_VOCABULARY: Record<string, string> = {
  slack: "channel",
  github: "pull request",
  linear: "ticket",
  notion: "wiki",
  granola: "meeting",
  x: "tweet",
};

function aliasesFor(type: string): string[] {
  return __integrationTesting.connectorSearchAliases(registry.get(type));
}

describe("finding a connector in the catalog", () => {
  it.each(TOOL_CONNECTORS)("gives %s aliases beyond its own name", (type) => {
    const adapter = registry.get(type);
    const aliases = aliasesFor(type);

    expect(aliases).toContain(adapter.manifest.type);
    expect(aliases).toContain(adapter.agentPlugin.wireNamePrefix);
    // The brand alone is what the recorded failure had.
    const beyondTheBrand = aliases.filter((alias) =>
      alias !== adapter.manifest.type && alias !== adapter.agentPlugin.wireNamePrefix);
    expect(beyondTheBrand.length, `${type} declares no request vocabulary`).toBeGreaterThan(3);
  });

  it.each(Object.entries(REQUEST_VOCABULARY))("finds %s from the word %s", (type, phrase) => {
    expect(aliasesFor(type)).toContain(phrase);
  });

  it("says when to load the plugin, in the line the catalog renders", () => {
    for (const type of TOOL_CONNECTORS) {
      const { description } = registry.get(type).agentPlugin;
      expect(description, `${type} never tells the model when to load it`)
        .toMatch(/Load this plugin for/u);
    }
  });

  it("keeps the declared aliases through the presentation both catalog sites use", () => {
    // Google is the one connector whose presentation is rebuilt from granted
    // scopes, so it is the one that could drop a descriptor's aliases on the
    // floor. Every other connector passes through the fallback unchanged.
    for (const type of TOOL_CONNECTORS) {
      const adapter = registry.get(type);
      const fallbackAliases = __integrationTesting.connectorSearchAliases(adapter);
      const presentation = __integrationTesting.connectorPluginPresentation(
        type,
        adapter.agentPlugin.tools.map((tool) => tool.capability),
        adapter.agentPlugin.wireNamePrefix,
        {
          displayName: adapter.manifest.displayName,
          description: adapter.agentPlugin.description,
          searchAliases: fallbackAliases,
          systemMessage: adapter.agentPlugin.systemMessage,
        },
      );

      expect(presentation.searchAliases.length, `${type} lost its aliases in presentation`)
        .toBeGreaterThan(3);
      expect(presentation.description).toMatch(/Load this plugin for/u);
      expect(presentation.systemMessage.trim()).not.toBe("");
    }
  });

  it("does not repeat a connector's own name back to it", () => {
    for (const type of TOOL_CONNECTORS) {
      const aliases = aliasesFor(type);
      expect(new Set(aliases).size, `${type} has duplicate aliases`).toBe(aliases.length);
    }
  });
});

describe("the Google presentation, which is rebuilt rather than passed through", () => {
  const google = registry.get("google");
  const present = (scopes: string[]) => __integrationTesting.connectorPluginPresentation(
    "google",
    scopes,
    "google",
    {
      displayName: google.manifest.displayName,
      description: google.agentPlugin.description,
      searchAliases: __integrationTesting.connectorSearchAliases(google),
      systemMessage: google.agentPlugin.systemMessage,
    },
  );

  it("tells a mail-and-files credential when to load it, in one sentence not two", () => {
    const { description, searchAliases } = present(["gmail.read", "drive.read", "sheets.read"]);

    // This shape used to fall to a fallback that named neither half. It then
    // briefly carried two differently worded load-me sentences, because the
    // descriptor grew its own and this branch appended another.
    expect(description.match(/Load this plugin for/gu)).toHaveLength(1);
    expect(description).toContain("email");
    expect(description).toContain("file");
    expect(searchAliases).toEqual(expect.arrayContaining(["gmail", "drive"]));
  });

  it.each([
    ["mail only", ["gmail.read"], "email"],
    ["files only", ["drive.read"], "file"],
  ])("tells a %s credential when to load it", (_label, scopes, word) => {
    const { description } = present(scopes);
    expect(description.match(/Load this plugin for/gu)).toHaveLength(1);
    expect(description).toContain(word);
  });

  it("still names the work when the credential holds no recognized scope", () => {
    // Every capability-gated branch is skipped, so what survives is the
    // descriptor — which is why the descriptor carries aliases of its own.
    const { searchAliases } = present([]);
    expect(searchAliases).toContain("email");
    expect(searchAliases).toContain("spreadsheets");
  });
});
