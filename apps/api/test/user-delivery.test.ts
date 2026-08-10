import { describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { declaredUserDeliveryTargetType, resolveUserDelivery } from "../src/services/user-delivery";

function environment(linkedConnectionIds: string[] = []): { env: Env; prepare: ReturnType<typeof vi.fn> } {
  const prepare = vi.fn(() => ({
    bind: () => ({
      all: async () => ({ results: linkedConnectionIds.map((id) => ({ connection_id: id })) }),
    }),
  }));
  return {
    prepare,
    env: {
      APP_ENV: "test",
      AVALON_REGION: "global",
      DB: { prepare },
      PUBLIC_API_BASE_URL: "https://api.example.com",
      SLACK_CLIENT_ID: "slack-client",
      SLACK_CLIENT_SECRET: "slack-secret",
      SLACK_SIGNING_SECRET: "slack-signing",
    } as unknown as Env,
  };
}

const identity = { workspaceId: "workspace-1", userId: "user-1" };

describe("connector-declared user delivery", () => {
  it("reads the delivery surface from the connector manifest", () => {
    const { env } = environment();

    expect(declaredUserDeliveryTargetType(env, "slack")).toBe("slack_agent_dm");
    expect(declaredUserDeliveryTargetType(env, "github")).toBeNull();
    expect(declaredUserDeliveryTargetType(env, "not_a_connector")).toBeNull();
  });

  it("offers a workspace installation only once the user has linked their identity", async () => {
    const { env } = environment(["connection-slack-linked"]);

    const resolved = await resolveUserDelivery(env, identity, [
      { id: "connection-slack-linked", connector_type: "slack", status: "healthy" },
      { id: "connection-slack-unlinked", connector_type: "slack", status: "healthy" },
    ]);

    expect(resolved.get("connection-slack-linked")).toEqual({
      targetType: "slack_agent_dm",
      label: "Slack DM",
      description: "Avalon Agent DM in this Slack workspace.",
    });
    expect(resolved.has("connection-slack-unlinked")).toBe(false);
  });

  it("leaves out unhealthy connections and connectors that declare no delivery", async () => {
    const { env } = environment(["connection-slack-reconnect"]);

    const resolved = await resolveUserDelivery(env, identity, [
      { id: "connection-slack-reconnect", connector_type: "slack", status: "needs_reconnect" },
      { id: "connection-github", connector_type: "github", status: "healthy" },
    ]);

    expect(resolved.size).toBe(0);
  });

  it("does not query identity links when no connection declares delivery", async () => {
    const { env, prepare } = environment();

    const resolved = await resolveUserDelivery(env, identity, [
      { id: "connection-github", connector_type: "github", status: "healthy" },
    ]);

    expect(resolved.size).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
  });
});
