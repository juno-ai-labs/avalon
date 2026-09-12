import { TELEMETRY_CONNECTOR_TYPES } from "@rally/contracts";
import { createConnectorRegistry, type ConnectorRegistry } from "@rally/connectors";

/**
 * One fully-configured connector registry for the tests that walk every
 * connector tool.
 *
 * `createConnectorRegistry` adds an adapter only when its config key is
 * present, so this object is load-bearing rather than boilerplate: a connector
 * added later without a key here is silently absent from every walk built on
 * it, and a lower-bound count will not notice one connector's worth of tools
 * going missing. `assertEveryConnectorConfigured` closes that by checking the
 * constructed registry against the canonical type list, so a new connector
 * fails these tests until it is wired in here.
 *
 * It lives in one place because both callers need the identical set; keeping
 * two copies made a new connector a two-file edit, and the second file is the
 * one people forget.
 */
const oauth = { clientId: "client", clientSecret: "secret", redirectUri: "https://api.example.com/callback" };

export const testRegistryConfig: Parameters<typeof createConnectorRegistry>[0] = {
  customMcp: { redirectUri: "https://api.example.com/callback" },
  ashby: { redirectUri: "https://api.example.com/callback" },
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
};

export function createTestConnectorRegistry(): ConnectorRegistry {
  return createConnectorRegistry(testRegistryConfig);
}

/** Connector types the canonical list names but this registry did not build. */
export function unconfiguredConnectorTypes(registry: ConnectorRegistry): string[] {
  const built = new Set(registry.list().map((manifest) => manifest.type));
  return TELEMETRY_CONNECTOR_TYPES.filter((type) => !built.has(type));
}
