/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A work stream is listed the moment it is created.
 *
 * The person who created it is about to open it, and the Worker's visibility
 * checks read the workspace directory, so creation cannot leave the row to the
 * child's first effect and the two Queue hops behind it. `reserveChild` on the
 * parent writes a provisional row into WorkspaceDO synchronously, the one
 * parent-to-workspace RPC the design keeps. This drives the real creation
 * service against real objects and real D1; the test Worker has no Queue
 * consumer, so a row that reaches the workspace can only have come that way.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import type { AuthContext, Env } from "../src/env";
import { conversationObjectName, workspaceDOName, workstreamDOName } from "../src/durable-objects/names";
import { WorkstreamObjectClient } from "../src/services/workstream-object-client";
import { WorkstreamObjectCreationService } from "../src/services/workstream-object-creation-service";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000bb0");
const USER_ID = asUserId("00000000-0000-7000-8000-000000000bb1");
const SESSION_ID = "00000000-0000-7000-8000-000000000bb2";

const AUTH: AuthContext = {
  sessionId: SESSION_ID,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  region: "global",
  role: "member",
};

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
}

beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB, {
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    sessionId: SESSION_ID,
  });
  // The regional rows the creation service writes around the object calls:
  // its create receipt, the anchor and route it keys authority on, and the
  // email address it reserves. Column lists follow the checked-in migrations
  // (packages/db/migrations); the foreign keys are left out because nothing
  // here turns on them.
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE workstream_create_receipts (
      workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id)
    )`),
    env.DB.prepare(`CREATE TABLE workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0
    )`),
    env.DB.prepare(`CREATE TABLE workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT, verified_at TEXT,
      activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL,
      UNIQUE (workspace_id, object_name), UNIQUE (workstream_id, generation)
    )`),
    env.DB.prepare(`CREATE TABLE workstream_email_routes (
      email_address TEXT PRIMARY KEY COLLATE NOCASE, address_source TEXT NOT NULL,
      region TEXT NOT NULL, workspace_id TEXT NOT NULL, workstream_id TEXT,
      automation_subscription_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (region, workspace_id, workstream_id)
    )`),
  ]);
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
}, 30_000);

/**
 * The test Worker carries no email address key and no session signing key to
 * derive one from; the address allocator needs one, and it is configuration,
 * not behaviour under test.
 */
function creationEnv(): Env {
  return new Proxy(env, {
    get: (current, property, receiver) => property === "WORKSTREAM_EMAIL_ADDRESS_KEY"
      ? "workerd-test-email-address-key-0123456789"
      : Reflect.get(current, property, receiver),
  });
}

describe("creating a work stream", () => {
  it("stores prepared history atomically without admitting a run and replays the receipt", async () => {
    const service = new WorkstreamObjectCreationService(creationEnv(), AUTH);
    const request = { title: "Imported conversation", openingMessage: "", clientMessageId: "import-1", participantUserIds: [], attachmentIds: [] };
    const initialContent = {
      source: { provider: "claude" as const, url: "https://claude.ai/share/f027df6e-0004-460c-8ec7-0666310a2ee2" },
      messages: [{ role: "user" as const, text: "Original question" }, { role: "assistant" as const, text: "Original answer" }],
    };
    const created = await service.create(request, { initialContent });
    expect(created.harnessRunId).toBeNull();
    const client = new WorkstreamObjectClient(creationEnv(), AUTH, created.workstream.id);
    const boot = await client.boot();
    expect(boot.transcript.ranges.flatMap((range) => range.turns).map((turn) => ({ actor: turn.actor, blocks: turn.blocks.map((block) => block.type === "text" ? block.text : block.type) })))
      .toEqual([{ actor: "human", blocks: ["Original question"] }, { actor: "assistant", blocks: ["Original answer"] }]);
    const firstBlock = boot.transcript.ranges.flatMap((range) => range.turns)[0]?.blocks[0];
    expect(firstBlock?.type === "text" ? firstBlock.structuredContent : null).toMatchObject({ kind: "imported_session", importedByUserId: USER_ID });
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName("global", WORKSPACE_ID, created.workstream.id)));
    const state = await runInDurableObject(stub, (_instance, ctx) => ({
      runs: ctx.storage.sql.exec(`SELECT run_id FROM runs`).toArray(),
      root: ctx.storage.sql.exec(`SELECT exact_state, next_attention_ordinal FROM workstream`).one(),
    }));
    expect(state.runs).toEqual([]);
    expect(state.root).toMatchObject({ exact_state: "idle", next_attention_ordinal: 3 });
    expect(await service.create(request, { initialContent })).toMatchObject({ turnId: created.turnId, harnessRunId: null, workstream: { id: created.workstream.id } });
    await expect(service.create(request, { initialContent: { ...initialContent, messages: [{ role: "user", text: "Changed" }] } })).rejects.toThrow("already used");
    expect((await client.boot()).transcript.ranges.flatMap((range) => range.turns)).toHaveLength(2);
    const continuation = await client.createMessage({
      text: "Continue from the original answer", clientMessageId: "import-followup-1",
      mentions: [], confirmedParticipantUserIds: [], attachmentIds: [],
      seed: { packVersion: "import-test", actionId: "continue", assistant: { kind: "say", text: "Continuing" } },
    });
    const admittedRuns = await runInDurableObject(stub, (_instance, ctx) =>
      ctx.storage.sql.exec(`SELECT run_id FROM runs WHERE trigger_part_id = ?`, continuation.turn.turnId).toArray());
    expect(admittedRuns).toHaveLength(1);

  });

  it("puts a provisional row in the workspace directory before the child has said anything", async () => {
    const service = new WorkstreamObjectCreationService(creationEnv(), AUTH);
    const created = await service.create({
      title: "Creation fence",
      objective: "Be listed before the first effect lands",
      openingMessage: "Start here",
      clientMessageId: "creation-fence-1",
      participantUserIds: [],
      attachmentIds: [],
      descriptionSource: "authored",
    });
    const workstreamId = created.workstream.id;

    // Version 1 of the parent's projection: the child's first aggregate lands
    // as version 2 and replaces it. (The column CHECKs `waterline > 0`, so the
    // provisional row is 1, not 0.)
    const directory = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{
      workstream_id: string;
      title: string;
      waterline: number;
      authority_generation: number;
      created_by_user_id: string | null;
    }>(
      `SELECT workstream_id, title, waterline, authority_generation, created_by_user_id
         FROM workspace_workstream_directory WHERE workstream_id = ?`,
      workstreamId,
    ).toArray());
    expect(directory).toEqual([{
      workstream_id: workstreamId,
      title: "Creation fence",
      waterline: 1,
      authority_generation: 1,
      created_by_user_id: USER_ID,
    }]);
    const viewer = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{
      is_participant: number;
      waterline: number;
    }>(
      `SELECT is_participant, waterline FROM workspace_workstream_viewers
        WHERE workstream_id = ? AND user_id = ?`,
      workstreamId,
      USER_ID,
    ).toArray());
    expect(viewer).toEqual([{ is_participant: 1, waterline: 1 }]);

    // The same call registered the main conversation with its parent.
    const parent = env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
      workstreamDOName("global", WORKSPACE_ID, asWorkstreamId(workstreamId)),
    ));
    await expect(parent.listChildren({ workspaceId: WORKSPACE_ID, parentId: workstreamId }))
      .resolves.toMatchObject({ children: [{ substreamId: "0", kind: "main" }] });
  });
});
