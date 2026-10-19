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

/**
 * Every configurable connector, required by type.
 *
 * `Required<Omit<…, "observer" | "documents">>` is the guarantee: a connector added to
 * `createConnectorRegistry`'s input fails to compile here until this object
 * supplies it, so it cannot go missing from the walks below by being silently
 * unbuilt. `generic_webhook` is absent because it takes no config and is added
 * unconditionally, so it is never at risk of being skipped. `observer` and
 * `documents` are omitted because they are capabilities handed to adapters,
 * not connectors.
 *
 * The runtime check in `unconfiguredConnectorTypes` stays, but it is the weaker
 * of the two and catches a different miss — a connector on the telemetry list
 * that this fixture builds under a different key. It cannot be the coverage
 * oracle for this file: telemetry is a separate vocabulary answering a separate
 * question, and a connector omitted from both it and this object would be
 * invisible to it.
 */
export const testRegistryConfig: Required<
  Omit<NonNullable<Parameters<typeof createConnectorRegistry>[0]>, "observer" | "documents">
> = {
  customMcp: { redirectUri: "https://api.example.com/callback" },
  apollo: { redirectUri: "https://api.example.com/connections/apollo/callback" },
  ashby: { redirectUri: "https://api.example.com/callback" },
  canva: { redirectUri: "https://api.example.com/connections/canva/callback" },
  fireflies: { redirectUri: "https://api.example.com/callback" },
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
