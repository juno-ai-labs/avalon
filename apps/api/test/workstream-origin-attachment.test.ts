import { asUserId, asWorkspaceId } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SlackOriginContext } from "@rally/contracts";
import type { AuthContext, Env } from "../src/env";
import type * as NamingService from "../src/services/workstream-naming-service";
import { authorizedConnection, type AuthorizedConnectorConnection } from "@rally/connectors";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import {
  openWorkstreamAuthorityForTest,
  seedWorkstreamObjectRoot,
  testSubstreamAgentsBinding,
  testWorkstreamContract,
  testWorkstreamObjectStore,
  workstreamObjectAll,
} from "./helpers/durable-authority";

vi.mock("../src/services/integrations", () => ({
  classifyWorkstreamMessage: vi.fn(async () => ({
    classification: "human_only",
    confidence: 1,
    rationaleCode: "test",
  })),
  publishWorkstreamEvent: vi.fn(async () => undefined),
  activateWorkstreamLoop: vi.fn(async () => "execution-receipt"),
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
    async setStatus() {
      return undefined;
    }
  },
}));

import { SlackWorkspaceWorkstreamService } from "../src/services/slack-workspace-workstream-service";
import { WorkstreamService } from "../src/services/workstream-service";
import { publishWorkstreamEvent } from "../src/services/integrations";
import {
  attachWorkstreamOriginResource,
  describeWorkstreamOrigin,
  type OriginResourceDescriptor,
} from "../src/services/workstream-origin-resource";
import { createTestEnv } from "./helpers/cloudflare-test";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000001");
const memberId = asUserId("00000000-0000-7000-8000-000000000002");
const connectionId = "00000000-0000-7000-8000-000000000003";
const strangerId = "00000000-0000-7000-8000-000000000004";
const activityId = "00000000-0000-7000-8000-000000000008";
const opportunityId = "00000000-0000-7000-8000-000000000009";
const activityNodeId = "00000000-0000-7000-8000-00000000000a";
const messageNodeId = "00000000-0000-7000-8000-00000000000b";
const at = "2026-08-12T09:00:00.000Z";
const databases: DatabaseSync[] = [];
/** Every resource the created work stream's object was asked to attach. */
let attachedResourceIds: string[] = [];

/**
 * Per-workstream object databases, keyed by the regional database they pair
 * with. The runtime SQL port fills this map lazily; the product stubs below
 * seat origin links into the same stores, so an assertion reads the one place
 * the attachment truly lives since the D1 copies were dropped.
 */
const objectStoresByDatabase = new WeakMap<DatabaseSync, Map<string, DatabaseSync>>();

function storesFor(database: DatabaseSync): Map<string, DatabaseSync> {
  let stores = objectStoresByDatabase.get(database);
  if (!stores) {
    stores = new Map();
    objectStoresByDatabase.set(database, stores);
  }
  return stores;
}

function objectStoreFor(database: DatabaseSync, workstreamId: string, wsId: string): DatabaseSync {
  const stores = storesFor(database);
  let store = stores.get(workstreamId);
  if (!store) {
    store = testWorkstreamObjectStore();
    stores.set(workstreamId, store);
    databases.push(store);
  }
  seedWorkstreamObjectRoot(store, { workstreamId, workspaceId: wsId });
  return store;
}

/** Seat a link the way the object does — links table directly; the compat view has no INSERT arm. */
function seatObjectResourceLink(store: DatabaseSync, input: {
  resourceId: string;
  attachedByUserId: string | null;
  relationshipType: string;
}): void {
  store.prepare(
    `INSERT INTO workstream_resource_links
       (resource_id, attached_by_user_id, watch_enabled, relationship_type,
        resource_json, attached_at, updated_at)
     VALUES (?, ?, 0, ?, ?, ?, ?)
     ON CONFLICT(resource_id) DO NOTHING`,
  ).run(
    input.resourceId,
    input.attachedByUserId,
    input.relationshipType,
    JSON.stringify({ id: input.resourceId }),
    Date.parse(at),
    Date.parse(at),
  );
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  attachedResourceIds = [];
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

    // The shared resource row is regional; the attach itself belongs to the
    // work stream's object, observed at its boundary.
    const resource = database.prepare(
      `SELECT id, resource_type, provider, provider_resource_id, title, canonical_url
         FROM resources WHERE provider = 'slack'`,
    ).get() as Record<string, unknown>;
    expect(resource).toMatchObject({
      resource_type: "slack_thread",
      provider: "slack",
      provider_resource_id: "C1:thread:1786491700.928349",
      title: "Thread in #operations",
      canonical_url: "https://avalon.slack.com/archives/C1/p1786491700928349",
    });
    expect(attachedResourceIds).toEqual([resource.id]);
    expect(created.workstream.id).toBeTruthy();
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
    // Both objects were handed the same shared row, once each.
    expect(first.workstream.id).not.toBe(second.workstream.id);
    expect(attachedResourceIds).toHaveLength(2);
    expect(new Set(attachedResourceIds).size).toBe(1);
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

  it("leaves origin realtime publication to the owning work-stream object", async () => {
    const database = seededDatabase();
    const environmentValue = environment(database);
    const created = await new WorkstreamService(environmentValue, auth(), () => undefined).create(request());
    vi.mocked(publishWorkstreamEvent).mockClear();

    await expect(attachWorkstreamOriginResource(environmentValue, {
      workspaceId,
      workstreamId: created.workstream.id,
      attachedByUserId: memberId,
      descriptor: await slackOrigin(environmentValue),
    })).resolves.not.toBeNull();

    expect(publishWorkstreamEvent).not.toHaveBeenCalled();
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

  it("keeps the shared row when the work stream is gone", async () => {
    const database = seededDatabase();
    const environmentValue = environment(database);
    const created = await new WorkstreamService(environmentValue, auth(), () => undefined).create(request());
    // Deletion removes the object along with its anchor; the attach must find
    // neither half of the work stream.
    database.prepare("DELETE FROM workstreams WHERE id = ?").run(created.workstream.id);
    storesFor(database).delete(created.workstream.id);

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
  return createTestEnv({
    DB: sqliteD1(database),
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, {
      objectStores: storesFor(database),
      product: {
        initialize: (request) => {
          const input = request.input as {
            workstreamId: string;
            workspaceId: string;
            title: string;
            objective: string;
            titleStatus: string;
            creatorUserId: string | null;
            emailAddress: string;
            originResourceIds: string[];
          };
          // The object seats opportunity origins at initialize; the stub seats
          // them into the work stream's own object store, which is where the
          // link rows live since the D1 copy was dropped.
          const store = objectStoreFor(database, input.workstreamId, input.workspaceId);
          for (const resourceId of input.originResourceIds) {
            seatObjectResourceLink(store, {
              resourceId,
              attachedByUserId: input.creatorUserId,
              relationshipType: "origin",
            });
          }
          return {
            workstream: testWorkstreamContract({
              id: input.workstreamId,
              workspaceId: input.workspaceId,
              title: input.title,
              objective: input.objective,
              titleStatus: input.titleStatus,
              createdByUserId: input.creatorUserId,
              emailAddress: input.emailAddress,
            }),
            turnId: crypto.randomUUID(),
            harnessRunId: crypto.randomUUID(),
          };
        },
        attach_resource: (request) => {
          attachedResourceIds.push(String(request.resourceId));
          const row = database.prepare("SELECT * FROM resources WHERE id = ?")
            .get(String(request.resourceId)) as Record<string, unknown> | undefined;
          return {
            id: request.resourceId,
            workspaceId,
            connectionId: row?.connection_id ?? null,
            resourceType: row?.resource_type ?? "slack_thread",
            provider: row?.provider ?? "slack",
            providerResourceId: row?.provider_resource_id ?? null,
            title: row?.title ?? "Origin",
            mimeType: null,
            canonicalUrl: row?.canonical_url ?? null,
            watchEnabled: false,
            watchStatus: "unsupported",
            lastHydratedAt: null,
            createdAt: at,
            updatedAt: at,
          };
        },
      },
      extra: {
        attachRuntimeResource: vi.fn((input: {
          workstreamId: string;
          resourceId: string;
          attachedByUserId: string | null;
          relationshipType?: string;
        }) => {
          // The real object refuses an attach when it holds no identity — a
          // deleted work stream's object is gone along with its anchor.
          const store = storesFor(database).get(input.workstreamId);
          if (!store) {
            throw new Error("workstream_runtime_identity_mismatch");
          }
          seatObjectResourceLink(store, {
            resourceId: input.resourceId,
            attachedByUserId: input.attachedByUserId,
            relationshipType: input.relationshipType ?? "generated",
          });
          return { status: 200, bodyJson: "{}" };
        }),
      },
    }),
    WORKSTREAM_DOS: testSubstreamAgentsBinding(database, {
      extra: { flushWorkspaceDirectoryEffects: vi.fn(async () => ({ status: 200, bodyJson: "{}" })) },
    }),
    WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
      extra: {
        hasWorkstreamDirectory: vi.fn(async () => true),
        opportunityOriginEvents: vi.fn(async (request: { opportunityId: string }) => {
          const rows = database.prepare(
            `SELECT a.*, c.connector_type
               FROM work_opportunity_provenance_roots root
               JOIN opportunity_provenance_nodes node ON node.id = root.node_id
               JOIN activities a ON a.id = node.source_id
               JOIN connector_connections c ON c.id = a.connection_id
              WHERE root.opportunity_id = ? AND node.node_kind = 'activity'
              ORDER BY root.position`,
          ).all(request.opportunityId) as Array<Record<string, unknown>>;
          return rows.map((row) => ({
            connectorType: String(row.connector_type),
            activity: {
              id: row.id,
              workspaceId: row.workspace_id,
              region: "global",
              connectionId: row.connection_id,
              connectionScope: row.connection_scope,
              connectionOwnerUserId: row.connection_owner_user_id ?? null,
              provider: row.provider,
              providerEventId: row.provider_event_id,
              eventType: row.event_type,
              resourceType: row.resource_type ?? null,
              providerResourceId: row.provider_resource_id ?? null,
              actor: {},
              subject: {},
              occurredAt: row.occurred_at,
              receivedAt: row.received_at,
              title: row.title,
              summary: "",
              textSnippet: "",
              payloadRef: null,
              visibility: JSON.parse(String(row.visibility_json ?? "{}")) as Record<string, unknown>,
              targetUserIds: JSON.parse(String(row.target_user_ids_json ?? "[]")) as string[],
              entityKeys: [],
              dedupeKey: row.dedupe_key,
              rawContentHash: null,
              metadata: JSON.parse(String(row.metadata_json ?? "{}")) as Record<string, unknown>,
            },
          }));
        }),
      },
    }),
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
  });
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
    audienceScope: "workspace" as const,
  };
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
  // The link rows live in the work stream's object; the shared resource rows
  // stay regional. The old one-query join died with the D1 link table, so the
  // halves are read from their own stores and joined here.
  const store = storesFor(database).get(workstreamId);
  if (!store) return [];
  const links = workstreamObjectAll<{
    resource_id: string;
    relationship_type: string;
    attached_by_user_id: string | null;
    watch_enabled: number;
  }>(
    store,
    `SELECT resource_id, relationship_type, attached_by_user_id, watch_enabled
       FROM workstream_resource_links ORDER BY attached_at, resource_id`,
  );
  return links.map((link) => {
    const resource = database.prepare(
      `SELECT resource_type, provider, provider_resource_id, title, canonical_url
         FROM resources WHERE id = ?`,
    ).get(link.resource_id) as Record<string, unknown> | undefined;
    if (!resource) throw new Error(`attached resource ${link.resource_id} has no regional row`);
    return {
      relationship_type: link.relationship_type,
      attached_by_user_id: link.attached_by_user_id,
      watch_enabled: link.watch_enabled,
      ...resource,
    };
  });
}

function seededDatabase(): DatabaseSync {
  const database = preRetirementProductSqliteDatabase();
  databases.push(database);
  // Every creation path serves product state from the Durable-Object
  // authority now; open it before any product rows exist.
  openWorkstreamAuthorityForTest(database);
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
