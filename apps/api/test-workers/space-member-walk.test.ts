/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A Space fan-out over more member Channels than one page holds.
 *
 * Everything here needs the runtime. The property under test is that a walk
 * which cannot finish inside one invocation still converges: the page bound is
 * real storage answering a cursor, the intent that carries that cursor is a
 * real `transactionSync` in WorkspaceDO, and the Channel end of every step is
 * a real `WorkstreamDO` receipt table — which is also what lets a resumed walk
 * be counted rather than inferred.
 *
 * Its own file rather than a case in `space-authority.test.ts` because the
 * fixture is the point: a Space with `SPACE_BOOTSTRAP_PAGE_SIZE + 1` member
 * Channels, each with its own authority and its own hidden conversation, is
 * what makes the second page exist at all.
 */
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  reset,
  runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  asSpaceId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  conversationEffectHash,
  type ParentEffect,
  type SpaceId,
  type UserId,
  type WorkstreamId,
} from "@rally/contracts";
import { ParentEffectEnvelopeSchema } from "@rally/contracts/conversation-effects";

import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import { SPACE_BOOTSTRAP_PAGE_SIZE } from "../src/durable-objects/workspace-space-storage";
import type { AuthContext } from "../src/env";
import { consumeActivityQueue } from "../src/queues/activity-consumer";
import { SpaceService } from "../src/services/space-service";
import { seedWorkstreamRoot } from "./helpers/substream-fixture";

/** Its own workspace id: object names are shared across files, storage is not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000ba00");
const OWNER = asUserId("00000000-0000-7000-8000-00000000ba01");
const SESSION_ID = "00000000-0000-7000-8000-00000000ba02";
/** The second member: the one a resume can find degraded rather than absent. */
const MEMBER = asUserId("00000000-0000-7000-8000-00000000ba03");
const MEMBER_SESSION_ID = "00000000-0000-7000-8000-00000000ba04";

const AUTH: AuthContext = {
  sessionId: SESSION_ID,
  userId: OWNER,
  workspaceId: WORKSPACE_ID,
  region: "global",
  role: "owner",
};

/**
 * One more Channel than a page holds, which is the smallest fixture that has a
 * second page at all — and therefore the smallest one in which a cursor is the
 * difference between converging and restarting.
 */
const CHANNEL_COUNT = SPACE_BOOTSTRAP_PAGE_SIZE + 1;

/** Ordered by id, because that is the order the walk takes and the cursor names. */
const CHANNELS: WorkstreamId[] = Array.from({ length: CHANNEL_COUNT }, (_, index) => (
  asWorkstreamId(`00000000-0000-7000-8000-ba${String(index).padStart(10, "0")}`)
));

function workspace() {
  return env.WORKSPACE_DOS.getByName(workspaceDOName("global", WORKSPACE_ID));
}

/** A member Channel's authority, hosted by the Organization object like every Channel parent. */
function memberChannel(_workstreamId: WorkstreamId) {
  return workspace();
}

function conversation(workstreamId: WorkstreamId) {
  return env.SUBSTREAM_AGENTS.getByName(
    conversationObjectName("global", WORKSPACE_ID, workstreamId, "0"),
  );
}

async function establishWorkspace(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT, abandoned_at TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (
      incarnation TEXT DEFAULT 'existing-member',
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT, access_class TEXT NOT NULL DEFAULT 'member',
      last_seen_at TEXT, PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      workspace_incarnation TEXT DEFAULT 'existing-member',
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      region TEXT NOT NULL, revoked_at TEXT, expires_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_control (
      id INTEGER PRIMARY KEY, phase TEXT NOT NULL, generation INTEGER NOT NULL,
      required_serving_contract_version INTEGER NOT NULL,
      serving_contract_version INTEGER NOT NULL
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO workstream_authority_control
      (id, phase, generation, required_serving_contract_version, serving_contract_version)
      VALUES (1, 'durable_object_open', 1, 1, 1)`),
    env.DB.prepare("INSERT OR REPLACE INTO workspaces(id, region) VALUES (?, 'global')")
      .bind(WORKSPACE_ID),
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members
      (workspace_id, user_id, status, role, access_class) VALUES (?, ?, 'active', 'owner', 'member')`)
      .bind(WORKSPACE_ID, OWNER),
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members
      (workspace_id, user_id, status, role, access_class) VALUES (?, ?, 'active', 'member', 'member')`)
      .bind(WORKSPACE_ID, MEMBER),
    env.DB.prepare(`INSERT OR REPLACE INTO sessions
      (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(SESSION_ID, OWNER, WORKSPACE_ID),
    env.DB.prepare(`INSERT OR REPLACE INTO sessions
      (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(MEMBER_SESSION_ID, MEMBER, WORKSPACE_ID),
  ]);
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
}

let effectSequence = 0;

/** One Channel published into the Organization's Channel directory. */
async function publishChannel(workstreamId: WorkstreamId): Promise<void> {
  effectSequence += 1;
  const effect: ParentEffect = {
    kind: "directory_common",
    title: "Member Channel",
    description: "",
    preview: "",
    scope: "workspace",
    state: "idle",
    systemKind: null,
    lastActivityAt: "2026-09-19T00:00:00.000Z",
    completedAt: null,
    archivedAt: null,
    createdByUserId: OWNER,
    latestAttentionOrdinal: 0,
    unreadTrackingStartOrdinal: 0,
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    resourceLinks: [],
  };
  await workspace().applyWorkstreamDirectoryEffects({
    workspaceId: WORKSPACE_ID,
    envelopes: [ParentEffectEnvelopeSchema.parse({
      kind: "parent_effect",
      contractVersion: 1,
      region: "global",
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: workstreamId,
      generation: 1,
      messageId: `00000000-0000-7000-8000-${String(effectSequence).padStart(10, "0")}ba`,
      partitionKey: "common",
      sourceVersion: 1,
      requiredProjectionVersion: null,
      payloadHash: conversationEffectHash(effect),
      effect,
    })],
  });
}

async function reserve(name: string, scope: "workspace" | "personal" = "workspace"): Promise<SpaceId> {
  const result = await workspace().reserveSpace({
    workspaceId: WORKSPACE_ID,
    userId: OWNER,
    space: { name, iconKey: "briefcase", colorKey: "blue", scope },
  });
  if (!result.ok) throw new Error(`reserveSpace refused: ${result.code}`);
  return asSpaceId(result.space.id);
}

async function place(spaceId: SpaceId, workstreamId: WorkstreamId): Promise<void> {
  const plan = await workspace().prepareSpaceMembership({
    workspaceId: WORKSPACE_ID, userId: OWNER, spaceId, workstreamId,
  });
  if (!plan.ok) throw new Error(`prepareSpaceMembership refused: ${plan.code}`);
  const settled = await workspace().finalizeSpaceMembership({
    workspaceId: WORKSPACE_ID,
    userId: OWNER,
    spaceId,
    workstreamId,
    spaceRevision: plan.space.revision,
    membershipGeneration: plan.membershipGeneration,
  });
  if (!settled.ok) throw new Error(`finalizeSpaceMembership refused: ${settled.code}`);
}

const observedChannel = {
  readers: { scope: "workspace" as const },
  participantUserIds: [OWNER],
};

/**
 * One member Channel, in both places a Space step reaches.
 *
 * The authority (hosted by the Organization object) holds the provenance the
 * retraction acts on; the hidden
 * conversation is what `ChannelAccessService` reads the Channel's own audience
 * from before it asks for a plan. Written directly rather than created through
 * the coordinator, because this file is about the walk over them rather than
 * about how a Channel comes to be — and fifty-one real creations would be a
 * fixture nobody could run.
 */
async function openMemberChannel(workstreamId: WorkstreamId): Promise<void> {
  await runInDurableObject(memberChannel(workstreamId), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO parent_metadata
         (parent_id, parent_kind, workspace_id, region, authority_generation, title, description,
          preview, scope, exact_state, last_activity_at, created_at, updated_at)
       VALUES (?, 'workstream', ?, 'global', 1, 'Member Channel', '', '', 'workspace', 'idle', 1, 1, 1)`,
      workstreamId,
      WORKSPACE_ID,
    );
    state.storage.sql.exec(
      `INSERT INTO parent_children (parent_id, substream_id, kind, created_by_user_id, created_at, status, updated_at)
       VALUES (?, '0', 'main', ?, 1, 'ready', 1)`,
      workstreamId,
      OWNER,
    );
  });
  await runInDurableObject(conversation(workstreamId), (_instance, state) => {
    seedWorkstreamRoot(state, 1, { workspaceId: WORKSPACE_ID, workstreamId });
  });
}

/** Apply and confirm one Space's source, the two calls the service makes. */
async function seatSpaceSource(
  workstreamId: WorkstreamId,
  spaceId: SpaceId,
  audience: { scope: "workspace" | "personal"; participantUserIds: UserId[] } =
    { scope: "workspace", participantUserIds: [OWNER] },
): Promise<void> {
  const address = { workspaceId: WORKSPACE_ID, parentId: workstreamId };
  const source = {
    ...audience,
    spaceRevision: 1,
    membershipGeneration: 1,
    channel: observedChannel,
  };
  const applied = await memberChannel(workstreamId).applySpaceAccessSource({
    ...address, spaceId, ...source, operationId: crypto.randomUUID(),
  });
  if (!applied.ok) throw new Error(`applySpaceAccessSource refused: ${applied.code}`);
  const confirmed = await memberChannel(workstreamId).confirmSpaceAccessSource({
    ...address, spaceId, operationId: crypto.randomUUID(), seatedUserIds: [], source,
  });
  if (!confirmed.ok) throw new Error(`confirmSpaceAccessSource refused: ${confirmed.code}`);
}

/**
 * How many access operations each of these Channels has answered.
 *
 * The receipt table is the operation count, and counting it is how "the first
 * page was not walked again" is read off the Channels themselves rather than
 * inferred from the cursor that is under test.
 */
async function operationCounts(workstreamIds: readonly WorkstreamId[]): Promise<number[]> {
  const counts: number[] = [];
  for (const workstreamId of workstreamIds) {
    counts.push(await runInDurableObject(memberChannel(workstreamId), (_instance, state) => (
      state.storage.sql.exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM workstream_access_operations",
      ).one().total
    )));
  }
  return counts;
}

/**
 * One Space's source on a member Channel, readers included.
 *
 * `spaceSourceIds` answers which Spaces are seated; this answers *who they
 * seat*, which is the half a retract-then-apply can empty while leaving the
 * source itself in place.
 */
async function spaceSource(workstreamId: WorkstreamId, spaceId: SpaceId) {
  const sources = await memberChannel(workstreamId).readAccessSources({
    workspaceId: WORKSPACE_ID, parentId: workstreamId, channel: observedChannel,
  });
  return sources.spaces.find((source) => source.spaceId === spaceId);
}

async function spaceSourceIds(workstreamId: WorkstreamId): Promise<string[]> {
  const sources = await memberChannel(workstreamId).readAccessSources({
    workspaceId: WORKSPACE_ID, parentId: workstreamId, channel: observedChannel,
  });
  return sources.spaces.map((source) => source.spaceId);
}

/** The cursor shape the storage writes: base64url of the Channel id. */
function cursorAt(workstreamId: WorkstreamId): string {
  return btoa(workstreamId).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function intentRow(operationId: string) {
  return workspace().runInspectionSql({
    sql: "SELECT state, cursor FROM space_intents WHERE operation_id = ?",
    bindings: [operationId],
  });
}

beforeEach(async () => {
  await reset();
  effectSequence = 0;
  await establishWorkspace();
}, 60_000);

describe("a Space fan-out over more members than one page", () => {
  it("given a walk that dies on the second page, when it resumes, then it continues from the cursor and reaches every member", async () => {
    const departing = await reserve("Company");
    const staying = await reserve("Recruiting");
    // Every Channel but the first of the second page. Leaving that one's
    // objects unopened is how the fixture kills the walk exactly where a
    // subrequest ceiling would: after one full page of real work.
    const broken = CHANNELS[SPACE_BOOTSTRAP_PAGE_SIZE]!;
    for (const workstreamId of CHANNELS) {
      await publishChannel(workstreamId);
      await place(departing, workstreamId);
      // A second home, because an archive that would strand a Channel is
      // refused before it stages anything.
      await place(staying, workstreamId);
      if (workstreamId === broken) continue;
      await openMemberChannel(workstreamId);
      await seatSpaceSource(workstreamId, departing);
      await seatSpaceSource(workstreamId, staying);
    }

    await expect(new SpaceService(env, AUTH).archive(departing)).rejects.toThrow();

    // The first page finished and said so. Without the cursor there is nothing
    // on the row that distinguishes this from a walk that never started — which
    // is what a resume then has to act on.
    const firstPageEnd = CHANNELS[SPACE_BOOTSTRAP_PAGE_SIZE - 1]!;
    const staged = await workspace().runInspectionSql({
      sql: "SELECT operation_id, state, cursor FROM space_intents WHERE kind = 'archive'",
      bindings: [],
    });
    const intent = staged.rows[0] as { operation_id: string; state: string; cursor: string | null };
    expect(intent.state).toBe("applied");
    expect(intent.cursor).not.toBeNull();
    expect(atob(intent.cursor!.replaceAll("-", "+").replaceAll("_", "/"))).toBe(firstPageEnd);

    // What the first page cost, before anything resumes.
    const firstPageOperations = await operationCounts(CHANNELS.slice(0, SPACE_BOOTSTRAP_PAGE_SIZE));

    await openMemberChannel(broken);
    await seatSpaceSource(broken, departing);
    await seatSpaceSource(broken, staying);

    await new SpaceService(env, AUTH).resumeIntent({
      operationId: intent.operation_id,
      kind: "archive",
      spaceId: departing,
      workstreamId: null,
      spaceRevision: 2,
      membershipGeneration: null,
      cursor: intent.cursor,
    });

    // Every member is settled, the second page included: the walk crosses the
    // page bound rather than stopping at it.
    for (const workstreamId of CHANNELS) {
      expect(await spaceSourceIds(workstreamId)).toEqual([staying]);
    }
    // And the page before the one it died on is not touched again: the resume
    // continues the walk rather than replaying it.
    expect(await operationCounts(CHANNELS.slice(0, SPACE_BOOTSTRAP_PAGE_SIZE)))
      .toEqual(firstPageOperations);
    await expect(intentRow(intent.operation_id))
      .resolves.toMatchObject({ rows: [{ state: "settled" }] });
  }, 120_000);

  it("given a restore that never walked, when it resumes, then it re-applies the source from the cursor on", async () => {
    const departing = await reserve("Company");
    const staying = await reserve("Recruiting");
    // Two Channels, because what this is about is the `restore` branch of the
    // resume rather than the page bound the case above already crosses.
    const walked = CHANNELS[0]!;
    const remaining = CHANNELS[1]!;
    for (const workstreamId of [walked, remaining]) {
      await publishChannel(workstreamId);
      await place(departing, workstreamId);
      await place(staying, workstreamId);
      await openMemberChannel(workstreamId);
      await seatSpaceSource(workstreamId, departing);
      await seatSpaceSource(workstreamId, staying);
    }
    const service = new SpaceService(env, AUTH);
    await service.archive(departing);
    expect(await spaceSourceIds(remaining)).toEqual([staying]);

    // The restore commits and the request dies before it asks any Channel for
    // anything: the Space is active again in the directory and on every socket,
    // and no member holds its source. Before this staged an intent, that state
    // was the one Space operation nothing would ever notice.
    const operationId = crypto.randomUUID();
    const restored = await workspace().restoreSpace({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: departing, operationId,
    });
    if (!restored.ok) throw new Error(restored.code);
    expect(await spaceSourceIds(remaining)).toEqual([staying]);

    await service.resumeIntent({
      operationId,
      kind: "restore",
      spaceId: departing,
      workstreamId: null,
      spaceRevision: restored.space.revision,
      membershipGeneration: null,
      cursor: cursorAt(walked),
    });

    // The member the walk had not reached has the source back; the one behind
    // the cursor is left where the interrupted walk left it.
    expect(await spaceSourceIds(remaining)).toEqual([departing, staying].sort());
    expect(await spaceSourceIds(walked)).toEqual([staying]);
    await expect(intentRow(operationId)).resolves.toMatchObject({ rows: [{ state: "settled" }] });
  }, 120_000);

  it("given a resume that fails, when the consumer catches it, then the reason is on the intent row", async () => {
    const spaceId = await reserve("Company");
    const stranded = CHANNELS[0]!;
    await publishChannel(stranded);
    await place(spaceId, stranded);
    // Deliberately no objects behind the Channel, so every step of the walk
    // throws — which is what a resume against a broken member looks like.

    const operationId = crypto.randomUUID();
    const noted = await workspace().noteSpaceAudience({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      spaceId,
      operationId,
      audience: { scope: "personal", participantUserIds: [OWNER] },
    });
    if (!noted.ok) throw new Error(noted.code);

    const batch = createMessageBatch("avalon-global-activity", [{
      id: crypto.randomUUID(),
      timestamp: new Date(),
      attempts: 1,
      body: {
        type: "space_intent_resume",
        region: "global",
        workspaceId: WORKSPACE_ID,
        operationId,
        kind: "audience",
        spaceId,
        workstreamId: null,
        spaceRevision: noted.space.revision,
        membershipGeneration: null,
        cursor: null,
        requestedByUserId: OWNER,
      },
    }]);
    await consumeActivityQueue(batch, env);
    const outcome = await getQueueResult(batch, createExecutionContext());
    expect(outcome.retryMessages).toHaveLength(1);

    // The row outlives the log line. Without this the only account of why an
    // intent is still unsettled is a `space_intent_resume_failed` line, and the
    // alarm republishes the message forever with nothing on the row but the
    // fact that it did not finish.
    const row = await workspace().runInspectionSql({
      sql: "SELECT state, last_error_code FROM space_intents WHERE operation_id = ?",
      bindings: [operationId],
    });
    expect(row.rows[0]).toMatchObject({ state: "pending" });
    expect((row.rows[0] as { last_error_code: string | null }).last_error_code).toBeTruthy();
  }, 60_000);

  it("given a requester who has lost their reach, when the intent resumes, then it refuses by name and every member keeps its readers", async () => {
    const spaceId = await reserve("Side work", "personal");
    const channel = CHANNELS[0]!;
    await publishChannel(channel);
    await place(spaceId, channel);
    await openMemberChannel(channel);

    // Both people are participants, and both are seated on the member Channel
    // by the Space. That roster is what the resume below would otherwise
    // withdraw.
    const joined = await workspace().noteSpaceAudience({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      spaceId,
      operationId: crypto.randomUUID(),
      audience: { scope: "personal", participantUserIds: [OWNER, MEMBER] },
    });
    if (!joined.ok) throw new Error(joined.code);
    await seatSpaceSource(channel, spaceId, {
      scope: "personal", participantUserIds: [OWNER, MEMBER],
    });

    // The second member stages an audience change of their own, as a
    // participant may, and its walk never reaches the Channel.
    const operationId = crypto.randomUUID();
    const staged = await workspace().noteSpaceAudience({
      workspaceId: WORKSPACE_ID,
      userId: MEMBER,
      spaceId,
      operationId,
      audience: { scope: "personal", participantUserIds: [OWNER, MEMBER] },
    });
    if (!staged.ok) throw new Error(staged.code);

    // Then they are taken out of the Space. They still reach it — the Channel
    // in it is Organization-wide and they can read it — so the read the resume
    // makes no longer refuses them: it answers `through_channel`, whose
    // participant list is empty by design.
    const narrowed = await workspace().noteSpaceAudience({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      spaceId,
      operationId: crypto.randomUUID(),
      audience: { scope: "personal", participantUserIds: [OWNER] },
    });
    if (!narrowed.ok) throw new Error(narrowed.code);
    await expect(workspace().spaceSummary({
      workspaceId: WORKSPACE_ID, userId: MEMBER, spaceId,
    })).resolves.toMatchObject({ ok: true, space: { reach: "through_channel", participants: [] } });

    const batch = createMessageBatch("avalon-global-activity", [{
      id: crypto.randomUUID(),
      timestamp: new Date(),
      attempts: 1,
      body: {
        type: "space_intent_resume",
        region: "global",
        workspaceId: WORKSPACE_ID,
        operationId,
        kind: "audience",
        spaceId,
        workstreamId: null,
        spaceRevision: staged.space.revision,
        membershipGeneration: null,
        cursor: null,
        requestedByUserId: MEMBER,
      },
    }]);
    await consumeActivityQueue(batch, env);

    // The readers the Space supplies are exactly the ones it supplied before.
    // The walk this resume would have taken retracts the source and re-applies
    // it from the requester's own view of the Space, which for this requester
    // names nobody — so the Channel would keep the source and lose everyone
    // seated through it, and the operation would report success.
    expect(await spaceSource(channel, spaceId)).toMatchObject({
      scope: "personal",
      participantUserIds: [OWNER, MEMBER],
    });

    // Terminal, and said on the row: the intent is settled with the reason, so
    // the alarm has nothing left to republish and the queue has nothing to
    // retry.
    const row = await workspace().runInspectionSql({
      sql: "SELECT state, last_error_code, receipts_json FROM space_intents WHERE operation_id = ?",
      bindings: [operationId],
    });
    expect(row.rows[0]).toMatchObject({
      state: "settled",
      last_error_code: "requester_reach_lost",
    });
    expect(String((row.rows[0] as { receipts_json: string }).receipts_json))
      .toContain("requester_reach_lost");
    const outcome = await getQueueResult(batch, createExecutionContext());
    expect(outcome.retryMessages).toHaveLength(0);
  }, 60_000);
});
