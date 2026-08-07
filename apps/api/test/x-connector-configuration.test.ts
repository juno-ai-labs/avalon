import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { connectorRegistryForEnv, xConnectorConfig } from "../src/lib/connector-registry";

function env(overrides: Partial<Env> = {}): Env {
  return {
    PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
    GOOGLE_OAUTH_CLIENT_ID: "login-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "login-secret",
    ...overrides,
  } as Env;
}

describe("X connector configuration", () => {
  it("keeps the connector unavailable without an API key", () => {
    expect(xConnectorConfig(env())).toBeNull();
    expect(xConnectorConfig(env({ X_API_KEY: "   " }))).toBeNull();
    expect(connectorRegistryForEnv(env()).list().map((manifest) => manifest.type)).not.toContain("x");
  });

  it("registers the complete X read surface when configured", () => {
    const input = env({ X_API_KEY: "  x-api-key  " });
    expect(xConnectorConfig(input)).toEqual({ apiKey: "x-api-key" });
    expect(connectorRegistryForEnv(input).get("x").manifest.tools.map((tool) => tool.name)).toEqual([
      "get_user_timeline",
      "get_tweet_thread_context",
      "get_tweet_replies_v2",
      "list_timeline",
    ]);
  });
});
