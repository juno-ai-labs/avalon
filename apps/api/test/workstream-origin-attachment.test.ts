import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SlackOriginContext } from "@avalon/contracts";
import type { AuthContext, Env } from "../src/env";
import type * as NamingService from "../src/services/workstream-naming-service";
import { authorizedConnection, type AuthorizedConnectorConnection } from "@avalon/connectors";
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
  attachWorkstreamOriginResource,
  describeWorkstreamOrigin,
  type OriginResourceDescriptor,
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
  vi.unstubAllGlobals();
});

/**
 * The rule these tests hold: a work stream that exists because of a place in a
 * connected tool carries that place as an attachment, so the person reading the
 * work stream a week later can get back to where it started. See
 * `docs/workstream-origin-attachments.md`.
 */
describe("attaching a work stream's origin", () => {
  it("attaches the Slack thread a linked member's work stream was started from", async () => {
    const database = seededDatabase();

    const environmentValue = environment(database);
    const service = new WorkstreamService(environmentValue, auth(), () => undefined);
    // The permalink is the Slack adapter's own call, made under the credential
    // door; stubbing the provider is what proves the chain reaches it.
    vi.stubGlobal("fetch", async () => new Response(
      JSON.stringify({ ok: true, permalink: "https://avalon.slack.com/archives/C1/p1786491700928349" }),
      { headers: { "content-type": "application/json" } },
    ));

    const created = await service.create({
      ...request(),
      originResource: await slackOrigin(environmentValue, {
        threadTs: "1786491700.928349",
        connection: slackConnection(),
      }),
    });

    expect(attachments(database, created.workstream.id)).toEqual([{
      relationship_type: "origin",
      attached_by_user_id: memberId,
      watch_enabled: 0,
      resource_type: "slack_thread",
      provider: "slack",
      provider_resource_id: "C1:thread:1786491700.928349",
      title: "Thread in #operations",
      canonical_url: "https://avalon.slack.com/archives/C1/p1786491700928349",
    }]);
  });

  it("attaches the origin before the run starts, so the agent's first read holds it", async () => {
    const database = seededDatabase();
    const service = new WorkstreamService(environment(database), auth(), () => undefined);

    const created = await service.create({
      ...request(),
      originResource: await slackOrigin(environment(database)),
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
    const originResource = await slackOrigin(environmentValue);

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
      slackOrigin: slackOriginContext(),
      originResource: await slackOrigin(environment(database)),
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
      originResource: await slackOrigin(environment(database), {
        connectionId: "00000000-0000-7000-8000-0000000000ff",
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
      descriptor: await slackOrigin(environmentValue),
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

    await activityConsumerTesting.runMatchingAutomations(
      automationEnvironment(database),
      linearActivityRow() as never,
    );

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

  it("attaches the origin on a redelivery that finds the run already created", async () => {
    // A queue invocation killed after the D1 batch commits leaves the run
    // durable and the origin missing. The redelivery takes the existing-run
    // branch, and if the attachment only lived on the create path the Workflow
    // would launch permanently without it.
    const database = seededDatabase();
    seedActivityAutomation(database);
    const env = automationEnvironment(database);
    await activityConsumerTesting.runMatchingAutomations(env, linearActivityRow() as never);
    const workstream = database.prepare(
      "SELECT id FROM workstreams WHERE automation_subscription_id = ?",
    ).get(subscriptionId) as { id: string };
    database.prepare("DELETE FROM workstream_resources WHERE workstream_id = ?").run(workstream.id);

    await activityConsumerTesting.runMatchingAutomations(env, linearActivityRow() as never);

    expect(attachments(database, workstream.id)).toEqual([expect.objectContaining({
      relationship_type: "origin",
      provider_resource_id: "ISS-42",
    })]);
  });

  it("still records the object when that connector is not configured in this region", async () => {
    // A registry that cannot be built is one absent credential taking every
    // connector down with it. An activity needs no adapter to be described, so
    // the base derivation keeps the provenance rather than losing it to a
    // signing secret that was never set here.
    const database = seededDatabase();
    seedActivityAutomation(database);
    const env = {
      ...automationEnvironment(database),
      LINEAR_OAUTH_CLIENT_ID: undefined,
      LINEAR_OAUTH_CLIENT_SECRET: undefined,
    } as unknown as Env;

    await activityConsumerTesting.runMatchingAutomations(env, linearActivityRow() as never);

    const workstream = database.prepare(
      "SELECT id FROM workstreams WHERE automation_subscription_id = ?",
    ).get(subscriptionId) as { id: string };
    expect(attachments(database, workstream.id)).toEqual([expect.objectContaining({
      resource_type: "linear_issue",
      provider_resource_id: "ISS-42",
      canonical_url: "https://linear.app/avalon/issue/ISS-42",
    })]);
  });
});

describe("reconciling the shared resource row", () => {
  it("fills a missing link on a row an earlier activity created without one", async () => {
    // A Slack activity carries no permalink in its metadata, so the row it
    // creates has none. A thread origin described later does have one, and the
    // rail row is only clickable if it lands.
    const database = seededDatabase();
    const environmentValue = environment(database);
    const descriptor = await slackOrigin(environmentValue);
    database.prepare(
      `INSERT INTO resources
         (id, workspace_id, connection_id, resource_type, provider, provider_resource_id,
          title, canonical_url, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, 'slack_thread', 'slack', ?, 'Message in #operations', NULL, '{}', ?, ?)`,
    ).run("00000000-0000-7000-8000-0000000000d1", workspaceId, connectionId, descriptor.providerResourceId, at, at);

    await attachWorkstreamOriginResource(environmentValue, {
      workspaceId,
      workstreamId: (await new WorkstreamService(environmentValue, auth(), () => undefined)
        .create(request())).workstream.id,
      attachedByUserId: memberId,
      descriptor: { ...descriptor, canonicalUrl: "https://avalon.slack.com/archives/C1/p11" },
    });

    expect(database.prepare("SELECT canonical_url, title FROM resources WHERE id = ?")
      .get("00000000-0000-7000-8000-0000000000d1")).toEqual({
      canonical_url: "https://avalon.slack.com/archives/C1/p11",
      // The title belongs to whoever created the row; rewriting it would make the
      // rail's wording flip with whichever ingress ran most recently.
      title: "Message in #operations",
    });
  });

  it("never overwrites a link the row already has", async () => {
    const database = seededDatabase();
    const environmentValue = environment(database);
    const descriptor = await slackOrigin(environmentValue);
    database.prepare(
      `INSERT INTO resources
         (id, workspace_id, connection_id, resource_type, provider, provider_resource_id,
          title, canonical_url, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, 'slack_thread', 'slack', ?, 'Thread', 'https://avalon.slack.com/first', '{}', ?, ?)`,
    ).run("00000000-0000-7000-8000-0000000000d2", workspaceId, connectionId, descriptor.providerResourceId, at, at);

    await attachWorkstreamOriginResource(environmentValue, {
      workspaceId,
      workstreamId: (await new WorkstreamService(environmentValue, auth(), () => undefined)
        .create(request())).workstream.id,
      attachedByUserId: memberId,
      descriptor: { ...descriptor, canonicalUrl: "https://avalon.slack.com/second" },
    });

    expect(database.prepare("SELECT canonical_url FROM resources WHERE id = ?")
      .get("00000000-0000-7000-8000-0000000000d2"))
      .toEqual({ canonical_url: "https://avalon.slack.com/first" });
  });

  it("stores no content reference for an origin", async () => {
    // `payload_ref` addresses the raw verified webhook body in R2, and
    // `workstream_read_resource` serves whatever `content_ref` points at to the
    // model with no connector authorization of its own. An origin records where
    // something is, never what it said.
    const database = seededDatabase();
    seedActivityAutomation(database);
    database.prepare("UPDATE activities SET payload_ref = ? WHERE id = ?")
      .run("global/provider-webhooks/linear/abc.json", activityId);

    await activityConsumerTesting.runMatchingAutomations(
      automationEnvironment(database),
      { ...linearActivityRow(), payload_ref: "global/provider-webhooks/linear/abc.json" } as never,
    );

    expect(database.prepare(
      "SELECT content_ref FROM resources WHERE provider = 'linear'",
    ).get()).toEqual({ content_ref: null });
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

  it("leaves out a source the activity itself restricts, whatever the connection", async () => {
    // The case that matters: a message in a private Slack channel arrives on the
    // *workspace* connection and carries its restriction in `visibility`. The
    // work stream a suggestion creates is workspace-visible and broadcasts every
    // attachment, so an activity the rest of the pipeline withheld must not
    // become one here.
    const database = seededDatabase();
    seedOpportunity(database);
    database.prepare(
      "UPDATE activities SET visibility_json = ? WHERE id = ?",
    ).run(JSON.stringify({ workspaceAutomationAllowed: false, allowedUserIds: [memberId] }), activityId);
    const service = new WorkstreamService(environment(database), auth(), () => undefined);

    const created = await service.createFromOpportunity(opportunityRequest());

    expect(attachments(database, created.workstream.id)).toEqual([]);
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

/**
 * A Slack origin as the ingress produces one: through the registry, described
 * by the Slack adapter. No test here writes a descriptor by hand, because a
 * descriptor written by hand would not notice the connector no longer producing
 * that shape.
 */
async function slackOrigin(env: Env, overrides: {
  connectionId?: string;
  threadTs?: string;
  connection?: AuthorizedConnectorConnection;
} = {}): Promise<OriginResourceDescriptor> {
  const descriptor = await describeWorkstreamOrigin(env, {
    connectorType: "slack",
    connectionId: overrides.connectionId ?? connectionId,
    provider: "slack",
    locator: {
      kind: "agent_session",
      session: {
        teamId: "T0A4UF9KD08",
        channelId: "C1",
        threadTs: overrides.threadTs ?? "1.1",
        channelName: "operations",
        channelType: "public",
        invocationType: "app_mention",
      },
    },
    ...(overrides.connection
      ? { connection: overrides.connection, signal: AbortSignal.timeout(2_000) }
      : {}),
  });
  if (!descriptor) throw new Error("The Slack connector described no origin");
  return descriptor;
}

function slackConnection(): AuthorizedConnectorConnection {
  return authorizedConnection({
    id: connectionId,
    workspaceId,
    scope: "workspace",
    ownerUserId: null,
    grantedScopes: [],
    credentials: { botAccessToken: "xoxb-test" },
    cursor: {},
    config: {},
  });
}

function slackOriginContext(overrides: Partial<SlackOriginContext> = {}): SlackOriginContext {
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
    // Enough for the registry to build the two adapters these tests describe
    // origins with; an unconfigured connector is a separate case below.
    PUBLIC_API_BASE_URL: "https://api.example.com",
    SLACK_CLIENT_ID: "slack-client",
    SLACK_CLIENT_SECRET: "slack-secret",
    SLACK_SIGNING_SECRET: "slack-signing",
    LINEAR_OAUTH_CLIENT_ID: "linear-client",
    LINEAR_OAUTH_CLIENT_SECRET: "linear-secret",
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

function linearActivityRow() {
  return {
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
    payload_ref: null,
    title: "Assigned ISS-42",
    summary: "",
    text_snippet: "",
    metadata_json: JSON.stringify({ url: "https://linear.app/avalon/issue/ISS-42" }),
    visibility_json: "{}",
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
  if (options.connectionScope === "personal") {
    // The activity records the scope of the connection it arrived on; a fixture
    // where the two disagree tests nothing that can happen.
    database.prepare(
      "UPDATE activities SET connection_scope = 'personal', connection_owner_user_id = ? WHERE id = ?",
    ).run(options.connectionOwnerUserId ?? strangerId, activityId);
  }
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
