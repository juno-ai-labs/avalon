import { asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { __integrationTesting } from "../src/services/integrations";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestEnv } from "./helpers/cloudflare-test";
import { createTestWorkspaceDO, workspaceObjectRpcs } from "./helpers/workspace-object-rpcs";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import {
  openWorkstreamAuthorityForTest,
  seedCanonicalConversationTurn,
  seedWorkstreamObjectRoot,
  seedWorkstreamRun,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
  workstreamObjectRun,
} from "./helpers/durable-authority";

const {
  loadRunPromptContext,
  projectModelProtocolTranscript,
  workstreamActivationInput,
} = __integrationTesting;

const WORKSPACE = asWorkspaceId("00000000-0000-7000-8000-000000000001");
const OWNER = "00000000-0000-7000-8000-000000000002";
const WORKSTREAM = asWorkstreamId("00000000-0000-7000-8000-000000000003");
const RUN = "00000000-0000-7000-8000-000000000004";
const DELIVERY = "00000000-0000-7000-8000-000000000005";
const SCHEDULE = "00000000-0000-7000-8000-000000000006";
const BRIEF_MESSAGE = "00000000-0000-7000-8000-000000000007";
const ATTEMPT = "attempt-1";
const LEASE_OWNER = "lease-owner-1";

const BRIEF = [
  "You are writing the scheduled digest for Ada Lovelace in the Avalon Studio workspace.",
  "",
  "## Source material (1 item)",
  "### Launch — workstream — link: https://with-avalon.com/app/workstreams/c1",
  "  - 2026-08-11T09:00:00.000Z · Dana Okafor: Shipped the installer",
].join("\n");

const databases: DatabaseSync[] = [];
/** The work stream's own object database, rebuilt by each `seededDatabase`. */
let objectStores = new Map<string, DatabaseSync>();
/** The real WorkspaceDO the fixture stands up; the delivery row lives in its database. */
let workspaceDO: WorkspaceDO;
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function envFor(database: DatabaseSync): Env {
  const base = createTestEnv({
    DB: sqliteD1(database),
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
    // The digest window is re-read through the object that owns the delivery
    // row, so the fixture serves that method from a real WorkspaceDO.
    WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
      extra: workspaceObjectRpcs(workspaceDO, ["digestDeliveryContext"]),
    }),
    AVALON_REGION: "global",
    APP_ENV: "test",
    PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
    // Keep Terminal configured so this fixture exercises the external-delivery
    // tie-breaker against the standing document policy.
    TERMINAL_REGION_CAPABILITY: "supported",
    DAYTONA_API_KEY: "daytona-key",
    DAYTONA_API_URL: "https://app.daytona.io/api",
    DAYTONA_TARGET: "us",
    DAYTONA_TERMINAL_SNAPSHOT: "terminal-snapshot",
    TERMINAL_EMERGENCY_DISABLED: "false",
  });
  // Transcript reads reach the object through the typed message port.
  return base;
}

/**
 * A digest occurrence exactly as the scheduler leaves it: a claimed delivery, a
 * hidden work stream, the brief in the transcript as a `system` row, and a
 * running harness attempt holding its lease.
 *
 * The frozen memory context is pre-inserted so `loadRunPromptContext` returns
 * from its cached branch. This test is about what reaches the model, and memory
 * retrieval would otherwise decide whether it runs at all.
 */
function seededDatabase(options: { brief?: string } = {}): DatabaseSync {
  const database = preRetirementProductSqliteDatabase();
  databases.push(database);
  // The prompt context is read through the runtime SQL port since the cutover,
  // so the fixture opens the authority and writes the transcript, run and
  // frozen memory context into the work stream's own object below.
  openWorkstreamAuthorityForTest(database);
  const brief = options.brief ?? BRIEF;
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, timezone, created_at, updated_at)
    VALUES ('${OWNER}', 'g-owner', 'ada@example.com', 'Ada Lovelace', 'Europe/London', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE}', 'Avalon Studio', 'avalon-studio', 'global', '${OWNER}', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${WORKSPACE}', '${OWNER}', 'owner', 'active', '2026-01-01');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id, harness_status,
       next_sequence_number, last_activity_at, created_at, updated_at, system_kind, scope)
    VALUES ('${WORKSTREAM}', '${WORKSPACE}', 'Digest · Ada Lovelace',
            'Write this person''s scheduled digest of what changed since the last one.',
            'ad_hoc', '${OWNER}', 'running', 2, '2026-08-11', '2026-08-11', '2026-08-11', 'digest', 'personal');
  `);
  const built = createTestWorkspaceDO({
    workspaceId: WORKSPACE,
    regionalDatabase: database,
    register: (created) => databases.push(created),
  });
  workspaceDO = built.instance;
  built.objectDatabase.exec(`
    INSERT INTO digest_schedules
      (id, workspace_id, user_id, day_mask, enabled,
       execution_principal_json, version, created_at, updated_at)
    VALUES ('${SCHEDULE}', '${WORKSPACE}', '${OWNER}', 62, 1,
            '{"type":"user","userId":"${OWNER}"}', 1, '2026-01-01', '2026-01-01');
    INSERT INTO digest_deliveries
      (id, workspace_id, digest_schedule_id, user_id, planned_for, cursor_from, cursor_through,
       event_count, highlight_count, harness_run_id, workstream_id, status, created_at, updated_at)
    VALUES ('${DELIVERY}', '${WORKSPACE}', '${SCHEDULE}', '${OWNER}', '2026-08-11T16:00:00.000Z',
            NULL, 201, 42, 1, NULL, '${WORKSTREAM}', 'running', '2026-08-11', '2026-08-11');
  `);
  const objectStore = testWorkstreamObjectStore();
  databases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, {
    workstreamId: WORKSTREAM,
    workspaceId: WORKSPACE,
    title: "Digest · Ada Lovelace",
    description: "Write this person's scheduled digest of what changed since the last one.",
    originType: "ad_hoc",
    createdByUserId: OWNER,
    exactState: "running",
    nextSequenceNumber: 2,
    systemKind: "digest",
    scope: "personal",
  });
  objectStores = new Map([[WORKSTREAM as string, objectStore]]);

  seedWorkstreamRun(objectStore, { id: RUN, origin: "scheduled_digest",
    executionPrincipalJson: JSON.stringify({ type: "user", userId: OWNER }),
    attemptId: ATTEMPT, leaseOwner: LEASE_OWNER,
    leaseExpiresAt: Date.parse("2099-01-01T00:00:00.000Z") });
  seedCanonicalConversationTurn(objectStore, {
    turnId: BRIEF_MESSAGE,
    clientMessageId: `digest:${DELIVERY}`,
    actor: "system",
    authorSnapshot: null,
    messageType: "system",
    text: brief,
    transcriptSequence: 1,
    createdAt: "2026-08-11T16:00:00.000Z",
  });
  workstreamObjectRun(
    objectStore,
    `INSERT INTO run_memory_contexts
       (run_id, attempt_id, memory_scope_ids_json, query_text, retrieval_mode,
        results_json, memory_context_hash, created_at)
     VALUES (?, ?, '[]', 'digest', 'fts_only', '[]', 'hash', ?)`,
    RUN,
    ATTEMPT,
    Date.parse("2026-08-11T00:00:00.000Z"),
  );
  return database;
}

function workflowInput(overrides: Record<string, unknown> = {}) {
  return {
    region: "global" as const,
    workspaceId: WORKSPACE,
    workstreamId: WORKSTREAM,
    loopId: `workstream:${WORKSTREAM}:substream:0:loop`,
    harnessRunId: RUN,
    triggerMessageId: BRIEF_MESSAGE,
    automationSubscriptionId: null,
    activityId: null,
    digestDeliveryId: DELIVERY,
    executionPrincipal: { type: "user" as const, userId: OWNER },
    reason: "scheduled_digest",
    ...overrides,
  } as Parameters<typeof loadRunPromptContext>[1];
}

const lease = { attemptId: ATTEMPT, owner: LEASE_OWNER } as Parameters<typeof loadRunPromptContext>[2];
const workstream = {
  title: "Digest · Ada Lovelace",
  objective: "Write this person's scheduled digest of what changed since the last one.",
};

describe("the window a scheduled digest run is given", () => {
  it("puts the frozen brief in front of the model", async () => {
    const env = envFor(seededDatabase());

    const context = await loadRunPromptContext(env, workflowInput(), lease, workstream);

    // The whole defect this test exists for: a run launched without this
    // message reaches the model as a bare system prompt, and a model asked to
    // summarize a window it cannot see reports that nothing happened.
    const brief = context.additionalMessages.find(
      (message) => typeof message.content === "string" && message.content.includes("SCHEDULED DIGEST BRIEF"),
    );
    expect(brief?.role).toBe("user");
    expect(brief?.content).toContain("Shipped the installer");
    expect(brief?.content).toContain("## Source material (1 item)");
    // Provenance the model needs to know what it is holding, derived by Avalon
    // rather than quoted from anybody.
    expect(brief?.content).toContain("2026-08-11T16:00:00.000Z");
    expect(brief?.content).toContain("covering 42 events");
    expect(context.systemPrompt).toContain("# External delivery output");
    expect(context.systemPrompt).toContain("put the complete usable result in the final message");
    if (!brief) throw new Error("digest activation context was not assembled");
    expect(workstreamActivationInput(brief)).toMatchObject({
      activationInputId: `activation:["digest_delivery","${DELIVERY}",null]`,
      message: {
        role: "user",
        provenance: {
          originKind: "derived",
          sourceKind: "digest_delivery",
          sourceId: DELIVERY,
          sourceRevision: null,
        },
      },
    });
  });

  it("never carries the window in the system prompt", async () => {
    const env = envFor(seededDatabase());

    const context = await loadRunPromptContext(env, workflowInput(), lease, workstream);

    // The events are connector-derived text. They are the run's material, not
    // its policy, and the system prompt is the only place that may say what the
    // agent is allowed to do.
    expect(context.systemPrompt).not.toContain("Shipped the installer");
  });

  it("fails the attempt when the brief is missing rather than running blind", async () => {
    const env = envFor(seededDatabase({ brief: "   " }));

    // An unsettled delivery folds its window into the next occurrence. A run
    // that proceeds without one consumes the window and delivers nothing.
    await expect(loadRunPromptContext(env, workflowInput(), lease, workstream))
      .rejects.toThrow("digest_brief_context_not_found");
  });

  it("cannot be handed another occurrence's window", async () => {
    const env = envFor(seededDatabase());

    // The brief is addressed by the delivery's own `digest:<id>` client message
    // id, so a delivery whose brief was never written resolves to nothing
    // instead of to whatever else is in this work stream's transcript.
    await expect(loadRunPromptContext(
      env,
      workflowInput({ digestDeliveryId: "00000000-0000-7000-8000-0000000000ff" }),
      lease,
      workstream,
    )).rejects.toThrow("digest_brief_context_not_found");
  });

  it("still keeps the brief's transcript row out of the protocol transcript", async () => {
    const env = envFor(seededDatabase());

    // The `system` row stays UI state — it answers "why did this start?" for a
    // person opening the work stream. Making it model-visible here instead
    // would put unlabelled connector text into replayed history on every later
    // turn, which is why the brief travels as its own labelled message.
    const projection = await projectModelProtocolTranscript(
      env,
      { workspaceId: WORKSPACE, workstreamId: WORKSTREAM, triggerMessageId: BRIEF_MESSAGE },
      [{
        id: BRIEF_MESSAGE,
        workstreamId: WORKSTREAM,
        clientMessageId: `digest:${DELIVERY}`,
        author: { type: "system" },
        messageType: "system",
        textContent: BRIEF,
        sequenceNumber: 1,
        createdAt: "2026-08-11T16:00:00.000Z",
        attachments: [],
      }] as unknown as Parameters<typeof projectModelProtocolTranscript>[2],
    );

    expect(projection.messages).toEqual([]);
  });
});
