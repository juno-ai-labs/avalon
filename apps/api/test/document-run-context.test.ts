/**
 * Which runs are told to write a document, and which are left alone.
 *
 * The guidance is only followable where there is a terminal workspace to write
 * in and where what the run produces is read in the work stream. A run whose
 * result leaves through a delivery path — an automation's frozen destinations,
 * a scheduled digest, an inbound email's reply, a Slack thread — carries a
 * final message and nothing else, so a document published to the rail would
 * never reach the person who asked for it.
 */
import {
  asHarnessRunId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type SlackOriginContext,
  type WorkstreamWorkflowInput,
} from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { __integrationTesting } from "../src/services/integrations";
import { withWorkstreamRuntimeDatabase } from "../src/services/workstream-runtime-database";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestEnv } from "./helpers/cloudflare-test";
import {
  openWorkstreamAuthorityForTest,
  seedWorkstreamObjectRoot,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
  workstreamObjectRun,
} from "./helpers/durable-authority";

const { loadRunPromptContext } = __integrationTesting;

const WORKSPACE = asWorkspaceId("00000000-0000-7000-8000-0000000000b1");
const OWNER = "00000000-0000-7000-8000-0000000000b2";
const WORKSTREAM = asWorkstreamId("00000000-0000-7000-8000-0000000000b3");
const RUN = asHarnessRunId("00000000-0000-7000-8000-0000000000b4");
const ATTEMPT = "attempt-1";
const LEASE_OWNER = "lease-owner-1";

const databases: DatabaseSync[] = [];
let objectStores = new Map<string, DatabaseSync>();
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

/** A plain interactive work stream, with the memory context already frozen. */
function seededDatabase(): DatabaseSync {
  const database = preRetirementProductSqliteDatabase();
  databases.push(database);
  openWorkstreamAuthorityForTest(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, timezone, created_at, updated_at)
    VALUES ('${OWNER}', 'g-owner', 'owner@example.com', 'Alex', 'Europe/London', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE}', 'Rally Studio', 'rally-studio', 'global', '${OWNER}', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${WORKSPACE}', '${OWNER}', 'owner', 'active', '2026-01-01');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id, harness_status,
       next_sequence_number, last_activity_at, created_at, updated_at, scope)
    VALUES ('${WORKSTREAM}', '${WORKSPACE}', 'Mute windows',
            'Design mute windows for work streams.', 'ad_hoc', '${OWNER}', 'running',
            1, '2026-08-27', '2026-08-27', '2026-08-27', 'personal');
  `);
  const objectStore = testWorkstreamObjectStore();
  databases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, {
    workstreamId: WORKSTREAM,
    workspaceId: WORKSPACE,
    title: "Mute windows",
    description: "Design mute windows for work streams.",
    originType: "ad_hoc",
    createdByUserId: OWNER,
    exactState: "running",
    scope: "personal",
  });
  objectStores = new Map([[WORKSTREAM as string, objectStore]]);
  workstreamObjectRun(
    objectStore,
    `INSERT INTO harness_runs
       (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at,
        attempt_id, lease_owner, lease_expires_at)
     VALUES (?, ?, ?, 'user_message', ?, 'running', '2026-08-27', ?, ?, '2099-01-01T00:00:00.000Z')`,
    RUN,
    WORKSPACE,
    WORKSTREAM,
    JSON.stringify({ type: "user", userId: OWNER }),
    ATTEMPT,
    LEASE_OWNER,
  );
  // Retrieval would otherwise decide whether the context loads at all; this
  // test is about which section reaches the model.
  workstreamObjectRun(
    objectStore,
    `INSERT INTO run_memory_contexts
       (run_id, attempt_id, memory_scope_ids_json, query_text, retrieval_mode,
        results_json, memory_context_hash, created_at)
     VALUES (?, ?, '[]', 'documents', 'fts_only', '[]', 'hash', ?)`,
    RUN,
    ATTEMPT,
    Date.parse("2026-08-27T00:00:00.000Z"),
  );
  return database;
}

function envFor(
  database: DatabaseSync,
  terminal: "supported" | "unsupported" = "supported",
): Env {
  const base = createTestEnv({
    DB: sqliteD1(database),
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
    AVALON_REGION: "global",
    APP_ENV: "production",
    PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
    TERMINAL_REGION_CAPABILITY: terminal,
    DAYTONA_API_KEY: "daytona-key",
    DAYTONA_API_URL: "https://app.daytona.io/api",
    DAYTONA_TARGET: "us",
    DAYTONA_TERMINAL_SNAPSHOT: "terminal-snapshot",
    TERMINAL_EMERGENCY_DISABLED: "false",
  });
  return withWorkstreamRuntimeDatabase(base, WORKSPACE, WORKSTREAM);
}

const workflowInput: WorkstreamWorkflowInput = {
  region: "global",
  workspaceId: WORKSPACE,
  workstreamId: WORKSTREAM,
  harnessRunId: RUN,
  triggerMessageId: null,
  automationSubscriptionId: null,
  activityId: null,
  executionPrincipal: { type: "user", userId: asUserId(OWNER) },
  reason: "user_message",
};

const lease = { attemptId: ATTEMPT, owner: LEASE_OWNER } as Parameters<typeof loadRunPromptContext>[2];
const workstream = { title: "Mute windows", objective: "Design mute windows for work streams." };

const slackOrigin: SlackOriginContext = {
  teamId: "T1",
  channelId: "C1",
  channelName: "product",
  threadTs: "1724716800.000100",
  invocationType: "app_mention",
  channelType: "public",
  matchedAvalonUserId: null,
  nearbyMessagesStatus: "available",
  nearbyMessages: [],
  attachments: [],
  appContext: null,
};

describe("which runs are told to write documents", () => {
  it("tells an interactive run in a region with Terminal", async () => {
    const context = await loadRunPromptContext(envFor(seededDatabase()), workflowInput, lease, workstream);

    expect(context.systemPrompt).toContain("# Documents");
    expect(context.systemPrompt).toContain("publish it as a work-stream resource");
  });

  it("says nothing to a run whose region has no Terminal", async () => {
    const env = envFor(seededDatabase(), "unsupported");

    const context = await loadRunPromptContext(env, workflowInput, lease, workstream);

    // There is no workspace to write the file in, so the guidance would be a
    // procedure the run cannot follow; behavior stays exactly today's.
    expect(context.systemPrompt).not.toContain("# Documents");
  });

  it("says nothing to an inbound-email run, whose reply is the email", async () => {
    const context = await loadRunPromptContext(
      envFor(seededDatabase()),
      { ...workflowInput, reason: "inbound_email" },
      lease,
      workstream,
    );

    expect(context.systemPrompt).not.toContain("# Documents");
  });

  it("says nothing to a HyperSight block run, which is read-only and has no chat", async () => {
    const context = await loadRunPromptContext(
      envFor(seededDatabase()),
      { ...workflowInput, reason: "block_dashboard_block" },
      lease,
      workstream,
    );

    // Every step of the section is a write tool the block loop refuses, and the
    // block itself is structured and sectioned — so the trigger fires on the
    // very thing the run exists to produce, and a model that obeys submits a
    // block saying it published a document somewhere.
    expect(context.systemPrompt).not.toContain("# Documents");
  });

  it("says nothing while an operator has Terminal emergency-disabled", async () => {
    const database = seededDatabase();
    const env = withWorkstreamRuntimeDatabase(
      createTestEnv({
        DB: sqliteD1(database),
        SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
        AVALON_REGION: "global",
        APP_ENV: "production",
        PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
        TERMINAL_REGION_CAPABILITY: "supported",
        DAYTONA_API_KEY: "daytona-key",
        DAYTONA_API_URL: "https://app.daytona.io/api",
        DAYTONA_TARGET: "us",
        DAYTONA_TERMINAL_SNAPSHOT: "terminal-snapshot",
        TERMINAL_EMERGENCY_DISABLED: "true",
      }),
      WORKSPACE,
      WORKSTREAM,
    );

    const context = await loadRunPromptContext(env, workflowInput, lease, workstream);

    // The switch exists to stop Terminal traffic. Rendering through an incident
    // costs a guaranteed-failing sandbox call on every document-shaped request
    // across the region.
    expect(context.systemPrompt).not.toContain("# Documents");
  });

  it("says nothing to a Slack-origin run, whose answer is read in the thread", async () => {
    const context = await loadRunPromptContext(
      envFor(seededDatabase()),
      { ...workflowInput, slackOrigin },
      lease,
      workstream,
    );

    // A rail entry is not visible from Slack, so the participant who asked
    // would be told a document exists and given no way to open it.
    expect(context.systemPrompt).not.toContain("# Documents");
  });
});
