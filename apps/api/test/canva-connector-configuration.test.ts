import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { canvaConnectorConfig, connectorRegistryForEnv } from "../src/lib/connector-registry";
import { createTestEnv } from "./helpers/cloudflare-test";
function env(overrides: Partial<Env> = {}): Env { return createTestEnv({ PUBLIC_API_BASE_URL: "https://api.rallywith.ai", ...overrides }); }
describe("Canva connector regional gate", () => {
  it("keeps Canva absent unless the gate is exactly true", () => { expect(canvaConnectorConfig(env())).toBeNull(); expect(canvaConnectorConfig(env({ CANVA_CONNECTOR_ENABLED: "false" }))).toBeNull(); expect(connectorRegistryForEnv(env()).list().map(m => m.type)).not.toContain("canva"); });
  it("registers the regional server callback when enabled", () => { const input = env({ CANVA_CONNECTOR_ENABLED: "true" }); expect(canvaConnectorConfig(input)).toEqual({ redirectUri: "https://api.rallywith.ai/connections/canva/callback" }); expect(connectorRegistryForEnv(input).list().map(m => m.type)).toContain("canva"); });
});
