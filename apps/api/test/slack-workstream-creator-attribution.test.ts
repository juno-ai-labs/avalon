import { asUserId, asWorkspaceId } from "@avalon/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { SlackWorkspaceWorkstreamService } from "../src/services/slack-workspace-workstream-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import {
  openWorkstreamAuthorityForTest,
  testSubstreamAgentsBinding,
  workstreamObjectGet,
  workstreamObjectRootRow,
  workstreamObjectParticipantRows,
} from "./helpers/durable-authority";

vi.mock("../src/services/workstream-email-routing-service", () => ({
  WorkstreamEmailRoutingService: class {
    async reserve() {
      return { emailAddress: "calm-bright-gentle-otter@automation.with-avalon.com" };
    }
    async activateWorkstreamRoute() {
      return undefined;
    }
  },
}));
vi.mock("../src/services/integrations", () => ({
  publishWorkstreamEvent: vi.fn(async () => undefined),
}));
vi.mock("../src/services/workstream-service", () => ({
  launchWorkstreamHarness: vi.fn(async () => "harness-run"),
}));

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("Slack work stream creator attribution", () => {
  const slackOrigin = {
    teamId: "T123",
    channelId: "C123",
    channelName: "general",
    threadTs: "123.456",
    invocationType: "app_mention" as const,
    channelType: "public" as const,
    matchedAvalonUserId: "a0000000-0000-4000-8000-000000000a10",
    nearbyMessagesStatus: "available" as const,
    nearbyMessages: [],
    attachments: [],
  };
  const actor = {
    provider: "slack" as const,
    providerAccountId: "T123",
    providerUserId: "U456",
    displayName: "Taylor",
    avatarUrl: null,
  };

  it("credits the mapped Avalon member who started the task from Slack", async () => {
    const database = seededDatabase();
    const objectStores = new Map<string, DatabaseSync>();
    const env = createTestEnv({
      DB: sqliteD1(database),
      SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
      AVALON_REGION: "global",
    });

    const created = await new SlackWorkspaceWorkstreamService(env, asWorkspaceId("b0000000-0000-4000-8000-000000000b10")).create({
      actor,
      title: "Investigate the alert",
      objective: "Investigate the alert",
      text: "Investigate the alert",
      clientMessageId: "event:opening",
      creatorUserId: asUserId("a0000000-0000-4000-8000-000000000a10"),
      slackOrigin,
    });

    expect(created.workstream.createdByUserId).toBe("a0000000-0000-4000-8000-000000000a10");
    const objectStore = objectStores.get(created.workstream.id);
    if (!objectStore) throw new Error("expected the creation to open the work-stream object");
    databases.push(objectStore);
    expect(workstreamObjectRootRow(objectStore, "created_by_user_id"))
      .toEqual({ created_by_user_id: "a0000000-0000-4000-8000-000000000a10" });
    expect(workstreamObjectParticipantRows(objectStore, "user_id, participation_reason"))
      .toEqual([{
        user_id: "a0000000-0000-4000-8000-000000000a10",
        participation_reason: "creator",
      }]);
    // Attribution never rewrites authorship: the opening message stays the
    // external Slack member's, so the audit trail keeps the provider identity.
    // The object encodes that authorship as `external` + the actor's json —
    // its parts table refuses the legacy `system` + actor-json shape.
    expect(workstreamObjectGet(
      objectStore,
      "SELECT author_type, author_user_id, external_actor_json FROM messages WHERE workstream_id = ?",
      created.workstream.id,
    )).toMatchObject({
      author_type: "external",
      author_user_id: null,
      external_actor_json: JSON.stringify(actor),
    });
    expect(JSON.parse(String((database.prepare(
      "SELECT envelope_json FROM telemetry_accepted_events WHERE event_id = ?",
    ).get(created.workstream.id) as { envelope_json: string }).envelope_json))).toMatchObject({
      name: "workstream_created",
      identityScope: "workspace-user",
      properties: {
        creationSource: "slack_agent",
        connectorType: "slack",
        connectorTypes: ["slack"],
      },
    });
  });

  it("leaves the task ownerless when Slack cannot map the member to Avalon", async () => {
    const database = seededDatabase();
    const objectStores = new Map<string, DatabaseSync>();
    const env = createTestEnv({
      DB: sqliteD1(database),
      SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
      AVALON_REGION: "global",
    });

    const created = await new SlackWorkspaceWorkstreamService(env, asWorkspaceId("b0000000-0000-4000-8000-000000000b10")).create({
      actor,
      title: "Investigate the alert",
      objective: "Investigate the alert",
      text: "Investigate the alert",
      clientMessageId: "event:opening",
      slackOrigin: { ...slackOrigin, matchedAvalonUserId: null },
    });

    expect(created.workstream.createdByUserId).toBeNull();
    const objectStore = objectStores.get(created.workstream.id);
    if (!objectStore) throw new Error("expected the creation to open the work-stream object");
    databases.push(objectStore);
    expect(workstreamObjectParticipantRows(objectStore)).toEqual([]);
    expect(JSON.parse(String((database.prepare(
      "SELECT envelope_json FROM telemetry_accepted_events WHERE event_id = ?",
    ).get(created.workstream.id) as { envelope_json: string }).envelope_json))).toMatchObject({
      name: "workstream_created",
      identityScope: "workspace",
      properties: { creationSource: "slack_agent", connectorType: "slack" },
    });
  });
});

function seededDatabase(): DatabaseSync {
  const database = preRetirementProductSqliteDatabase();
  databases.push(database);
  // Creation routes its product writes to the work stream's object; the
  // pre-cutover direct-to-D1 arm no longer exists.
  openWorkstreamAuthorityForTest(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES
      ('user-owner', 'google-owner', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01'),
      ('a0000000-0000-4000-8000-000000000a10', 'google-taylor', 'taylor@example.com', 'Taylor', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces
      (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('b0000000-0000-4000-8000-000000000b10', 'Slack Workspace', 'slack-workspace', 'global', 'user-owner',
            '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES
      ('b0000000-0000-4000-8000-000000000b10', 'user-owner', 'owner', 'active', '2026-01-01'),
      ('b0000000-0000-4000-8000-000000000b10', 'a0000000-0000-4000-8000-000000000a10', 'member', 'active', '2026-01-01');
  `);
  return database;
}
