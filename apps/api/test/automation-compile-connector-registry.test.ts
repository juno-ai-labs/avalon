import { asUserId, asWorkspaceId } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../src/env";
import { AutomationService } from "../src/services/automation-service";
import { createTestEnv } from "./helpers/cloudflare-test";

const auth: AuthContext = {
  sessionId: "session-1",
  userId: asUserId("d6d77053-92bc-4af6-8332-8bea8c4c6904"),
  workspaceId: asWorkspaceId("668953d2-25f2-44fd-8d72-1e8cf024a277"),
  region: "global",
  role: "member",
};

/**
 * Unlike `automation-compile-source-validation.test.ts`, this file does not
 * mock `../src/services/integrations` — `compileAutomationDraft` runs for
 * real, so this exercises the actual `loadAutomationCreatorPluginCatalog` /
 * `ConnectorRegistry` path a `ConnectorError` has to survive to reach
 * `AutomationService.compile`'s catch block, rather than a hand-built error
 * injected at the mock boundary.
 */
describe("automation compile against the real connector registry", () => {
  it("surfaces a stored connection's unregistered connector_type as a typed, non-retryable error", async () => {
    // No SLACK_CLIENT_ID/SECRET on this env, so slackConnectorConfig(env)
    // returns null and the registry never registers "slack" — registry.get
    // throws before compileAutomationDraft ever reaches a model call, which
    // is what lets this test run without OPENROUTER_API_KEY.
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => sql.includes("AS user_timezone")
          ? { user_id: "user-1", user_timezone: "America/Los_Angeles", workspace_timezone: "UTC" }
          : null),
        all: vi.fn(async () => sql.includes("FROM connector_connections")
          ? {
              results: [{
                id: "connection-1",
                workspace_id: auth.workspaceId,
                owner_user_id: auth.userId,
                scope: "personal",
                status: "healthy",
                connector_type: "slack",
                model_plugin_id: "plugin_slack_1",
                granted_scopes_json: JSON.stringify(["slack.read"]),
                created_at: "2026-08-25T00:00:00.000Z",
              }],
            }
          : { results: [] }),
      })),
    }));
    const service = new AutomationService(
      createTestEnv({ DB: { prepare, batch: vi.fn(async () => []) }, PUBLIC_API_BASE_URL: "https://api.rallywith.ai" }),
      auth,
    );

    await expect(service.compile({
      messages: [{ role: "user", content: "Check my Slack for anything unresolved." }],
    }, "request-1")).rejects.toMatchObject({
      status: 502,
      code: "automation_connector_failed",
      details: { connectorErrorCode: "unsupported_capability", retryable: false },
    });
  });
});
