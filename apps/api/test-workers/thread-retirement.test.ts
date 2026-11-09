/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Retiring an Organization's Threads, Breakouts and Channels after the
 * cutover, on real objects: the transcript dump to R2 that must come first,
 * and the retirement it unlocks.
 *
 * The Organization here holds two Threads (one with a Breakout), a Channel
 * whose hidden Main still has messages, a Canvas and a Sidekick. The
 * conversations are real `AgentLoopDO` objects reached by the names
 * production derives, and their transcripts are written through the
 * transcript owner, so the dump reads what a person said, not a fixture row.
 */

import { env } from "cloudflare:workers";
import { createExecutionContext, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asSubstreamId, asUserId, asWorkspaceId } from "@rally/contracts";

import type { AgentLoopDO } from "../src/durable-objects/agent-loop-do";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import { EngineeringInspectionBridge } from "../src/engineering-inspection-bridge";
import type { Env } from "../src/env";
import { durableObjectStubForWorkspace } from "../src/lib/durable-object-namespace";
import { ensureAuditSchema } from "./helpers/audit-fixture";
import { seedInspectableWorkspace } from "./helpers/engineering-inspection-fixture";
import { insertChannelRow } from "./helpers/hosted-parent";
import { seedParticipantMessage, seedWorkstreamRoot } from "./helpers/substream-fixture";

const TEST_ENV: Env = env;
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000b701");
const USER_ID = asUserId("00000000-0000-7000-8000-00000000b702");
const SESSION_ID = "00000000-0000-7000-8000-00000000b703";
const THREAD_A = "00000000-0000-7000-8000-00000000b711";
const THREAD_B = "00000000-0000-7000-8000-00000000b712";
const BREAKOUT = "00000000-0000-7000-8000-00000000b713";
const CHANNEL = "00000000-0000-7000-8000-00000000b714";
const CANVAS = "00000000-0000-7000-8000-00000000b715";
const SIDEKICK = "00000000-0000-7000-8000-00000000b716";
const OPERATOR = { subject: "access-engineer", email: "engineer@example.com", audience: "engineering-mcp" };
const RESOURCE = "00000000-0000-7000-8000-00000000b717";
const AT = Date.parse("2026-11-07T09:00:00.000Z");

function bridge(): EngineeringInspectionBridge {
  return new EngineeringInspectionBridge(createExecutionContext(), TEST_ENV);
}

function organization() {
  return TEST_ENV.WORKSPACE_DOS.get(TEST_ENV.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
}

async function conversation(parentId: string, substreamId = "0") {
  return durableObjectStubForWorkspace(TEST_ENV, TEST_ENV.SUBSTREAM_AGENTS, WORKSPACE_ID,
    conversationObjectName("global", WORKSPACE_ID, parentId, asSubstreamId(substreamId)));
}

/** A conversation object with an identity and these messages, one second apart. */
async function seedConversation(
  parentId: string, parentKind: "workstream" | "space" | "canvas", substreamId: string, messages: string[],
): Promise<void> {
  await runInDurableObject(await conversation(parentId, substreamId), async (_instance, state) => {
    seedWorkstreamRoot(state, AT, { workspaceId: WORKSPACE_ID, workstreamId: parentId });
    state.storage.sql.exec("UPDATE workstream SET parent_kind = ? WHERE id = 1", parentKind);
    state.storage.sql.exec("UPDATE substream_agent_identity SET external_substream_id = ? WHERE id = 1", substreamId);
    for (const [index, text] of messages.entries()) {
      await seedParticipantMessage(state, { id: `${parentId}:${substreamId}:${index}`, sequence: index + 1, text, now: AT + index * 1_000 });
    }
  });
}

/** A Thread's or Channel's parent state, as a reservation leaves it, plus its children. */
function seedParent(state: DurableObjectState, parentId: string, kind: "workstream" | "space", children: string[]): void {
  state.storage.sql.exec(
    `INSERT INTO parent_metadata (parent_id, parent_kind, workspace_id, region, authority_generation, created_at, updated_at)
     VALUES (?, ?, ?, 'global', 1, 0, 0)`,
    parentId, kind, WORKSPACE_ID,
  );
  for (const substreamId of ["0", ...children]) {
    state.storage.sql.exec(
      `INSERT INTO parent_children (parent_id, substream_id, kind, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, 0)`,
      parentId, substreamId, substreamId === "0" ? "main" : "child", USER_ID,
    );
  }
}

async function seedOrganization(): Promise<void> {
  await runInDurableObject(organization(), (_instance, state) => {
    insertChannelRow(state, THREAD_A, "Launch plan", "workspace");
    insertChannelRow(state, THREAD_B, "Hiring", "workspace");
    seedParent(state, THREAD_A, "workstream", [BREAKOUT]);
    seedParent(state, THREAD_B, "workstream", []);
    state.storage.sql.exec(
      `INSERT INTO spaces (space_id, title, scope, appearance_json, archived_at, created_by_user_id,
         system_role, authority_generation, source_version, payload_hash, revision,
         created_at, updated_at, source_created_at, source_updated_at)
       VALUES (?, 'Marketing', 'workspace', NULL, NULL, ?, NULL, 1, 1, 'h', 1, 0, 0, 0, 0)`,
      CHANNEL, USER_ID,
    );
    seedParent(state, CHANNEL, "space", []);
    state.storage.sql.exec(
      `INSERT INTO canvas_directory (canvas_id, workspace_id, title, created_by_user_id, created_at, updated_at,
         visibility, authority_generation) VALUES (?, ?, 'Q4 board', ?, 0, 0, 'creator', 1)`,
      CANVAS, WORKSPACE_ID, USER_ID,
    );
    state.storage.sql.exec(
      `INSERT INTO automation_directory (automation_id, workspace_id, author_user_id, source_version, payload_hash,
         lifecycle, scope, owning_workstream_id, title, description, next_run_at, projected_at)
       VALUES (?, ?, ?, 1, 'h', 'active', 'workspace', NULL, 'Nightly', '', NULL, 0)`,
      SIDEKICK, WORKSPACE_ID, USER_ID,
    );
    // A pending email share of Thread A. The invitation names its operation by
    // a foreign key with no ON DELETE, so the sweep has to remove both rows.
    state.storage.sql.exec(`INSERT INTO parent_invitation_operations (parent_id, operation_id, request_json, invitation_ids_json)
      VALUES (?, 'share-1', '{}', '["invitation-1"]')`, THREAD_A);
    state.storage.sql.exec(`INSERT INTO parent_invitations (parent_id, id, operation_id, actor_user_id, actor_incarnation,
        summary_json, token_hash, delivery_encrypted, grant_operations_json, created_at)
      VALUES (?, 'invitation-1', 'share-1', ?, 'existing-member', '{}', 'token-hash-1', 'sealed', '[]', 0)`, THREAD_A, USER_ID);
    // Made in a Thread, kept after it: resources outlive the conversation that made them.
    state.storage.sql.exec(`INSERT INTO resources (id, workspace_id, resource_type, provider, title, mime_type,
        metadata_json, uploaded_by_user_id, attachment_status, created_at, updated_at)
      VALUES (?, ?, 'document', 'avalon_upload', 'launch.md', 'text/markdown', '{}', ?, 'attached',
        '2026-11-07T09:00:00.000Z', '2026-11-07T09:00:00.000Z')`, RESOURCE, WORKSPACE_ID, USER_ID);
  });
  await seedConversation(THREAD_A, "workstream", "0", ["Ship it Friday?", "Friday works."]);
  await seedConversation(THREAD_A, "workstream", BREAKOUT, ["Draft the post."]);
  await seedConversation(THREAD_B, "workstream", "0", ["Two offers out."]);
  await seedConversation(CHANNEL, "space", "0", ["Welcome to Marketing."]);
  await seedConversation(CANVAS, "canvas", "0", ["Make the board."]);
}

/** Spaces the Organization opened for itself (General), beside the one seeded here. */
async function otherSpaceIds(): Promise<string[]> {
  return runInDurableObject(organization(), (_instance, state) => state.storage.sql.exec<{ space_id: string }>(
    "SELECT space_id FROM spaces WHERE space_id <> ? ORDER BY space_id", CHANNEL,
  ).toArray().map((row) => row.space_id));
}

async function dumpedKeys(): Promise<string[]> {
  const listed = await TEST_ENV.PAYLOADS.list({ prefix: `retired-conversations/${WORKSPACE_ID}/` });
  return listed.objects.map((object) => object.key).sort();
}

async function dumpedText(parentId: string, substreamId = "0"): Promise<string | null> {
  const object = await TEST_ENV.PAYLOADS.get(`retired-conversations/${WORKSPACE_ID}/${parentId}/${substreamId}.txt`);
  return object ? object.text() : null;
}

beforeEach(async () => {
  await reset();
  await seedInspectableWorkspace(TEST_ENV.DB, { workspaceId: WORKSPACE_ID, userId: USER_ID, sessionId: SESSION_ID, at: "2026-11-07T09:00:00.000Z" });
  await organization().initializeWorkspace(WORKSPACE_ID, "wnam");
  await ensureAuditSchema();
  await seedOrganization();
  const listed = await TEST_ENV.PAYLOADS.list({ prefix: `retired-conversations/${WORKSPACE_ID}/` });
  if (listed.objects.length) await TEST_ENV.PAYLOADS.delete(listed.objects.map((object) => object.key));
});

describe("dump_thread_transcripts", () => {
  it("writes every Thread, Breakout and Channel conversation as text under its key, and never a Canvas's", async () => {
    const general = await otherSpaceIds();
    const result = await bridge().dumpThreadTranscripts({ orgId: WORKSPACE_ID, confirm: WORKSPACE_ID }, OPERATOR);

    expect(result).toMatchObject({ region: "global", orgId: WORKSPACE_ID, skipped: 0, failed: [] });
    expect(result.dumped).toBe(4 + general.length);
    expect(await dumpedKeys()).toEqual([
      `retired-conversations/${WORKSPACE_ID}/${THREAD_A}/0.txt`,
      `retired-conversations/${WORKSPACE_ID}/${THREAD_A}/${BREAKOUT}.txt`,
      `retired-conversations/${WORKSPACE_ID}/${THREAD_B}/0.txt`,
      `retired-conversations/${WORKSPACE_ID}/${CHANNEL}/0.txt`,
      ...general.map((spaceId) => `retired-conversations/${WORKSPACE_ID}/${spaceId}/0.txt`),
    ].sort());
    expect(await dumpedText(THREAD_A)).toBe(
      "Test user · 2026-11-07T09:00:00.000Z\nShip it Friday?\n\nTest user · 2026-11-07T09:00:01.000Z\nFriday works.",
    );
    expect(await dumpedText(THREAD_A, BREAKOUT)).toBe("Test user · 2026-11-07T09:00:00.000Z\nDraft the post.");
    expect(await dumpedText(THREAD_B)).toBe("Test user · 2026-11-07T09:00:00.000Z\nTwo offers out.");
    expect(await dumpedText(CHANNEL)).toBe("Test user · 2026-11-07T09:00:00.000Z\nWelcome to Marketing.");
    expect(await dumpedText(CANVAS)).toBeNull();
    expect(await dumpedText(SIDEKICK)).toBeNull();
  });

  it("reads a Thread's conversation that every product read still refuses by name", async () => {
    // Inside the object: a rejection over a stub is reported again as unhandled.
    const readerAudience = async () => runInDurableObject(await conversation(THREAD_A), (instance: AgentLoopDO) =>
      instance.readerAudience({ workspaceId: WORKSPACE_ID, workstreamId: THREAD_A }));
    await expect(readerAudience()).rejects.toThrow("conversation_parent_kind_retired:workstream");
    const result = await bridge().dumpThreadTranscripts({ orgId: WORKSPACE_ID, confirm: WORKSPACE_ID }, OPERATOR);
    expect(result.failed).toEqual([]);
    expect(await dumpedText(THREAD_A)).toBe(
      "Test user · 2026-11-07T09:00:00.000Z\nShip it Friday?\n\nTest user · 2026-11-07T09:00:01.000Z\nFriday works.",
    );
    await expect(readerAudience()).rejects.toThrow("conversation_parent_kind_retired:workstream");
  });

  it("writes nothing new on a rerun, even when a conversation moved since", async () => {
    await bridge().dumpThreadTranscripts({ orgId: WORKSPACE_ID, confirm: WORKSPACE_ID }, OPERATOR);
    const first = await TEST_ENV.PAYLOADS.head(`retired-conversations/${WORKSPACE_ID}/${THREAD_B}/0.txt`);
    await runInDurableObject(await conversation(THREAD_B), (_instance, state) => seedParticipantMessage(state, {
      id: "late", sequence: 2, text: "A late reply.", now: AT + 5_000,
    }));

    const rerun = await bridge().dumpThreadTranscripts({ orgId: WORKSPACE_ID, confirm: WORKSPACE_ID }, OPERATOR);

    expect(rerun.dumped).toBe(0);
    expect(rerun.skipped).toBe(rerun.conversations);
    expect(await dumpedText(THREAD_B)).toBe("Test user · 2026-11-07T09:00:00.000Z\nTwo offers out.");
    const second = await TEST_ENV.PAYLOADS.head(`retired-conversations/${WORKSPACE_ID}/${THREAD_B}/0.txt`);
    expect(second?.etag).toBe(first?.etag);
  });

  it("refuses a confirmation that names another Organization and writes nothing", async () => {
    await expect(bridge().dumpThreadTranscripts(
      { orgId: WORKSPACE_ID, confirm: "00000000-0000-7000-8000-00000000b7ff" }, OPERATOR,
    )).rejects.toThrow("engineering_operation_failed:thread_retirement_unconfirmed");
    expect(await dumpedKeys()).toEqual([]);
  });
});

/** What is left of each seeded thing after a pass, read from the objects themselves. */
async function survivors() {
  const rows = await runInDurableObject(organization(), (_instance, state) => {
    const count = (statement: string, ...bindings: string[]) =>
      state.storage.sql.exec<{ count: number }>(statement, ...bindings).one().count;
    const ids = [THREAD_A, THREAD_B, CHANNEL];
    return {
      threads: count("SELECT COUNT(*) AS count FROM channels"),
      channel: count("SELECT COUNT(*) AS count FROM spaces WHERE space_id = ?", CHANNEL),
      parentState: count(`SELECT (SELECT COUNT(*) FROM parent_metadata WHERE parent_id IN (?, ?, ?))
        + (SELECT COUNT(*) FROM parent_children WHERE parent_id IN (?, ?, ?)) AS count`, ...ids, ...ids),
      invitations: count(`SELECT (SELECT COUNT(*) FROM parent_invitations WHERE parent_id = ?)
        + (SELECT COUNT(*) FROM parent_invitation_operations WHERE parent_id = ?) AS count`, THREAD_A, THREAD_A),
      canvas: count("SELECT COUNT(*) AS count FROM canvas_directory WHERE canvas_id = ?", CANVAS),
      sidekick: count("SELECT COUNT(*) AS count FROM automation_directory WHERE automation_id = ?", SIDEKICK),
      resource: count("SELECT COUNT(*) AS count FROM resources WHERE id = ?", RESOURCE),
    };
  });
  const retired = async (parentId: string, substreamId = "0") =>
    (await (await conversation(parentId, substreamId)).objectRetirementState()).retired;
  return {
    ...rows,
    retired: {
      threadA: await retired(THREAD_A), breakout: await retired(THREAD_A, BREAKOUT),
      threadB: await retired(THREAD_B), channel: await retired(CHANNEL), canvas: await retired(CANVAS),
    },
  };
}

describe("retire_threads", () => {
  it("is refused before the dump, and touches nothing", async () => {
    await expect(bridge().retireThreads({ orgId: WORKSPACE_ID, confirm: WORKSPACE_ID }, OPERATOR))
      .rejects.toThrow("engineering_operation_failed:thread_retirement_dump_incomplete");
    expect(await survivors()).toEqual({
      threads: 2, channel: 1, parentState: 7, invitations: 2, canvas: 1, sidekick: 1, resource: 1,
      retired: { threadA: false, breakout: false, threadB: false, channel: false, canvas: false },
    });
  });

  it("after the dump, retires every Thread, Breakout and Channel conversation and deletes their rows, leaving Canvases, Sidekicks and resources", async () => {
    const general = await otherSpaceIds();
    await bridge().dumpThreadTranscripts({ orgId: WORKSPACE_ID, confirm: WORKSPACE_ID }, OPERATOR);

    const result = await bridge().retireThreads({ orgId: WORKSPACE_ID, confirm: WORKSPACE_ID }, OPERATOR);

    expect(result).toMatchObject({ region: "global", orgId: WORKSPACE_ID, failed: [] });
    expect(result.retiredParents).toBe(3 + general.length);
    expect(result.retiredConversations).toBe(4 + general.length);
    expect(await survivors()).toEqual({
      threads: 0, channel: 0, parentState: 0, invitations: 0, canvas: 1, sidekick: 1, resource: 1,
      retired: { threadA: true, breakout: true, threadB: true, channel: true, canvas: false },
    });
    // The dump is still the copy.
    expect(await dumpedText(THREAD_B)).toBe("Test user · 2026-11-07T09:00:00.000Z\nTwo offers out.");
  });

  it("is a no-op on a rerun", async () => {
    await bridge().dumpThreadTranscripts({ orgId: WORKSPACE_ID, confirm: WORKSPACE_ID }, OPERATOR);
    await bridge().retireThreads({ orgId: WORKSPACE_ID, confirm: WORKSPACE_ID }, OPERATOR);
    const first = await (await conversation(THREAD_A)).objectRetirementState();

    const rerun = await bridge().retireThreads({ orgId: WORKSPACE_ID, confirm: WORKSPACE_ID }, OPERATOR);

    expect(rerun).toMatchObject({ parents: 0, conversations: 0, retiredParents: 0, retiredConversations: 0, failed: [] });
    expect((await (await conversation(THREAD_A)).objectRetirementState()).retiredAt).toBe(first.retiredAt);
  });
});

describe("retire_threads beside the Thread conversion", () => {
  it("is refused while a Thread with an artifact is unconverted, and touches nothing", async () => {
    await runInDurableObject(organization(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO artifact_registry
          (artifact_id, workspace_id, resource_id, workstream_id, mode, stateful, current_version, manifest_ref, created_at, updated_at)
        VALUES ('artifact-b', ?, ?, ?, 'static', 0, 1, 'manifest', 0, 0)`, WORKSPACE_ID, RESOURCE, THREAD_B);
    });
    await bridge().dumpThreadTranscripts({ orgId: WORKSPACE_ID, confirm: WORKSPACE_ID }, OPERATOR);

    await expect(bridge().retireThreads({ orgId: WORKSPACE_ID, confirm: WORKSPACE_ID }, OPERATOR))
      .rejects.toThrow("engineering_operation_failed:thread_retirement_conversion_pending");
    expect(await survivors()).toEqual({
      threads: 2, channel: 1, parentState: 7, invitations: 2, canvas: 1, sidekick: 1, resource: 1,
      retired: { threadA: false, breakout: false, threadB: false, channel: false, canvas: false },
    });
  });

  it("never dumps or retires the Chat of a Canvas a partly failed conversion left beside its Thread's rows", async () => {
    // What a conversion that stopped after its first two steps leaves: the
    // Canvas row, a Main of kind `canvas`, and the Thread's rows still there.
    await runInDurableObject(organization(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO canvas_directory (canvas_id, workspace_id, title, created_by_user_id, created_at, updated_at,
           visibility, authority_generation) VALUES (?, ?, 'Hiring', ?, 0, 0, 'workspace', 1)`,
        THREAD_B, WORKSPACE_ID, USER_ID,
      );
    });
    await runInDurableObject(await conversation(THREAD_B), (_instance, state) => {
      state.storage.sql.exec("UPDATE workstream SET parent_kind = 'canvas' WHERE id = 1");
    });

    const dump = await bridge().dumpThreadTranscripts({ orgId: WORKSPACE_ID, confirm: WORKSPACE_ID }, OPERATOR);
    const result = await bridge().retireThreads({ orgId: WORKSPACE_ID, confirm: WORKSPACE_ID }, OPERATOR);

    expect(dump.failed).toEqual([]);
    expect(await dumpedText(THREAD_B)).toBeNull();
    expect(result.failed).toEqual([]);
    expect((await survivors()).retired).toEqual({ threadA: true, breakout: true, threadB: false, channel: true, canvas: false });
  });
});

describe("a conversation the dump refuses", () => {
  it.each([
    ["thread_transcript_identity_mismatch", "UPDATE workstream SET workstream_key = ? WHERE id = 1", "00000000-0000-7000-8000-00000000b7aa"],
    ["thread_transcript_parent_kind_refused", "UPDATE workstream SET parent_kind = ? WHERE id = 1", "canvas"],
  ])("is reported as %s, left unwritten, and keeps the retirement refused", async (code, statement, value) => {
    await runInDurableObject(await conversation(THREAD_B), (_instance, state) => {
      state.storage.sql.exec(statement, value);
    });

    const dump = await bridge().dumpThreadTranscripts({ orgId: WORKSPACE_ID, confirm: WORKSPACE_ID }, OPERATOR);

    expect(dump.failed).toEqual([{ parentKind: "workstream", parentId: THREAD_B, substreamId: "0", error: code }]);
    expect(await dumpedText(THREAD_B)).toBeNull();
    await expect(bridge().retireThreads({ orgId: WORKSPACE_ID, confirm: WORKSPACE_ID }, OPERATOR))
      .rejects.toThrow("engineering_operation_failed:thread_retirement_dump_incomplete");
    expect(await survivors()).toEqual({
      threads: 2, channel: 1, parentState: 7, invitations: 2, canvas: 1, sidekick: 1, resource: 1,
      retired: { threadA: false, breakout: false, threadB: false, channel: false, canvas: false },
    });
  });
});

describe("a Thread's object before its retirement", () => {
  it("clears a due wake reason's alarm without running a lane, and keeps the row for the retirement", async () => {
    const thread = await conversation(THREAD_A);
    await runInDurableObject(thread, async (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO memory_sweep_state
        (id, swept_through_seq, rest_until, consecutive_quiet, claim_attempt, retry_at, version, created_at, updated_at)
        VALUES (1, 0, 0, 0, 0, 1, 1, 0, 0)`);
      // Ahead of now, so workerd does not fire it before the test does.
      await state.storage.setAlarm(Date.now() + 3_600_000);
    });
    // The sweep lane reads the hosted identity, which refuses a Thread: run
    // here, it would throw on every pass.
    expect(await runDurableObjectAlarm(thread)).toBe(true);
    await runInDurableObject(thread, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
      expect(state.storage.sql.exec(`SELECT retry_at FROM memory_sweep_state`).toArray()).toEqual([{ retry_at: 1 }]);
    });
  });
});

