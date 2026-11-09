/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Converting a Thread that has artifacts into a Canvas in place, on real
 * objects: the dry run, the dump guard it shares with the retirement, the
 * conversion itself, its rerun, and a Thread it cannot convert.
 *
 * The Organization holds its Threads the way production does after the
 * cutover: `channels` and `channel_viewers` rows, a resource the Thread made
 * (`artifact_registry`) and one it linked
 * (`workspace_workstream_resource_links`), and `AgentLoopDO` conversation
 * objects whose stored parent kind is `workstream`, reached by the names
 * production derives, with their transcripts written through the transcript
 * owner.
 */

import { env } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asSubstreamId, asUserId, asWorkspaceId } from "@rally/contracts";

import type { AgentLoopDO } from "../src/durable-objects/agent-loop-do";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import { EngineeringInspectionBridge } from "../src/engineering-inspection-bridge";
import type { Env } from "../src/env";
import { durableObjectStubForWorkspace } from "../src/lib/durable-object-namespace";
import { AuthorizationService } from "../src/services/authorization-service";
import { ensureAuditSchema } from "./helpers/audit-fixture";
import { seedInspectableWorkspace } from "./helpers/engineering-inspection-fixture";
import { insertChannelRow } from "./helpers/hosted-parent";
import { seedParticipantMessage, seedWorkstreamRoot } from "./helpers/substream-fixture";

const TEST_ENV: Env = env;
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000c801");
const USER_ID = asUserId("00000000-0000-7000-8000-00000000c802");
const VIEWER = asUserId("00000000-0000-7000-8000-00000000c803");
/** Listed a Workspace-scoped Thread without taking part in it. */
const LURKER = asUserId("00000000-0000-7000-8000-00000000c805");
const SESSION_ID = "00000000-0000-7000-8000-00000000c804";
/** Personal, with a Breakout, an artifact it made and one it linked. */
const THREAD = "00000000-0000-7000-8000-00000000c811";
const BREAKOUT = "00000000-0000-7000-8000-00000000c812";
/** Has an artifact, but names no creator and has no viewers. */
const ORPHAN_THREAD = "00000000-0000-7000-8000-00000000c813";
/** No artifact: retired later, never converted. */
const PLAIN_THREAD = "00000000-0000-7000-8000-00000000c814";
/** Workspace-scoped, with a participant and a viewer who only listed it. */
const WORKSPACE_THREAD = "00000000-0000-7000-8000-00000000c816";
/** A conversation no row names any more, whose artifact the Thread linked. */
const GONE = "00000000-0000-7000-8000-00000000c815";
const MADE = "00000000-0000-7000-8000-00000000c821";
const LINKED = "00000000-0000-7000-8000-00000000c822";
const ORPHAN_MADE = "00000000-0000-7000-8000-00000000c823";
const WORKSPACE_MADE = "00000000-0000-7000-8000-00000000c824";
const SIDEKICK = "00000000-0000-7000-8000-00000000c831";
const OPERATOR = { subject: "access-engineer", email: "engineer@example.com", audience: "engineering-mcp" };
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

/** A Thread's conversation object, as the cutover left it: kind `workstream`, these messages one second apart. */
async function seedConversation(parentId: string, substreamId: string, title: string, messages: string[]): Promise<void> {
  await runInDurableObject(await conversation(parentId, substreamId), async (_instance, state) => {
    seedWorkstreamRoot(state, AT, { workspaceId: WORKSPACE_ID, workstreamId: parentId });
    // A Thread's directory row projects its object's title, so the two agree.
    state.storage.sql.exec("UPDATE workstream SET parent_kind = 'workstream', title = ? WHERE id = 1", title);
    state.storage.sql.exec("UPDATE substream_agent_identity SET external_substream_id = ? WHERE id = 1", substreamId);
    for (const [index, text] of messages.entries()) {
      await seedParticipantMessage(state, { id: `${parentId}:${substreamId}:${index}`, sequence: index + 1, text, now: AT + index * 1_000 });
    }
  });
}

function insertResource(state: DurableObjectState, id: string, title: string): void {
  state.storage.sql.exec(`INSERT INTO resources (id, workspace_id, resource_type, provider, title, mime_type,
      metadata_json, uploaded_by_user_id, attachment_status, created_at, updated_at)
    VALUES (?, ?, 'generated_site', 'avalon_upload', ?, 'text/html', '{}', ?, 'attached',
      '2026-11-07T09:00:00.000Z', '2026-11-07T09:00:00.000Z')`, id, WORKSPACE_ID, title, USER_ID);
}

function insertArtifact(state: DurableObjectState, resourceId: string, workstreamId: string): void {
  state.storage.sql.exec(`INSERT INTO artifact_registry
      (artifact_id, workspace_id, resource_id, workstream_id, mode, stateful, current_version, manifest_ref, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'static', 0, 1, 'manifest', ?, ?)`, crypto.randomUUID(), WORKSPACE_ID, resourceId, workstreamId, AT, AT);
}

function insertViewer(state: DurableObjectState, workstreamId: string, userId: string, addedAt: number, participant = true): void {
  state.storage.sql.exec(`INSERT INTO channel_viewers
      (workstream_id, user_id, authority_generation, waterline, source_event_id, payload_hash, is_participant,
       unread_count, you_are_mentioned, listable, seen_attention_ordinal, manual_unread_from_ordinal,
       manual_unread_generation, latest_mention_attention_ordinal, projected_at, participant_added_at)
    VALUES (?, ?, 1, 1, ?, 'hash', ?, 0, 0, 1, 0, NULL, 0, 0, ?, ?)`,
  workstreamId, userId, `viewer:${workstreamId}:${userId}`, participant ? 1 : 0, addedAt, addedAt);
}

async function seedOrganization(): Promise<void> {
  await runInDurableObject(organization(), (_instance, state) => {
    insertChannelRow(state, THREAD, "Launch plan", "personal");
    state.storage.sql.exec(`UPDATE channels SET created_by_user_id = ?, source_created_at = ?, last_activity_at = ?
      WHERE workstream_id = ?`, USER_ID, AT, AT + 60_000, THREAD);
    insertChannelRow(state, ORPHAN_THREAD, "Nobody's", "workspace");
    insertChannelRow(state, PLAIN_THREAD, "Hiring", "workspace");
    insertChannelRow(state, WORKSPACE_THREAD, "Roadmap", "workspace");
    state.storage.sql.exec(`UPDATE channels SET created_by_user_id = ? WHERE workstream_id = ?`, USER_ID, WORKSPACE_THREAD);
    insertViewer(state, WORKSPACE_THREAD, VIEWER, AT);
    insertViewer(state, WORKSPACE_THREAD, LURKER, AT, false);
    insertViewer(state, THREAD, USER_ID, AT);
    insertViewer(state, THREAD, VIEWER, AT + 1_000);
    state.storage.sql.exec(`INSERT INTO breakouts (workstream_id, substream_id, authority_generation, waterline,
        source_event_id, payload_hash, title, description, scope, exact_state, title_status, created_by_user_id,
        last_activity_at, latest_attention_ordinal, unread_tracking_start_ordinal, source_created_at, source_updated_at, projected_at)
      VALUES (?, ?, 1, 1, 'breakout-1', 'hash', 'Draft', '', 'personal', 'idle', 'settled', ?, 0, 0, 0, 0, 0, 0)`,
    THREAD, BREAKOUT, USER_ID);
    insertResource(state, MADE, "launch.html");
    insertResource(state, LINKED, "pricing.html");
    insertResource(state, ORPHAN_MADE, "orphan.html");
    insertResource(state, WORKSPACE_MADE, "roadmap.html");
    insertArtifact(state, WORKSPACE_MADE, WORKSPACE_THREAD);
    insertArtifact(state, MADE, THREAD);
    insertArtifact(state, LINKED, GONE);
    insertArtifact(state, ORPHAN_MADE, ORPHAN_THREAD);
    state.storage.sql.exec(`INSERT INTO workspace_workstream_resource_links
        (workstream_id, resource_id, watch_enabled, relationship_type, authority_generation, waterline, source_event_id, projected_at)
      VALUES (?, ?, 0, 'attached', 1, 1, 'link-1', ?)`, THREAD, LINKED, AT + 2_000);
    // What other tables key on the Thread's Main as a Thread's.
    state.storage.sql.exec(`INSERT INTO memory_facts (fact_id, workspace_id, subject_kind, subject_id, kind, text,
        derived_from, source_conversations_json, created_by, created_at, updated_at)
      VALUES ('fact-launch', ?, 'thread', ?, 'standing', 'Launch is on Friday.', 'person', json_array(?), 'agent', 0, 0)`,
    WORKSPACE_ID, THREAD, THREAD);
    state.storage.sql.exec(`INSERT INTO authorization_locations (parent_id, substream_id, parent_kind, resource_id)
      VALUES (?, '0', 'workstream', ?)`, THREAD, MADE);
    state.storage.sql.exec(`INSERT INTO sidekick_conversation_attachments
        (automation_id, parent_kind, parent_id, substream_id, attached_by_user_id, attached_at)
      VALUES (?, 'workstream', ?, '0', ?, 0), (?, 'workstream', ?, ?, ?, 0)`,
    SIDEKICK, THREAD, USER_ID, SIDEKICK, THREAD, BREAKOUT, USER_ID);
  });
  await seedConversation(THREAD, "0", "Launch plan", ["Ship it Friday?", "Friday works."]);
  await seedConversation(THREAD, BREAKOUT, "Draft", ["Draft the post."]);
  await seedConversation(ORPHAN_THREAD, "0", "Nobody's", ["Anyone?"]);
  await seedConversation(PLAIN_THREAD, "0", "Hiring", ["Two offers out."]);
  await seedConversation(WORKSPACE_THREAD, "0", "Roadmap", ["Q1 first."]);
}

const dryRun = () => bridge().convertThreadsToCanvases({ orgId: WORKSPACE_ID }, OPERATOR);
const apply = () => bridge().convertThreadsToCanvases({ orgId: WORKSPACE_ID, dryRun: false, confirm: WORKSPACE_ID }, OPERATOR);
const dump = () => bridge().dumpThreadTranscripts({ orgId: WORKSPACE_ID, confirm: WORKSPACE_ID }, OPERATOR);

/** The Organization's rows for the converted Thread, read from the object. */
async function organizationRows() {
  return runInDurableObject(organization(), (_instance, state) => {
    const rows = (statement: string, ...bindings: string[]) => state.storage.sql.exec(statement, ...bindings).toArray();
    return {
      canvases: rows("SELECT canvas_id, title, visibility, created_by_user_id, created_at, updated_at FROM canvas_directory ORDER BY canvas_id"),
      threads: rows("SELECT workstream_id FROM channels ORDER BY workstream_id"),
      viewers: rows("SELECT user_id FROM channel_viewers WHERE workstream_id = ?", THREAD),
      breakouts: rows("SELECT substream_id FROM breakouts"),
      links: rows("SELECT resource_id FROM workspace_workstream_resource_links"),
      factSources: rows("SELECT source_conversations_json AS sources FROM memory_facts WHERE fact_id = 'fact-launch'"),
      locations: rows("SELECT parent_kind FROM authorization_locations WHERE parent_id = ? AND resource_id = ?", THREAD, MADE),
      attachments: rows("SELECT parent_kind, substream_id FROM sidekick_conversation_attachments ORDER BY substream_id"),
    };
  });
}

async function storedParentKind(parentId: string): Promise<string> {
  return runInDurableObject(await conversation(parentId), (_instance, state) =>
    state.storage.sql.exec<{ parent_kind: string }>("SELECT parent_kind FROM workstream WHERE id = 1").one().parent_kind);
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

describe("convert_threads_to_canvases", () => {
  it("lists every Thread with an artifact on a dry run, and writes nothing", async () => {
    const before = await organizationRows();

    const result = await dryRun();

    expect(result).toEqual({
      region: "global", orgId: WORKSPACE_ID, dryRun: true,
      candidates: [
        { threadId: THREAD, title: "Launch plan", artifactCount: 1, linkedArtifactCount: 1, participantCount: 2, conversations: 2, undumped: 2 },
        { threadId: ORPHAN_THREAD, title: "Nobody's", artifactCount: 1, linkedArtifactCount: 0, participantCount: 0, conversations: 1, undumped: 1 },
        { threadId: WORKSPACE_THREAD, title: "Roadmap", artifactCount: 1, linkedArtifactCount: 0, participantCount: 1, conversations: 1, undumped: 1 },
      ],
      converted: 0, alreadyConverted: 0, failed: [], artifactsWithoutThread: 1,
    });
    expect(await organizationRows()).toEqual(before);
    expect(await storedParentKind(THREAD)).toBe("workstream");
  });

  it("is refused before the dump, and touches nothing", async () => {
    const before = await organizationRows();
    await expect(apply()).rejects.toThrow("engineering_operation_failed:thread_retirement_dump_incomplete");
    expect(await organizationRows()).toEqual(before);
    expect(await storedParentKind(THREAD)).toBe("workstream");
  });

  it("after the dump, makes the Thread a Canvas that keeps its id, its people, its artifacts and its Chat", async () => {
    await dump();

    const result = await apply();

    // The linked artifact is the Canvas's now, so no artifact is left without one.
    expect(result).toMatchObject({ dryRun: false, converted: 2, alreadyConverted: 0, artifactsWithoutThread: 0,
      failed: [{ threadId: ORPHAN_THREAD, substreamId: null, error: "thread_conversion_no_creator" }] });
    const detail = await organization().canvasDetail({ workspaceId: WORKSPACE_ID, canvasId: THREAD,
      actor: { userId: VIEWER, actorRole: "member" } });
    expect(detail).toMatchObject({
      id: THREAD, title: "Launch plan", createdByUserId: USER_ID, visibility: "participants",
      createdAt: "2026-11-07T09:00:00.000Z", updatedAt: "2026-11-07T09:01:00.000Z", participantUserIds: [VIEWER],
    });
    expect(detail.artifacts.map((artifact) => artifact.resourceId).sort()).toEqual([MADE, LINKED].sort());
    // The Chat is the Thread's Main, read through the Canvas's own path.
    expect((await bridge().readConversation({ orgId: WORKSPACE_ID, userId: USER_ID, kind: "canvas", conversationId: THREAD })).text)
      .toBe("Canvas: Launch plan\n\nTest user · 2026-11-07T09:00:00.000Z\nShip it Friday?\n\nTest user · 2026-11-07T09:00:01.000Z\nFriday works.");
    expect(await storedParentKind(THREAD)).toBe("canvas");
    await runInDurableObject(await conversation(THREAD), async (instance: AgentLoopDO) => {
      await expect(instance.readerAudience({ workspaceId: WORKSPACE_ID, workstreamId: THREAD })).resolves.not.toBeNull();
    });
    expect((await (await conversation(THREAD, BREAKOUT)).objectRetirementState()).retired).toBe(true);
    expect((await (await conversation(THREAD)).objectRetirementState()).retired).toBe(false);
    const rows = await organizationRows();
    expect(rows).toMatchObject({
      threads: [{ workstream_id: ORPHAN_THREAD }, { workstream_id: PLAIN_THREAD }],
      viewers: [], breakouts: [], links: [],
      factSources: [{ sources: JSON.stringify([`canvas:${THREAD}`]) }],
      locations: [{ parent_kind: "canvas" }],
      attachments: [{ parent_kind: "canvas", substream_id: "0" }],
    });
    // A Workspace-scoped Thread's participants are kept, and not who only listed it.
    expect(await organization().canvasDetail({ workspaceId: WORKSPACE_ID, canvasId: WORKSPACE_THREAD,
      actor: { userId: LURKER, actorRole: "member" } })).toMatchObject({ visibility: "workspace", participantUserIds: [VIEWER] });
    // The Thread it could not convert is left for the operator, untouched.
    expect(await storedParentKind(ORPHAN_THREAD)).toBe("workstream");
  });

  it("finishes a pass interrupted after the Canvas's rows, and reruns over nothing once done", async () => {
    await dump();
    await organization().convertThreadToCanvas({ workspaceId: WORKSPACE_ID, threadId: THREAD, title: "Launch plan" });

    const resumed = await apply();

    expect(resumed).toMatchObject({ converted: 1, alreadyConverted: 1 });
    expect(await storedParentKind(THREAD)).toBe("canvas");
    const done = await organizationRows();

    const rerun = await apply();

    expect(rerun).toMatchObject({ candidates: [{ threadId: ORPHAN_THREAD }], converted: 0, alreadyConverted: 0,
      failed: [{ threadId: ORPHAN_THREAD, error: "thread_conversion_no_creator" }] });
    expect(await organizationRows()).toEqual(done);
  });
});

/** One email share keyed by `parentId`: an invitation, its operation, and the grant a claim wrote. */
function insertShare(state: DurableObjectState, parentId: string, name: string, userId: string): void {
  state.storage.sql.exec(`INSERT INTO parent_invitation_operations (parent_id, operation_id, request_json, invitation_ids_json)
    VALUES (?, ?, '{}', json_array(?))`, parentId, `${name}-operation`, `${name}-invitation`);
  state.storage.sql.exec(`INSERT INTO parent_invitations (parent_id, id, operation_id, actor_user_id, actor_incarnation,
      summary_json, token_hash, delivery_encrypted, grant_operations_json, created_at)
    VALUES (?, ?, ?, ?, 'existing-member', '{}', ?, 'sealed', '[]', 0)`,
  parentId, `${name}-invitation`, `${name}-operation`, USER_ID, `${name}-token-hash`);
  state.storage.sql.exec(`INSERT INTO parent_grants (parent_id, user_id, scope_kind, substream_id, grant_json)
    VALUES (?, ?, 'workstream', '', '{}')`, parentId, userId);
}

async function shareRows(parentId: string) {
  return runInDurableObject(organization(), (_instance, state) => ({
    invitations: state.storage.sql.exec("SELECT id FROM parent_invitations WHERE parent_id = ? ORDER BY id", parentId).toArray(),
    operations: state.storage.sql.exec("SELECT operation_id FROM parent_invitation_operations WHERE parent_id = ? ORDER BY operation_id", parentId).toArray(),
    grants: state.storage.sql.exec("SELECT user_id FROM parent_grants WHERE parent_id = ? ORDER BY user_id", parentId).toArray(),
  }));
}

const MADE_IN_BREAKOUT = "00000000-0000-7000-8000-00000000c825";
const BREAKOUT_FILE = "00000000-0000-7000-8000-00000000c826";

describe("an artifact a Thread published only in a Breakout", () => {
  it("is carried into the Chat, so every Canvas reader opens it once the Breakout is retired", async () => {
    // VIEWER takes part in the personal Thread but did not upload the artifact.
    await TEST_ENV.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', '2026-11-07T09:00:00.000Z')`).bind(WORKSPACE_ID, VIEWER).run();
    await runInDurableObject(organization(), (_instance, state) => {
      insertResource(state, MADE_IN_BREAKOUT, "draft.html");
      insertResource(state, BREAKOUT_FILE, "notes.html");
      insertArtifact(state, MADE_IN_BREAKOUT, THREAD);
      state.storage.sql.exec(`INSERT INTO authorization_locations (parent_id, substream_id, parent_kind, resource_id)
        VALUES (?, ?, 'workstream', ?), (?, ?, 'workstream', ?)`, THREAD, BREAKOUT, MADE_IN_BREAKOUT, THREAD, BREAKOUT, BREAKOUT_FILE);
    });
    await runInDurableObject(await conversation(THREAD, BREAKOUT), (_instance, state) => {
      for (const resourceId of [MADE_IN_BREAKOUT, BREAKOUT_FILE]) {
        state.storage.sql.exec(`INSERT INTO workstream_resource_links
            (resource_id, attached_by_user_id, watch_enabled, relationship_type, resource_json, attached_at, updated_at)
          VALUES (?, ?, 0, 'attachment', json_object('id', ?), ?, ?)`, resourceId, USER_ID, resourceId, AT, AT);
      }
    });
    const opens = async () => (await new AuthorizationService(TEST_ENV).checkMany(
      { workspaceId: WORKSPACE_ID, userId: VIEWER, delegation: null },
      [{ kind: "resource", workspaceId: WORKSPACE_ID, resourceId: MADE_IN_BREAKOUT }],
    ))[0]?.status;
    await dump();

    const result = await apply();

    expect(result.failed).toEqual([{ threadId: ORPHAN_THREAD, substreamId: null, error: "thread_conversion_no_creator" }]);
    expect((await (await conversation(THREAD, BREAKOUT)).objectRetirementState()).retired).toBe(true);
    expect(await opens()).toBe("allowed");
    // Only the Canvas's artifacts move; a file the Breakout attached stays with it.
    const chatLinks = await runInDurableObject(await conversation(THREAD), (_instance, state) => state.storage.sql.exec<{ resource_id: string }>(
      "SELECT resource_id FROM workstream_resource_links ORDER BY resource_id").toArray().map((row) => row.resource_id));
    expect(chatLinks).toEqual([MADE_IN_BREAKOUT]);

    // A pass interrupted before its sweep left the Thread's rows, with the
    // Breakout already retired: the resume skips it and still finishes.
    await runInDurableObject(organization(), (_instance, state) => {
      insertChannelRow(state, THREAD, "Launch plan", "personal");
      state.storage.sql.exec("UPDATE channels SET created_by_user_id = ? WHERE workstream_id = ?", USER_ID, THREAD);
      state.storage.sql.exec(`INSERT INTO breakouts (workstream_id, substream_id, authority_generation, waterline,
          source_event_id, payload_hash, title, description, scope, exact_state, title_status, created_by_user_id,
          last_activity_at, latest_attention_ordinal, unread_tracking_start_ordinal, source_created_at, source_updated_at, projected_at)
        VALUES (?, ?, 1, 1, 'breakout-1', 'hash', 'Draft', '', 'personal', 'idle', 'settled', ?, 0, 0, 0, 0, 0, 0)`,
      THREAD, BREAKOUT, USER_ID);
    });
    expect(await apply()).toMatchObject({ alreadyConverted: 1, failed: [{ threadId: ORPHAN_THREAD }] });
    expect(await opens()).toBe("allowed");
  });
});

describe("a converted Thread's shares", () => {
  it("drops the Thread's before the Canvas exists, and keeps the Canvas's through a resumed pass", async () => {
    await runInDurableObject(organization(), (_instance, state) => insertShare(state, THREAD, "thread", VIEWER));
    await dump();
    await organization().convertThreadToCanvas({ workspaceId: WORKSPACE_ID, threadId: THREAD, title: "Launch plan" });
    expect(await shareRows(THREAD)).toEqual({ invitations: [], operations: [], grants: [] });
    // Shared on the live Canvas, which keys it by the Thread's id, before the pass is resumed.
    await runInDurableObject(organization(), (_instance, state) => insertShare(state, THREAD, "canvas", LURKER));

    const resumed = await apply();

    expect(resumed).toMatchObject({ alreadyConverted: 1 });
    expect((await organizationRows()).threads).not.toContainEqual({ workstream_id: THREAD });
    expect(await shareRows(THREAD)).toEqual({
      invitations: [{ id: "canvas-invitation" }], operations: [{ operation_id: "canvas-operation" }], grants: [{ user_id: LURKER }],
    });
  });
});

describe("a conversation's parent kind conversion", () => {
  it("refuses any transition but a Thread's to a Canvas's by its code", async () => {
    await runInDurableObject(await conversation(PLAIN_THREAD), async (instance: AgentLoopDO) => {
      await expect(instance.convertParentKind({ workspaceId: WORKSPACE_ID, parentId: PLAIN_THREAD, from: "space", to: "canvas" }))
        .rejects.toThrow("conversation_parent_kind_conversion_unsupported:space:canvas");
      await expect(instance.convertParentKind({ workspaceId: WORKSPACE_ID, parentId: PLAIN_THREAD, from: "workstream", to: "automation" }))
        .rejects.toThrow("conversation_parent_kind_conversion_unsupported:workstream:automation");
    });
    expect(await storedParentKind(PLAIN_THREAD)).toBe("workstream");
  });

  it("re-addresses the Thread's undelivered effects to the Canvas", async () => {
    const thread = await conversation(PLAIN_THREAD);
    await runInDurableObject(thread, (_instance, state) => {
      const envelope = { kind: "conversation_effect", parentKind: "workstream", parentId: PLAIN_THREAD };
      state.storage.sql.exec(`INSERT INTO durable_outbox (message_id, channel, destination_kind, destination_id, partition_key,
          source_version, source_epoch, contract_version, payload_json, payload_ref, payload_hash, state, attempts,
          not_before, created_at, acked_at)
        VALUES ('effect-1', 'regional_effect_v1', 'queue', 'global', 'common', 1, 1, 1, ?, NULL, 'h', 'pending', 0, 0, 0, NULL)`,
      JSON.stringify(envelope));
    });
    await runInDurableObject(thread, (instance: AgentLoopDO) =>
      instance.convertParentKind({ workspaceId: WORKSPACE_ID, parentId: PLAIN_THREAD, from: "workstream", to: "canvas" }));
    await runInDurableObject(thread, (_instance, state) => {
      expect(state.storage.sql.exec<{ kind: string }>(
        "SELECT json_extract(payload_json, '$.parentKind') AS kind FROM durable_outbox WHERE message_id = 'effect-1'",
      ).one().kind).toBe("canvas");
    });
  });
});
