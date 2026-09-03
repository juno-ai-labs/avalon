import {
  asHarnessRunId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type WorkstreamWorkflowInput,
} from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { __integrationTesting } from "../src/services/integrations";
import { createTestEnv } from "./helpers/cloudflare-test";
import {
  openWorkstreamAuthorityForTest,
  seedCanonicalConversationTurn,
  seedWorkstreamObjectRoot,
  seedWorkstreamRun,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
  workstreamObjectRun,
} from "./helpers/durable-authority";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const { loadRunPromptContext } = __integrationTesting;

const WORKSPACE = asWorkspaceId("00000000-0000-7000-8000-000000000101");
const OWNER = asUserId("00000000-0000-7000-8000-000000000102");
const WORKSTREAM = asWorkstreamId("00000000-0000-7000-8000-000000000103");
const RUN = asHarnessRunId("00000000-0000-7000-8000-000000000104");
const MESSAGE = "00000000-0000-7000-8000-000000000105";
const ATTEMPT = "attempt-message-context";
const LEASE_OWNER = "lease-message-context";

const databases: DatabaseSync[] = [];
let objectStores = new Map<string, DatabaseSync>();

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function seededEnv(): Env {
  const database = preRetirementProductSqliteDatabase();
  databases.push(database);
  openWorkstreamAuthorityForTest(database);

  const objectStore = testWorkstreamObjectStore();
  databases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, {
    workstreamId: WORKSTREAM,
    workspaceId: WORKSPACE,
    title: "Launch plan",
    description: "Prepare the launch plan.",
    originType: "ad_hoc",
    createdByUserId: OWNER,
    exactState: "running",
    scope: "personal",
  });
  seedWorkstreamRun(objectStore, {
    id: RUN,
    origin: "human_message",
    executionPrincipalJson: JSON.stringify({ type: "user", userId: OWNER }),
    attemptId: ATTEMPT,
    leaseOwner: LEASE_OWNER,
    leaseExpiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
  });
  seedCanonicalConversationTurn(objectStore, {
    turnId: MESSAGE,
    clientMessageId: "client-message-context",
    actor: "human",
    authorUserId: OWNER,
    authorSnapshot: { displayName: "Ada", avatarUrl: null },
    messageType: "text",
    text: "Draft the launch plan",
    transcriptSequence: 1,
    createdAt: "2026-09-01T12:00:00.000Z",
  });
  workstreamObjectRun(
    objectStore,
    `INSERT INTO run_memory_contexts
       (run_id, attempt_id, memory_scope_ids_json, query_text, retrieval_mode,
        results_json, memory_context_hash, created_at)
     VALUES (?, ?, '[]', 'cached automatic recall', 'fts_only', '[]',
             'cached-memory-context-hash', ?)`,
    RUN,
    ATTEMPT,
    Date.parse("2026-09-01T12:00:00.000Z"),
  );
  objectStores = new Map([[WORKSTREAM as string, objectStore]]);

  return createTestEnv({
    DB: sqliteD1(database),
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
    AVALON_REGION: "global",
    APP_ENV: "test",
    PUBLIC_WEB_BASE_URL: "https://rallywith.ai",
  });
}

function workflowInput(reason: string): WorkstreamWorkflowInput {
  return {
    region: "global",
    workspaceId: WORKSPACE,
    parentKind: "workstream",
    parentId: WORKSTREAM,
    substreamId: asSubstreamId("0"),
    loopId: `workstream:${WORKSTREAM}:substream:0:loop`,
    harnessRunId: RUN,
    triggerMessageId: MESSAGE,
    activityId: null,
    executionPrincipal: { type: "user", userId: OWNER },
    reason,
  };
}

const lease = {
  attemptId: ATTEMPT,
  owner: LEASE_OWNER,
  attemptNumber: 1,
  leaseExpiresAt: "2099-01-01T00:00:00.000Z",
};
const workstream = { title: "Launch plan", objective: "Prepare the launch plan." };

describe("automatic memory recall at run admission", () => {
  it.each([
    "opening_message",
    "human_message",
    "elicitation_answer",
    "inbound_email",
    "slack_workspace_opening_message",
    "slack_workspace_message",
    "slack_workspace_elicitation_answer",
  ])("does not recall long-term memory for the message origin %s", async (reason) => {
    const context = await loadRunPromptContext(seededEnv(), workflowInput(reason), lease, workstream);

    expect(context.memoryContextHash).toBeNull();
    expect(context.additionalMessages).not.toContainEqual(expect.objectContaining({
      provenance: expect.objectContaining({ sourceKind: "memory_context" }),
    }));
  });

  it("keeps frozen admission recall for a non-message run", async () => {
    const context = await loadRunPromptContext(seededEnv(), workflowInput("manual_retry"), lease, workstream);

    expect(context.memoryContextHash).toBe("cached-memory-context-hash");
  });
});
