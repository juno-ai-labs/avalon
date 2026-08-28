/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { asWorkspaceId } from "@rally/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000009a0");
const CONNECTION_ID = "00000000-0000-7000-8000-0000000009a1";
const AUTOMATION_ID = "00000000-0000-7000-8000-0000000009a2";
const RESOURCE_ID = "00000000-0000-7000-8000-0000000009a3";
const WORKSTREAM_ONE = "00000000-0000-7000-8000-0000000009a4";
const WORKSTREAM_TWO = "00000000-0000-7000-8000-0000000009a5";

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

beforeEach(async () => {
  await reset();
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
});

describe("typed external-event destination routing", () => {
  it("uses one accepted event and one matcher for an automation and two watched work streams", async () => {
    await runInDurableObject(workspace(), async (_instance: WorkspaceDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO connector_connections
           (id, workspace_id, connector_type, scope, owner_user_id, display_name,
            status, config_json, created_at, updated_at, model_plugin_id)
         VALUES (?, ?, 'slack', 'workspace', NULL, 'Slack', 'healthy', '{}', ?, ?, ?)`,
        CONNECTION_ID,
        WORKSPACE_ID,
        "2026-08-28T09:00:00.000Z",
        "2026-08-28T09:00:00.000Z",
        "plugin_slack",
      );
      state.storage.sql.exec(
        `INSERT INTO resources
           (id, workspace_id, connection_id, resource_type, provider,
            provider_resource_id, title, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, 'slack_channel', 'slack', 'C123', 'Channel', '{}', ?, ?)`,
        RESOURCE_ID,
        WORKSPACE_ID,
        CONNECTION_ID,
        "2026-08-28T09:00:00.000Z",
        "2026-08-28T09:00:00.000Z",
      );
    });
    const destinations = [
      { kind: "automation" as const, automationId: AUTOMATION_ID },
      {
        kind: "workstream_resource_update" as const,
        workstreamId: WORKSTREAM_ONE,
        substreamId: "0" as const,
        resourceId: RESOURCE_ID,
      },
      {
        kind: "workstream_resource_update" as const,
        workstreamId: WORKSTREAM_TWO,
        substreamId: "0" as const,
        resourceId: RESOURCE_ID,
      },
    ];
    for (const [index, destination] of destinations.entries()) {
      await workspace().applyExternalEventRegistrations({
        schemaVersion: 1,
        workspaceId: WORKSPACE_ID,
        destination,
        authorityGeneration: 1,
        projectionVersion: 1,
        sourceHash: `sha256:${String(index).repeat(64)}`,
        evaluators: [{
          evaluatorId: `00000000-0000-7000-8000-0000000009b${index}`,
          source: {
            connectorType: "slack",
            connectionId: CONNECTION_ID,
            eventType: "slack.message.posted",
            resourceId: RESOURCE_ID,
          },
          when: { kind: "always" },
        }],
      });
    }
    const eventId = "00000000-0000-7000-8000-0000000009c0";
    await workspace().ingestConnectorEvent({
      workspaceId: WORKSPACE_ID,
      ingressEventId: eventId,
      payloadHash: `sha256:${"a".repeat(64)}`,
      event: {
        connectorType: "slack",
        activity: {
          id: eventId,
          workspaceId: WORKSPACE_ID,
          region: "global",
          connectionId: CONNECTION_ID,
          connectionScope: "workspace",
          connectionOwnerUserId: null,
          provider: "slack",
          providerEventId: "event-1",
          eventType: "slack.message.posted",
          resourceType: "slack_channel",
          providerResourceId: "C123",
          actor: {},
          subject: {},
          occurredAt: "2026-08-28T09:00:00.000Z",
          receivedAt: "2026-08-28T09:00:01.000Z",
          title: "New message",
          summary: "A channel message arrived",
          textSnippet: "foobar",
          payloadRef: null,
          visibility: { kind: "workspace" },
          targetUserIds: [],
          entityKeys: [],
          dedupeKey: "slack:event-1",
          rawContentHash: null,
          metadata: { messageText: "foobar" },
          externalPeople: [],
        },
      },
    });

    const matched = await workspace().matchExternalEventDestinations({
      workspaceId: WORKSPACE_ID,
      eventId,
    });

    expect(matched.deliveries).toHaveLength(3);
    expect(matched.deliveries.every((delivery: Record<string, unknown>) => (
      Object.keys(delivery).sort().join(",")
        === "deliveryId,payloadHash,region,schemaVersion,type,workspaceEventId,workspaceId"
    ))).toBe(true);
    expect((await workspace().matchExternalEventDestinations({
      workspaceId: WORKSPACE_ID,
      eventId,
    })).deliveries).toHaveLength(3);
  });
});
