import { describe, expect, it } from "vitest";

import {
  TERMINAL_NETWORK_BASELINE,
  TerminalNetworkPolicyError,
  compileTerminalNetworkPolicy,
} from "../src/services/terminal/network-policy";

describe("Terminal network policy compiler", () => {
  it("expands the immutable reviewed groups and normalizes workspace additions", () => {
    const compiled = compileTerminalNetworkPolicy("trusted_only", [
      "API.Example.com.",
      "*.bücher.example",
      "github.com",
    ]);

    expect(TERMINAL_NETWORK_BASELINE.map((group) => group.label)).toEqual([
      "GitHub and Rally",
      "System packages",
      "Python packages",
      "JavaScript packages",
    ]);
    expect(compiled.customDomains).toEqual(["*.xn--bcher-kva.example", "api.example.com"]);
    expect(compiled.effectiveDomains).toEqual([
      ...new Set(TERMINAL_NETWORK_BASELINE.flatMap((group) => group.domains)),
      "*.xn--bcher-kva.example",
      "api.example.com",
    ].sort());
    expect(compiled.reservedSlots).toBe(new Set(TERMINAL_NETWORK_BASELINE.flatMap((group) => group.domains)).size);
    expect(compiled.remainingCustomSlots).toBe(20 - compiled.effectiveDomains.length);
  });

  it("clears the provider allow-list in Full internet mode without discarding saved additions", () => {
    expect(compileTerminalNetworkPolicy("full_internet", ["api.example.com"])).toMatchObject({
      mode: "full_internet",
      customDomains: ["api.example.com"],
      effectiveDomains: [],
    });
  });

  it.each([
    "https://example.com",
    "example.com/path",
    "user@example.com",
    "example.com:443",
    "127.0.0.1",
    "*.com",
    "*.*.example.com",
    "",
  ])("rejects a non-domain policy target: %s", (domain) => {
    expect(() => compileTerminalNetworkPolicy("trusted_only", [domain])).toThrow(TerminalNetworkPolicyError);
  });

  it("fails before the provider boundary when effective targets exceed Daytona's 20 slots", () => {
    const additions = Array.from({ length: 20 }, (_, index) => `host-${index}.example.com`);
    expect(() => compileTerminalNetworkPolicy("trusted_only", additions)).toThrow(/20/u);
  });
});
