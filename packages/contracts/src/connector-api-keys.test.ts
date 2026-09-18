import { describe, expect, it } from "vitest";
import {
  ConnectorApiKeyGuidanceCatalog,
  ConnectorApiKeyProviders,
  connectorApiKeyAcceptable,
  connectorApiKeyMismatch,
  isConnectorApiKeyProvider,
} from "./connector-api-keys";

describe("connector API key guidance", () => {
  it("covers every provider that asks somebody to paste a key", () => {
    expect(Object.keys(ConnectorApiKeyGuidanceCatalog).sort()).toEqual([...ConnectorApiKeyProviders].sort());
  });

  it("points every provider at an https page", () => {
    for (const guidance of Object.values(ConnectorApiKeyGuidanceCatalog)) {
      expect(guidance.issuingUrl.startsWith("https://")).toBe(true);
      expect(guidance.issuingLabel.length).toBeGreaterThan(0);
    }
  });

  it("declares a format only where the provider documents one", () => {
    // Ashby's authentication page shows a key as a basic-auth username and
    // Fireflies' authorization page describes only the header, so a prefix for
    // either would be invented — and would reject a valid key.
    expect(ConnectorApiKeyGuidanceCatalog.ashby.format).toBeNull();
    expect(ConnectorApiKeyGuidanceCatalog.fireflies.format).toBeNull();
    expect(ConnectorApiKeyGuidanceCatalog.granola.format).not.toBeNull();
  });

  it("declares every pattern anchored, and neither global nor sticky", () => {
    // One `RegExp` instance is `.test()`-ed from the Worker's request schema,
    // from the adapter, and from the renderer on every change. A `g` or `y`
    // flag makes `lastIndex` persist between those calls, so the same valid key
    // would alternate accepted and rejected across all three. An unanchored
    // pattern would accept a key with junk around it in the same three places.
    for (const guidance of Object.values(ConnectorApiKeyGuidanceCatalog)) {
      if (!guidance.format) continue;
      expect(guidance.format.pattern.global).toBe(false);
      expect(guidance.format.pattern.sticky).toBe(false);
      expect(guidance.format.pattern.source.startsWith("^")).toBe(true);
      expect(guidance.format.pattern.source.endsWith("$")).toBe(true);
    }
  });

  it("holds its verdict across repeated calls with the same key", () => {
    const key = `grn_${"a".repeat(24)}`;
    expect([1, 2, 3].map(() => connectorApiKeyAcceptable("granola", key))).toEqual([true, true, true]);
  });

  it("names the provider's shape when a paste cannot be its key", () => {
    const mismatch = connectorApiKeyMismatch("granola", "sk-live-not-a-granola-key");
    expect(mismatch).toContain("grn_");
    expect(connectorApiKeyMismatch("granola", ` grn_${"a".repeat(24)} `)).toBeNull();
  });

  it("says nothing about an empty field or a provider with no documented format", () => {
    expect(connectorApiKeyMismatch("granola", "   ")).toBeNull();
    expect(connectorApiKeyMismatch("fireflies", "anything at all")).toBeNull();
  });

  it("refuses an empty paste for every provider and a malformed one only where a format exists", () => {
    expect(connectorApiKeyAcceptable("fireflies", "  ")).toBe(false);
    expect(connectorApiKeyAcceptable("fireflies", "opaque-key")).toBe(true);
    expect(connectorApiKeyAcceptable("granola", "opaque-key")).toBe(false);
    expect(connectorApiKeyAcceptable("granola", `grn_${"a".repeat(24)}`)).toBe(true);
  });

  it("rejects a key that only contains the prefix, or that carries whitespace inside it", () => {
    expect(connectorApiKeyAcceptable("granola", "grn_")).toBe(false);
    expect(connectorApiKeyAcceptable("granola", "grn_abc def")).toBe(false);
  });

  it("recognizes the providers that take a key and no others", () => {
    expect(isConnectorApiKeyProvider("granola")).toBe(true);
    expect(isConnectorApiKeyProvider("slack")).toBe(false);
  });
});
