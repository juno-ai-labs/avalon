import { asUserId, asWorkspaceId } from "@rally/contracts";
import { ConnectorError } from "@rally/connectors";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../src/env";
import type * as IntegrationsModule from "../src/services/integrations";

const compileAutomationDraft = vi.hoisted(() => vi.fn());

vi.mock("../src/services/integrations", async (importOriginal) => ({
  ...await importOriginal<typeof IntegrationsModule>(),
  compileAutomationDraft,
}));

import { AutomationService } from "../src/services/automation-service";
import { createTestEnv } from "./helpers/cloudflare-test";

const auth: AuthContext = {
  sessionId: "session-1",
  userId: asUserId("d6d77053-92bc-4af6-8332-8bea8c4c6904"),
  workspaceId: asWorkspaceId("668953d2-25f2-44fd-8d72-1e8cf024a277"),
  region: "global",
  role: "member",
};

describe("automation compile activity-source validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("turns an unavailable model-suggested source into a follow-up draft", async () => {
    compileAutomationDraft.mockResolvedValue({
      name: "GitHub follow-up",
      description: "Respond when an issue opens.",
      overview: "Starts from new GitHub issues.",
      instructions: "Review the issue and prepare a response.",
      triggers: [{
        type: "connector_activity",
        connectorType: "github",
        sourceBindingKey: "github_source",
        suggestedSourcePluginId: "plugin_github_unhealthy",
        eventTypes: ["github.issue.opened"],
        deterministicFilters: { repository: "acme/widget" },
      }],
      requiredCapabilities: [],
      expectedOutputs: [],
      defaultBehavior: {},
      recommendedPlugins: [],
      memoryTables: [],
      suggestedScope: "personal",
      followUpQuestion: null,
      elicitation: null,
      ready: true,
    });
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        // `user_id` because the real statement selects it: a fixture that omits
        // it leaves `row.user_id` undefined rather than the null D1 returns, and
        // the existence guard would then pass for the wrong reason.
        first: vi.fn(async () => sql.includes("AS user_timezone")
          ? { user_id: "user-1", user_timezone: "America/Los_Angeles", workspace_timezone: "UTC" }
          : null),
      })),
    }));
    const batch = vi.fn(async () => []);
    const service = new AutomationService(createTestEnv({ DB: { prepare, batch } }), auth);

    const result = await service.compile({
      messages: [{ role: "user", content: "When a GitHub issue opens, prepare a response." }],
    }, "request-1");

    expect(result.draft).toMatchObject({
      ready: false,
      elicitation: null,
      followUpQuestion: expect.stringContaining("unavailable"),
    });
    // The turn is still a draft worth keeping: the source could not be bound,
    // which is the very thing the person comes back to the conversation to fix.
    expect(prepare.mock.calls.map(([sql]) => sql).join("\n")).toContain("INSERT INTO automation_subscriptions");
    expect(batch).toHaveBeenCalledOnce();
    // The zones the compiler schedules by, in the order it reads them. Swapping
    // these two is half the defect this change exists for — the model told the
    // wrong zone — and nothing else in the suite would notice.
    expect(compileAutomationDraft).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        defaultTimezones: { personal: "America/Los_Angeles", workspace: "UTC" },
      }),
    );
  });

  it("refuses a compile for somebody the workspace's region has no user row for", async () => {
    // The row's absence is the refusal, not the timezone's value: the two are
    // separate answers, and reading one off the other would turn a member whose
    // zone is unset into somebody with no workspace access.
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => sql.includes("AS user_timezone")
          ? { workspace_timezone: "UTC", user_id: null, user_timezone: null }
          : null),
      })),
    }));
    const service = new AutomationService(createTestEnv({ DB: { prepare, batch: vi.fn(async () => []) } }), auth);

    await expect(service.compile({
      messages: [{ role: "user", content: "Summarize my day." }],
    }, "request-1")).rejects.toMatchObject({ status: 403, code: "workspace_access_denied" });
    expect(compileAutomationDraft).not.toHaveBeenCalled();
  });

  // The three tests below exercise `AutomationService.compile`'s
  // `ConnectorError` → `ApiError` mapping in isolation, through a hand-built
  // error rejected out of the mocked `compileAutomationDraft`. That proves
  // the classification is correct for a given `ConnectorError` shape; it does
  // not prove any real code path actually produces that shape here. The real,
  // reachable path — a stored connection naming a `connector_type` this
  // environment does not register — is covered unmocked in
  // `automation-compile-connector-registry.test.ts`.
  function connectorPrepare() {
    return vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => sql.includes("AS user_timezone")
          ? { user_id: "user-1", user_timezone: "America/Los_Angeles", workspace_timezone: "UTC" }
          : null),
      })),
    }));
  }

  it("maps a bare ConnectorError to a non-retryable, non-reconnect typed error", async () => {
    compileAutomationDraft.mockRejectedValue(
      new ConnectorError("unsupported_capability", "Connector is unavailable: slack"),
    );
    const service = new AutomationService(
      createTestEnv({ DB: { prepare: connectorPrepare(), batch: vi.fn(async () => []) } }),
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

  it("does not treat a bare 'unauthorized' code alone as reconnect-required", async () => {
    // Matches the code `isReconnectRequiredConnectorError` also checks, but
    // omits the `reconnectRequired` detail that function additionally
    // requires — so this must NOT get the reconnect message. Guards against
    // a future edit that reads only `error.code` again.
    compileAutomationDraft.mockRejectedValue(
      new ConnectorError("unauthorized", "Connector capability was revoked"),
    );
    const service = new AutomationService(
      createTestEnv({ DB: { prepare: connectorPrepare(), batch: vi.fn(async () => []) } }),
      auth,
    );

    await expect(service.compile({
      messages: [{ role: "user", content: "Check my Slack for anything unresolved." }],
    }, "request-1")).rejects.toMatchObject({
      status: 502,
      code: "automation_connector_failed",
      message: expect.not.stringContaining("Reconnect"),
      details: { connectorErrorCode: "unauthorized", retryable: false },
    });
  });

  it("marks the exact reconnect-required ConnectorError shape as needing reconnection", async () => {
    // The shape `withAuthorizedConnection` (connector-connection-access.ts)
    // actually throws — `isReconnectRequiredConnectorError` requires both the
    // code and this detail.
    compileAutomationDraft.mockRejectedValue(
      new ConnectorError("unauthorized", "This connector connection needs reconnecting", {
        reconnectRequired: true,
        reason: "revoked",
      }),
    );
    const service = new AutomationService(
      createTestEnv({ DB: { prepare: connectorPrepare(), batch: vi.fn(async () => []) } }),
      auth,
    );

    await expect(service.compile({
      messages: [{ role: "user", content: "Check my Slack for anything unresolved." }],
    }, "request-1")).rejects.toMatchObject({
      status: 502,
      code: "automation_connector_failed",
      message: expect.stringContaining("Reconnect"),
      details: { connectorErrorCode: "unauthorized", retryable: false },
    });
  });
});
