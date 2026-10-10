import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { connectorRegistryForEnv, googleConnectorConfig } from "../src/lib/connector-registry";
import { createTestEnv } from "./helpers/cloudflare-test";

function env(overrides: Partial<Env> = {}): Env {
  return createTestEnv({
    PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
    GOOGLE_OAUTH_CLIENT_ID: "login-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "login-secret",
    ...overrides,
  });
}

describe("separate Google OAuth clients", () => {
  it("does not expose Google connectors when only platform login is configured", () => {
    expect(googleConnectorConfig(env())).toBeNull();
    expect(connectorRegistryForEnv(env()).list().map((manifest) => manifest.type)).not.toContain("google");
  });

  it("uses only the connector client for regional Google service consent", () => {
    const input = env({
      GOOGLE_CONNECTOR_OAUTH_CLIENT_ID: "connector-client",
      GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET: "connector-secret",
    });

    expect(googleConnectorConfig(input)).toEqual({
      clientId: "connector-client",
      clientSecret: "connector-secret",
      redirectUri: "https://api.with-avalon.com/connections/google/callback",
    });
    expect(connectorRegistryForEnv(input).list().map((manifest) => manifest.type)).toContain("google");
  });

  it("keeps connector registration unavailable when either connector secret is missing", () => {
    expect(googleConnectorConfig(env({ GOOGLE_CONNECTOR_OAUTH_CLIENT_ID: "connector-client" }))).toBeNull();
    expect(googleConnectorConfig(env({ GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET: "connector-secret" }))).toBeNull();
  });
});
