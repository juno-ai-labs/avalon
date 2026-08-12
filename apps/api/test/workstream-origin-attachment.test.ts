import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SlackOriginContext } from "@avalon/contracts";
import type { AuthContext, Env } from "../src/env";
import type * as NamingService from "../src/services/workstream-naming-service";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

vi.mock("../src/services/integrations", () => ({
  classifyWorkstreamMessage: vi.fn(async () => ({
    classification: "human_only",
    confidence: 1,
    rationaleCode: "test",
  })),
  publishWorkstreamEvent: vi.fn(async () => undefined),
  startWorkstreamWorkflow: vi.fn(async () => "workflow-instance"),
}));
vi.mock("../src/services/workstream-naming-service", async (importOriginal) => ({
  ...await importOriginal<typeof NamingService>(),
  nameWorkstream: vi.fn(async () => undefined),
}));
// Nothing here asserts on addressing, and the activity path reserves an address
// through the Global registry before it writes a row.
vi.mock("../src/services/workstream-email-routing-service", () => ({
  WorkstreamEmailRoutingService: class {
    async reserve(input: { workstreamId: string }) {
      // Addresses are unique per work stream in the schema, so the fake has to
      // be too — two creates in one test otherwise collide on the column.
      return { emailAddress: `otter-${input.workstreamId}@automation.with-avalon.com` };
    }
    async activateWorkstreamRoute() {
      return undefined;
    }
    async ensureWorkstreamAddress() {
      return undefined;
    }
  },
}));

import { __testing as activityConsumerTesting } from "../src/queues/activity-consumer";
import { publishWorkstreamEvent } from "../src/services/integrations";
import { SlackWorkspaceWorkstreamService } from "../src/services/slack-workspace-workstream-service";
import { WorkstreamService } from "../src/services/workstream-service";
import {
  activityOriginResourceDescriptor,
  attachWorkstreamOriginResource,
  connectorActivityUrl,
  slackOriginResourceDescriptor,
} from "../src/services/workstream-origin-resource";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000002";
const connectionId = "00000000-0000-7000-8000-000000000003";
const strangerId = "00000000-0000-7000-8000-000000000004";
const templateId = "00000000-0000-7000-8000-000000000005";
const templateVersionId = "00000000-0000-7000-8000-000000000006";
const subscriptionId = "00000000-0000-7000-8000-000000000007";
const activityId = "00000000-0000-7000-8000-000000000008";
const opportunityId = "00000000-0000-7000-8000-000000000009";
const activityNodeId = "00000000-0000-7000-8000-00000000000a";
const messageNodeId = "00000000-0000-7000-8000-00000000000b";
const at = "2026-08-12T09:00:00.000Z";
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.clearAllMocks();
});

/**
 * The rule these tests hold: a work stream that exists because of a place in a
 * connected tool carries that place as an attachment, so the person reading the
 * work stream a week later can get back to where it started. See
 * `docs/workstream-origin-attachments.md`.
 */
describe("Slack origin descriptors", () => {
  it("keys the origin on the thread, and names the channel it is in", () => {
    const descriptor = slackOriginResourceDescriptor({
      connectionId,
      channelId: "C0A4UF9RWAU",
      threadTs: "1786491700.928349",
      origin: slackOrigin(),
      permalink: "https://avalon.slack.com/archives/C0A4UF9RWAU/p1786491700928349",
    });

    expect(descriptor).toEqual({
      connectionId,
      provider: "slack",
      resourceType: "slack_thread",
      providerResourceId: "C0A4UF9RWAU:1786491700.928349",
      title: "Thread in #operations",
      canonicalUrl: "https://avalon.slack.com/archives/C0A4UF9RWAU/p1786491700928349",
      metadata: {
        teamId: "T0A4UF9KD08",
        channelId: "C0A4UF9RWAU",
        channelName: "operations",
        threadTs: "1786491700.928349",
        channelType: "public",
        invocationType: "app_mention",
      },
      contentRef: null,
    });
  });

  it("stores no Slack message content, only where the message was", () => {
    const descriptor = slackOriginResourceDescriptor({
      connectionId,
      channelId: "C1",
      threadTs: "1.1",
      origin: slackOrigin({
        nearbyMessages: [{
          userId: "U9",
          text: "the quarterly numbers are wrong",
          timestamp: "1.0",
          attachments: [],
        }],
      }),
    });

    expect(JSON.stringify(descriptor)).not.toContain("quarterly");
  });

  it("names a direct message as one rather than as a channel nobody can open", () => {
    expect(slackOriginResourceDescriptor({
      connectionId,
      channelId: "D1",
      threadTs: "1.1",
      origin: slackOrigin({ channelType: "im", channelName: null, invocationType: "direct_message" }),
    }).title).toBe("Slack direct message");
  });

  it("falls back to an unqualified thread when Slack did not name the channel", () => {
    expect(slackOriginResourceDescriptor({
      connectionId,
      channelId: "C1",
      threadTs: "1.1",
      origin: slackOrigin({ channelName: null }),
    }).title).toBe("Slack thread");
  });

  it("keeps a null URL rather than inventing one Slack never returned", () => {
    expect(slackOriginResourceDescriptor({
      connectionId,
      channelId: "C1",
      threadTs: "1.1",
      origin: slackOrigin(),
    }).canonicalUrl).toBeNull();
  });
});

describe("connector activity origin descriptors", () => {
  it("describes the provider object an activity is about", () => {
    expect(activityOriginResourceDescriptor({
      connection_id: connectionId,
      provider: "linear",
      resource_type: "linear_issue",
      provider_resource_id: "ISS-42",
      title: "Comment on ISS-42",
      metadata_json: JSON.stringify({ url: "https://linear.app/avalon/issue/ISS-42" }),
      payload_ref: "payloads/activity.json",
    })).toEqual({
      connectionId,
      provider: "linear",
      resourceType: "linear_issue",
      providerResourceId: "ISS-42",
      title: "Comment on ISS-42",
      canonicalUrl: "https://linear.app/avalon/issue/ISS-42",
      metadata: { url: "https://linear.app/avalon/issue/ISS-42" },
      contentRef: "payloads/activity.json",
    });
  });

  it("declines an activity that names no provider object to point at", () => {
    expect(activityOriginResourceDescriptor({
      connection_id: connectionId,
      provider: "slack",
      resource_type: null,
      provider_resource_id: null,
      title: "Someone reacted",
      metadata_json: "{}",
      payload_ref: null,
    })).toBeNull();
  });

  it("takes whichever link key the provider happens to use", () => {
    expect(connectorActivityUrl(JSON.stringify({ htmlUrl: "https://github.com/a/b/pull/1" })))
      .toBe("https://github.com/a/b/pull/1");
    expect(connectorActivityUrl(JSON.stringify({ url: "not-a-link" }))).toBeNull();
    expect(connectorActivityUrl("not json at all")).toBeNull();
  });
});

describe("attaching a work stream's origin", () => {
  it("attaches the Slack thread a linked member's work stream was started from", async () => {
    const database = seededDatabase();
    const service = new WorkstreamService(environment(database), auth(), () => undefined);

    const created = await service.create({
      ...request(),
      originResource: slackOriginResourceDescriptor({
        connectionId,
        channelId: "C1",
        threadTs: "1786491700.928349",
        origin: slackOrigin(),
        permalink: "https://avalon.slack.com/archives/C1/p1786491700928349",
      }),
    });

    expect(attachments(database, created.workstream.id)).toEqual([{
      relationship_type: "origin",
      attached_by_user_id: memberId,
      watch_enabled: 0,
      resource_type: "slack_thread",
      provider: "slack",
      provider_resource_id: "C1:1786491700.928349",
      title: "Thread in #operations",
      canonical_url: "https://avalon.slack.com/archives/C1/p1786491700928349",
    }]);
  });

  it("attaches the origin before the run starts, so the agent's first read holds it", async () => {
    const database = seededDatabase();
    const service = new WorkstreamService(environment(database), auth(), () => undefined);

    const created = await service.create({
      ...request(),
      originResource: slackOriginResourceDescriptor({
        connectionId,
        channelId: "C1",
        threadTs: "1.1",
        origin: slackOrigin(),
      }),
    });

    const attached = database.prepare(
      "SELECT attached_at FROM workstream_resources WHERE workstream_id = ?",
    ).get(created.workstream.id) as { attached_at: string };
    const run = database.prepare(
      "SELECT created_at FROM harness_runs WHERE workstream_id = ?",
    ).get(created.workstream.id) as { created_at: string };
    expect(attached.attached_at <= run.created_at).toBe(true);
    // The rail is rendered off the socket, so a work stream already on a screen
    // shows its origin without refetching the detail.
    expect(vi.mocked(publishWorkstreamEvent).mock.calls.map((call) => call[3])).toContainEqual(
      expect.objectContaining({ type: "resource_attached" }),
    );
  });

  it("reuses the one resource row when a second work stream starts in the same thread", async () => {
    const database = seededDatabase();
    const environmentValue = environment(database);
    const originResource = slackOriginResourceDescriptor({
      connectionId,
      channelId: "C1",
      threadTs: "1.1",
      origin: slackOrigin(),
    });

    const first = await new WorkstreamService(environmentValue, auth(), () => undefined)
      .create({ ...request(), originResource });
    const second = await new WorkstreamService(environmentValue, auth(), () => undefined)
      .create({ ...request(), clientMessageId: "client-second", originResource });

    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM resources WHERE provider = 'slack'",
    ).get()).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM workstream_resources WHERE workstream_id IN (?, ?)",
    ).get(first.workstream.id, second.workstream.id)).toEqual({ count: 2 });
  });

  it("leaves the attachment ownerless when Slack cannot map the member to Avalon", async () => {
    const database = seededDatabase();

    const created = await new SlackWorkspaceWorkstreamService(environment(database), workspaceId).create({
      actor: {
        provider: "slack",
        providerAccountId: "T0A4UF9KD08",
        providerUserId: "U456",
        displayName: "Taylor",
        avatarUrl: null,
      },
      objective: "Investigate the alert",
      text: "Investigate the alert",
      clientMessageId: "event:opening",
      slackOrigin: slackOrigin(),
      originResource: slackOriginResourceDescriptor({
        connectionId,
        channelId: "C1",
        threadTs: "1.1",
        origin: slackOrigin(),
      }),
    });

    expect(attachments(database, created.workstream.id)).toEqual([expect.objectContaining({
      relationship_type: "origin",
      attached_by_user_id: null,
    })]);
  });

  it("does not lose the work stream when the origin cannot be written down", async () => {
    const database = seededDatabase();
    const service = new WorkstreamService(environment(database), auth(), () => undefined);

    // A connection that no longer exists fails the resource insert's foreign
    // key. The person's request still has to produce a work stream and a run.
    const created = await service.create({
      ...request(),
      originResource: slackOriginResourceDescriptor({
        connectionId: "00000000-0000-7000-8000-0000000000ff",
        channelId: "C1",
        threadTs: "1.1",
        origin: slackOrigin(),
      }),
    });

    expect(created.harnessRunId).not.toBeNull();
    expect(attachments(database, created.workstream.id)).toEqual([]);
  });

  it("skips the broadcast but keeps the row when the work stream is gone", async () => {
    const database = seededDatabase();
    const environmentValue = environment(database);
    const created = await new WorkstreamService(environmentValue, auth(), () => undefined).create(request());
    database.prepare("DELETE FROM workstreams WHERE id = ?").run(created.workstream.id);

    const attachedId = await attachWorkstreamOriginResource(environmentValue, {
      workspaceId,
      workstreamId: created.workstream.id,
      attachedByUserId: memberId,
      descriptor: slackOriginResourceDescriptor({
        connectionId,
        channelId: "C1",
        threadTs: "1.1",
        origin: slackOrigin(),
      }),
    });

    // The resource is resolved before the attachment, so the failure leaves the
    // shared row behind rather than half of one.
    expect(attachedId).toBeNull();
    expect(database.prepare("SELECT COUNT(*) AS count FROM resources").get()).toEqual({ count: 1 });
  });
});

describe("a work stream a connector activity created", () => {
  it("attaches the object an automation fired on, ownerless", async () => {
    const database = seededDatabase();
    seedActivityAutomation(database);

    await activityConsumerTesting.runMatchingAutomations(automationEnvironment(database), {
      id: activityId,
      workspace_id: workspaceId,
      workspace_region: "global",
      connection_id: connectionId,
      connection_scope: "workspace",
      connector_type: "linear",
      provider: "linear",
      event_type: "linear.issue.assigned",
      resource_type: "linear_issue",
      provider_resource_id: "ISS-42",
      title: "Assigned ISS-42",
      summary: "",
      text_snippet: "",
      metadata_json: JSON.stringify({ url: "https://linear.app/avalon/issue/ISS-42" }),
      visibility_json: "{}",
    } as never);

    const workstream = database.prepare(
      "SELECT id FROM workstreams WHERE automation_subscription_id = ?",
    ).get(subscriptionId) as { id: string };
    expect(attachments(database, workstream.id)).toEqual([{
      relationship_type: "origin",
      attached_by_user_id: null,
      watch_enabled: 0,
      resource_type: "linear_issue",
      provider: "linear",
      provider_resource_id: "ISS-42",
      title: "Assigned ISS-42",
      canonical_url: "https://linear.app/avalon/issue/ISS-42",
    }]);
  });
});

describe("a work stream started from a suggestion", () => {
  it("attaches the connector activity the suggestion was built out of", async () => {
    const database = seededDatabase();
    seedOpportunity(database);
    const service = new WorkstreamService(environment(database), auth(), () => undefined);

    const created = await service.createFromOpportunity(opportunityRequest());

    expect(attachments(database, created.workstream.id)).toEqual([expect.objectContaining({
      relationship_type: "origin",
      attached_by_user_id: memberId,
      provider: "linear",
      provider_resource_id: "ISS-42",
      canonical_url: "https://linear.app/avalon/issue/ISS-42",
    })]);
  });

  it("leaves out a source held through somebody else's personal connection", async () => {
    // A resource row is listed to everyone the work stream is, so an origin is
    // held to the same rule a manual attach is: a personal connection reaches
    // only its owner. Losing this would republish another member's private
    // connector object into a workspace-visible rail.
    const database = seededDatabase();
    seedOpportunity(database, { connectionScope: "personal", connectionOwnerUserId: strangerId });
    const service = new WorkstreamService(environment(database), auth(), () => undefined);

    const created = await service.createFromOpportunity(opportunityRequest());

    expect(attachments(database, created.workstream.id)).toEqual([]);
  });
});

function slackOrigin(overrides: Partial<SlackOriginContext> = {}): SlackOriginContext {
  return {
    teamId: "T0A4UF9KD08",
    channelId: "C0A4UF9RWAU",
    channelName: "operations",
    threadTs: "1786491700.928349",
    invocationType: "app_mention",
    channelType: "public",
    matchedAvalonUserId: null,
    nearbyMessagesStatus: "not_applicable",
    nearbyMessages: [],
    attachments: [],
    ...overrides,
  };
}

function request() {
  return {
    openingMessage: "Shut everything down in seven days",
    clientMessageId: "client-origin",
    participantUserIds: [] as string[],
    attachmentIds: [] as string[],
  };
}

function auth(): AuthContext {
  return {
    sessionId: "session-1",
    userId: memberId,
    workspaceId,
    region: "global",
    role: "owner",
  };
}

function environment(database: DatabaseSync): Env {
  return {
    DB: sqliteD1(database),
    APP_ENV: "test",
    AVALON_REGION: "global",
    LOG_LEVEL: "error",
    SESSION_SIGNING_KEY: "session-signing-key-for-workstream-origin-attachment",
    OPENROUTER_PRIMARY_MODEL: "google/gemini-2.5-flash-lite",
    OPENROUTER_CLASSIFIER_MODEL: "google/gemini-2.5-flash-lite",
    OPENROUTER_FALLBACK_MODELS: "google/gemini-3.6-flash",
  } as unknown as Env;
}

function opportunityRequest() {
  return {
    opportunityId,
    version: 1,
    displayPrompt: "Chase the assigned issue",
    executionPrompt: "Trace ISS-42 and prepare the fix.",
    displayPromptHash: "display-hash",
    executionPromptHash: "execution-hash",
    idempotencyKey: "start-the-suggestion",
  };
}

function automationEnvironment(database: DatabaseSync): Env {
  return {
    ...environment(database),
    WORKSTREAM_LOOP_WORKFLOW: { create: async () => ({ id: "instance" }) },
  } as unknown as Env;
}

/** A subscription bound to the connection the activity arrives on. */
function seedActivityAutomation(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO automation_templates
      (id, workspace_id, owner_user_id, name, description, sharing_state,
       latest_version_number, created_at, updated_at)
    VALUES ('${templateId}', '${workspaceId}', '${memberId}', 'Issue triage', 'Triage', 'private', 1, '${at}', '${at}');
    INSERT INTO automation_template_versions
      (id, template_id, version_number, instructions, trigger_definitions_json, created_by_user_id, created_at)
    VALUES ('${templateVersionId}', '${templateId}', 1, 'Triage the issue',
            '[{"type":"connector_activity","connectorType":"linear","eventTypes":["linear.issue.assigned"],"deterministicFilters":{}}]',
            '${memberId}', '${at}');
    INSERT INTO automation_subscriptions
      (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
       execution_principal_json, connector_bindings_json, status, email_address,
       email_route_status, created_at, updated_at)
    VALUES ('${subscriptionId}', '${workspaceId}', '${templateId}', '${templateVersionId}', 'workspace', NULL,
            '{"type":"workspace","workspaceId":"${workspaceId}"}',
            '{"plugin_linear":"${connectionId}"}', 'active',
            'quiet-amber-steady-heron@automation.with-avalon.com', 'active', '${at}', '${at}');
  `);
  seedActivity(database);
}

function seedActivity(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO activities
      (id, workspace_id, connection_id, connection_scope, provider, provider_event_id, event_type,
       resource_type, provider_resource_id, occurred_at, received_at, title, metadata_json, dedupe_key)
    VALUES ('${activityId}', '${workspaceId}', '${connectionId}', 'workspace', 'linear', 'event-42',
            'linear.issue.assigned', 'linear_issue', 'ISS-42', '${at}', '${at}', 'Assigned ISS-42',
            '{"url":"https://linear.app/avalon/issue/ISS-42"}', 'dedupe-42');
  `);
}

/**
 * A suggestion with two provenance roots: the connector activity behind it, and
 * an Avalon message, which names no provider object and is not an origin.
 */
function seedOpportunity(database: DatabaseSync, options: {
  connectionScope?: "personal" | "workspace";
  connectionOwnerUserId?: string;
} = {}): void {
  if (options.connectionScope === "personal") {
    database.prepare(
      `INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
       VALUES (?, 'google-stranger', 'stranger@example.com', 'Stranger', ?, ?)`,
    ).run(options.connectionOwnerUserId ?? strangerId, at, at);
    database.prepare(
      "UPDATE connector_connections SET scope = 'personal', owner_user_id = ? WHERE id = ?",
    ).run(options.connectionOwnerUserId ?? strangerId, connectionId);
  }
  database.prepare("UPDATE connector_connections SET connector_type = 'linear' WHERE id = ?").run(connectionId);
  seedActivity(database);
  database.exec(`
    INSERT INTO work_opportunities
      (id, workspace_id, audience_scope, audience_user_id, display_prompt, execution_prompt,
       admission_reasoning, source_fingerprint, display_prompt_hash, execution_prompt_hash,
       expires_at, created_at, updated_at)
    VALUES ('${opportunityId}', '${workspaceId}', 'personal', '${memberId}', 'Chase the assigned issue',
            'Trace ISS-42 and prepare the fix.', 'Assigned to them', 'fingerprint-42',
            'display-hash', 'execution-hash', '2026-08-13T09:00:00.000Z', '${at}', '${at}');
    INSERT INTO opportunity_provenance_nodes
      (id, workspace_id, node_kind, source_id, provider, label, visibility_scope, created_at)
    VALUES
      ('${activityNodeId}', '${workspaceId}', 'activity', '${activityId}', 'linear', 'Assigned ISS-42', 'workspace', '${at}'),
      ('${messageNodeId}', '${workspaceId}', 'message', NULL, NULL, 'A message', 'workspace', '${at}');
    INSERT INTO work_opportunity_provenance_roots (opportunity_id, node_id, position)
    VALUES ('${opportunityId}', '${activityNodeId}', 0), ('${opportunityId}', '${messageNodeId}', 1);
  `);
}

function attachments(database: DatabaseSync, workstreamId: string): unknown[] {
  return database.prepare(
    `SELECT wr.relationship_type, wr.attached_by_user_id, wr.watch_enabled,
            r.resource_type, r.provider, r.provider_resource_id, r.title, r.canonical_url
       FROM workstream_resources wr
       JOIN resources r ON r.id = wr.resource_id
      WHERE wr.workstream_id = ?`,
  ).all(workstreamId);
}

function seededDatabase(): DatabaseSync {
  const database = migratedSqliteDatabase();
  databases.push(database);
  database.prepare(
    `INSERT INTO users (id, google_subject, email, name, avatar_url, created_at, updated_at)
     VALUES (?, 'google-member', 'member@example.com', 'Member Person', NULL, ?, ?)`,
  ).run(memberId, at, at);
  database.prepare(
    `INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
     VALUES (?, 'Avalon Studio', 'avalon-studio', 'global', ?, ?, ?)`,
  ).run(workspaceId, memberId, at, at);
  database.prepare(
    `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
     VALUES (?, ?, 'owner', 'active', ?)`,
  ).run(workspaceId, memberId, at);
  database.prepare(
    `INSERT INTO connector_connections
       (id, workspace_id, connector_type, scope, display_name, model_plugin_id, created_at, updated_at)
     VALUES (?, ?, 'slack', 'workspace', 'Slack', 'plugin_slack', ?, ?)`,
  ).run(connectionId, workspaceId, at, at);
  return database;
}
