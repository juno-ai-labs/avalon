/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A Channel's Space access provenance on real workerd.
 *
 * Everything here needs the runtime: migration 18's tables are created by the
 * object's constructor, the foreign key that makes a source's departure take
 * its supplied readers with it is enforced by workerd and by nothing in the
 * Node suite, and the receipt that makes an operation replay to its first
 * answer is a real `transactionSync`.
 *
 * What these tests are *about* is that a Space is placement provenance and
 * nothing more: every Space is Organization-wide, and none grants a reader to
 * the Channels in it, so applying or retracting one plans no change to the
 * Channel's audience. The provenance rows still matter — they are what a
 * membership walk fences on — and readers a private Space seated before
 * WorkspaceDO migration 93 stay the Channel's own when it leaves.
 */
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { asSpaceId, asUserId, asWorkspaceId, asWorkstreamId, type SpaceId, type UserId } from "@rally/contracts";

import type { ObservedChannel as Observed } from "../src/durable-objects/workstream-access-protocol";
import { hostedParentStub } from "./helpers/hosted-parent";

/** Its own workspace: object names are shared across files, storage is not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000ac500");
const CHANNEL_ID = asWorkstreamId("00000000-0000-7000-8000-0000000ac501");
const SPACE_A = asSpaceId("00000000-0000-7000-8000-0000000ac502");
const SPACE_B = asSpaceId("00000000-0000-7000-8000-0000000ac503");
const OWNER = asUserId("00000000-0000-7000-8000-0000000ac504");
const READER = asUserId("00000000-0000-7000-8000-0000000ac505");
const OTHER = asUserId("00000000-0000-7000-8000-0000000ac506");

/** The Organization object, which hosts this Channel's parent. */
const channel = () => hostedParentStub(env, WORKSPACE_ID);
const address = { workspaceId: WORKSPACE_ID, parentId: CHANNEL_ID };

/** A personal Channel whose only reader is its owner. */
function personal(participantUserIds: UserId[] = [OWNER]): Observed {
  return { readers: { scope: "personal", userIds: participantUserIds }, participantUserIds };
}

/** An Organization-wide Channel: the reader audience names no roster at all. */
function organizationWide(participantUserIds: UserId[] = [OWNER]): Observed {
  return { readers: { scope: "workspace" }, participantUserIds };
}

function applySource(input: {
  spaceId: SpaceId;
  scope: "personal" | "workspace";
  participantUserIds: UserId[];
  channel: Observed;
  spaceRevision?: number;
  membershipGeneration?: number;
  operationId?: string;
  /** The birth mode: this call commits the source rather than only planning it. */
  commitWithPlan?: boolean;
}) {
  return channel().applySpaceAccessSource({
    ...address,
    spaceId: input.spaceId,
    scope: input.scope,
    participantUserIds: input.participantUserIds,
    spaceRevision: input.spaceRevision ?? 1,
    membershipGeneration: input.membershipGeneration ?? 1,
    operationId: input.operationId ?? crypto.randomUUID(),
    channel: input.channel,
    ...(input.commitWithPlan === undefined
      ? {}
      : { commitWithPlan: input.commitWithPlan }),
  });
}

/** What this object has actually written, read past every plan. */
function storedSources() {
  return runInDurableObject(channel(), (_instance, state) => ({
    sources: state.storage.sql.exec<{ space_id: string; participants_json: string }>(
      "SELECT space_id, participants_json FROM parent_space_sources WHERE parent_id = ? ORDER BY space_id",
      CHANNEL_ID,
    ).toArray(),
    supplied: state.storage.sql.exec<{ space_id: string; user_id: string }>(
      "SELECT space_id, user_id FROM parent_space_readers WHERE parent_id = ? ORDER BY space_id, user_id",
      CHANNEL_ID,
    ).toArray(),
  }));
}

/**
 * Apply a source, then commit it with what the plan said to seat.
 *
 * Two calls because the object takes two: the application is a plan and the
 * confirmation is what writes the source. A caller that stops after the first
 * has changed nothing here. `legacySeated` confirms readers the plan did not
 * name, which is the provenance a private Space left behind when it seated its
 * roster before WorkspaceDO migration 93; nothing seats anybody now.
 */
async function seatSource(input: Parameters<typeof applySource>[0], legacySeated?: UserId[]) {
  const applied = await applySource(input);
  if (!applied.ok) throw new Error(`apply_refused:${applied.code}`);
  const confirmed = await confirmSource(input, legacySeated ?? applied.plan.seatUserIds);
  return { applied, confirmed };
}

function confirmSource(input: Parameters<typeof applySource>[0], seatedUserIds: UserId[]) {
  return channel().confirmSpaceAccessSource({
    ...address,
    spaceId: input.spaceId,
    operationId: crypto.randomUUID(),
    seatedUserIds,
    source: {
      scope: input.scope,
      participantUserIds: input.participantUserIds,
      spaceRevision: input.spaceRevision ?? 1,
      membershipGeneration: input.membershipGeneration ?? 1,
      channel: input.channel,
    },
  });
}

function retract(spaceId: SpaceId, observed: Observed, operationId = crypto.randomUUID()) {
  return channel().retractSpaceAccessSource({ ...address, spaceId, operationId, channel: observed });
}

beforeEach(async () => {
  await reset();
  // The Organization object learns its placement from D1 on the first parent
  // request, as it does in production.
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE workspaces (id TEXT PRIMARY KEY, region TEXT DEFAULT 'global', placement_affinity TEXT DEFAULT 'wnam', abandoned_at TEXT)"),
    env.DB.prepare("INSERT INTO workspaces (id) VALUES (?)").bind(WORKSPACE_ID),
  ]);
  await runInDurableObject(channel(), (_instance, state) => {
    // The identity row every RPC asserts its address against. Written directly
    // because these tests are about the provenance tables, not about how a
    // Channel comes to exist.
    state.storage.sql.exec(
      `INSERT INTO parent_metadata
         (parent_id, parent_kind, workspace_id, region, authority_generation, created_at, updated_at)
       VALUES (?, 'workstream', ?, 'global', 1, 1, 1)`,
      CHANNEL_ID,
      WORKSPACE_ID,
    );
    state.storage.sql.exec(
      `INSERT INTO parent_children (parent_id, substream_id, kind, created_by_user_id, created_at, status, updated_at)
       VALUES (?, '0', 'main', ?, 1, 'ready', 1)`,
      CHANNEL_ID,
      OWNER,
    );
  });
});

describe("a Channel's Space access sources", () => {
  it("moves equivalent Space provenance atomically, readers a Space seated before migration 93 included", async () => {
    await seatSource({
      spaceId: SPACE_A, scope: "personal", participantUserIds: [OWNER, READER],
      channel: personal([OWNER]), spaceRevision: 3, membershipGeneration: 4,
    }, [READER]);
    const operationId = "00000000-0000-7000-8000-0000000ac507";
    const request = {
      ...address,
      sourceSpaceId: SPACE_A,
      targetSpaceId: SPACE_B,
      scope: "personal" as const,
      participantUserIds: [OWNER, READER],
      sourceSpaceRevision: 3,
      sourceMembershipGeneration: 4,
      targetSpaceRevision: 6,
      targetMembershipGeneration: 2,
      operationId,
    };

    expect(await channel().replaceEquivalentSpaceAccessSource(request)).toEqual({ ok: true });
    expect(await storedSources()).toEqual({
      sources: [{ space_id: SPACE_B, participants_json: JSON.stringify([OWNER, READER]) }],
      supplied: [{ space_id: SPACE_B, user_id: READER }],
    });

    // The durable receipt makes a retry return the first answer without
    // interpreting the now-absent source as a new operation.
    expect(await channel().replaceEquivalentSpaceAccessSource(request)).toEqual({ ok: true });
    expect(await storedSources()).toEqual({
      sources: [{ space_id: SPACE_B, participants_json: JSON.stringify([OWNER, READER]) }],
      supplied: [{ space_id: SPACE_B, user_id: READER }],
    });
  });

  it("refuses an atomic move when the source was replaced at a newer generation", async () => {
    await seatSource({
      spaceId: SPACE_A, scope: "personal", participantUserIds: [OWNER, READER],
      channel: personal([OWNER]), spaceRevision: 3, membershipGeneration: 4,
    }, [READER]);
    await seatSource({
      spaceId: SPACE_A, scope: "personal", participantUserIds: [OWNER, READER],
      channel: personal([OWNER, READER]), spaceRevision: 4, membershipGeneration: 5,
    }, [READER]);

    expect(await channel().replaceEquivalentSpaceAccessSource({
      ...address,
      sourceSpaceId: SPACE_A,
      targetSpaceId: SPACE_B,
      scope: "personal",
      participantUserIds: [OWNER, READER],
      sourceSpaceRevision: 3,
      sourceMembershipGeneration: 4,
      targetSpaceRevision: 6,
      targetMembershipGeneration: 2,
      operationId: "00000000-0000-7000-8000-0000000ac509",
    })).toEqual({ ok: false, code: "space_revision_conflict" });
    expect(await storedSources()).toMatchObject({
      sources: [{ space_id: SPACE_A }],
      supplied: [{ space_id: SPACE_A, user_id: READER }],
    });
  });

  it("refuses a provenance move when the stored source audience is different", async () => {
    await seatSource({
      spaceId: SPACE_A, scope: "personal", participantUserIds: [OWNER, READER],
      channel: personal([OWNER]),
    }, [READER]);

    expect(await channel().replaceEquivalentSpaceAccessSource({
      ...address,
      sourceSpaceId: SPACE_A,
      targetSpaceId: SPACE_B,
      scope: "personal",
      participantUserIds: [OWNER, OTHER],
      sourceSpaceRevision: 1,
      sourceMembershipGeneration: 1,
      targetSpaceRevision: 1,
      targetMembershipGeneration: 1,
      operationId: "00000000-0000-7000-8000-0000000ac508",
    })).toEqual({ ok: false, code: "space_revision_conflict" });
    expect(await storedSources()).toMatchObject({
      sources: [{ space_id: SPACE_A }],
      supplied: [{ space_id: SPACE_A, user_id: READER }],
    });
  });

  it("reads persisted Space provenance without a mutable Channel observation", async () => {
    await seatSource({
      spaceId: SPACE_A, scope: "workspace", participantUserIds: [OWNER, READER],
      channel: personal([OWNER]),
    });

    expect(await channel().readPersistedSpaceAccessSources(address)).toEqual([
      { spaceId: SPACE_A, scope: "workspace", participantUserIds: [OWNER, READER] },
    ]);
  });

  it.each([
    { scope: "workspace" as const, observed: personal([OWNER]) },
    { scope: "personal" as const, observed: personal([OWNER]) },
    { scope: "workspace" as const, observed: organizationWide([OWNER]) },
  ])("given a $scope Space, when it is applied to a $observed.readers.scope Channel, then it plans no change and the Channel's audience stays its own", async ({ scope, observed }) => {
    const seated = await seatSource({
      spaceId: SPACE_A, scope, participantUserIds: [OWNER, READER], channel: observed,
    });

    expect(seated.applied).toEqual({ ok: true, plan: { widenScope: false, seatUserIds: [] } });
    expect(seated.confirmed).toEqual({ ok: true, suppliedUserIds: [] });
    // The source is recorded as placement provenance, and supplies nobody.
    expect(await storedSources()).toEqual({
      sources: [{ space_id: SPACE_A, participants_json: JSON.stringify([OWNER, READER]) }],
      supplied: [],
    });
    expect(await channel().readAccessSources({ ...address, channel: observed })).toEqual({
      direct: { scope: observed.readers.scope, participantUserIds: [OWNER] },
      spaces: [],
    });
  });

  it("given an application nothing confirmed, when the Channel is read, then no source claims it", async () => {
    // The crash window the confirmation closes. A source recorded by the
    // application would survive a caller that died before confirming it, and
    // would then claim a Space reaches this Channel.
    expect(await applySource({
      spaceId: SPACE_A, scope: "workspace", participantUserIds: [OWNER, READER],
      channel: personal([OWNER]),
    })).toEqual({ ok: true, plan: { widenScope: false, seatUserIds: [] } });

    await runInDurableObject(channel(), (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT space_id FROM parent_space_sources WHERE parent_id = ?", CHANNEL_ID,
      ).toArray()).toEqual([]);
      // And the Channel's own scope is still unestablished, so the first
      // Space that *does* commit still seeds it from what it observed. A
      // hosted parent has no backfilled row: absent and `updated_at = 0` both
      // read as unestablished.
      const direct = state.storage.sql.exec<{ updated_at: number }>(
        "SELECT updated_at FROM parent_direct_audience WHERE parent_id = ?", CHANNEL_ID,
      ).toArray();
      expect(direct.every((row) => row.updated_at === 0)).toBe(true);
    });
  });

  it("given a Channel born in a Space, when it is applied in the birth mode, then one call records the source and supplies no reader", async () => {
    expect(await applySource({
      spaceId: SPACE_A, scope: "workspace", participantUserIds: [OWNER, READER],
      channel: personal([OWNER]), commitWithPlan: true,
    })).toEqual({
      ok: true,
      plan: { widenScope: false, seatUserIds: [] },
      suppliedUserIds: [],
    });

    expect(await storedSources()).toEqual({
      sources: [{ space_id: SPACE_A, participants_json: JSON.stringify([OWNER, READER]) }],
      supplied: [],
    });
  });

  it("given a source the Channel has moved past, when a birth-mode application arrives behind it, then the fence refuses it and commits nothing", async () => {
    await seatSource({
      spaceId: SPACE_A, scope: "workspace", participantUserIds: [OWNER, READER],
      channel: personal([OWNER]), spaceRevision: 2,
    });

    // The birth mode writes the source row, so it needs the same fence the
    // confirmation carries: without it a stale creation replay would install
    // its own roster over a newer one.
    expect(await applySource({
      spaceId: SPACE_A, scope: "workspace", participantUserIds: [OWNER, OTHER],
      channel: personal([OWNER]), spaceRevision: 1, commitWithPlan: true,
    })).toEqual({ ok: false, code: "space_revision_conflict" });

    expect(await storedSources()).toEqual({
      sources: [{ space_id: SPACE_A, participants_json: JSON.stringify([OWNER, READER]) }],
      supplied: [],
    });
  });

  it("given a reader a Space seated before migration 93, when that Space is retracted, then the reader stays and only the provenance goes", async () => {
    await seatSource({
      spaceId: SPACE_A, scope: "personal", participantUserIds: [READER],
      channel: personal([OWNER]),
    }, [READER]);

    expect(await retract(SPACE_A, personal([OWNER, READER]))).toEqual({
      ok: true,
      plan: { narrowScope: false, seatUserIds: [], removeUserIds: [] },
    });
    // The cascade takes the source's attribution with it; the reader it
    // seated is the Channel's own from here on.
    expect(await storedSources()).toEqual({ sources: [], supplied: [] });
  });

  it("given an Organization-wide Channel, when its last Organization-wide Space is retracted, then nothing narrows", async () => {
    await seatSource({
      spaceId: SPACE_A, scope: "workspace", participantUserIds: [READER],
      channel: organizationWide([OWNER]),
    });

    expect(await retract(SPACE_A, organizationWide([OWNER]))).toEqual({
      ok: true,
      plan: { narrowScope: false, seatUserIds: [], removeUserIds: [] },
    });
  });

  it("given a staged application, when a newer one already landed, then the stale revision is refused", async () => {
    const newer = {
      spaceId: SPACE_A, scope: "workspace" as const, participantUserIds: [READER],
      channel: personal([OWNER]), spaceRevision: 4, membershipGeneration: 2,
    };
    await seatSource(newer);

    // Re-read inside the transaction, after every external boundary the caller
    // crossed to get here: a staged application that lost the race must not
    // overwrite the newer one with the Space it saw. Both halves refuse.
    const stale = {
      spaceId: SPACE_A, scope: "workspace" as const, participantUserIds: [READER, OTHER],
      channel: personal([OWNER]), spaceRevision: 3, membershipGeneration: 9,
    };
    expect(await applySource(stale)).toEqual({ ok: false, code: "space_revision_conflict" });
    expect(await confirmSource(stale, [])).toEqual({ ok: false, code: "space_revision_conflict" });
    expect(await applySource({ ...stale, spaceRevision: 4, membershipGeneration: 1 }))
      .toEqual({ ok: false, code: "space_revision_conflict" });

    expect(await storedSources()).toEqual({
      sources: [{ space_id: SPACE_A, participants_json: JSON.stringify([READER]) }],
      supplied: [],
    });
  });

  it("given an Organization-wide Space, when the Channel's own scope is narrowed, then the narrowing is recorded", async () => {
    await seatSource({
      spaceId: SPACE_A, scope: "workspace", participantUserIds: [READER],
      channel: organizationWide([OWNER]),
    });

    // A Space grants no reader, so nothing holds the Channel open.
    expect(await channel().setDirectScope({ ...address, scope: "personal", operationId: crypto.randomUUID() }))
      .toEqual({ ok: true, previousScope: "workspace", previousObserved: true });
    expect(await channel().setDirectScope({ ...address, scope: "workspace", operationId: crypto.randomUUID() }))
      .toEqual({ ok: true, previousScope: "personal", previousObserved: true });
  });

  it("given a scope change the canonical update refused, when it is restored, then the record is unestablished again", async () => {
    // Nothing has established this Channel's own audience: the row is still
    // the migration's backfill, which for an object created after it ran is a
    // guess. The failed change and its restore have to leave it that way.
    expect(await channel().setDirectScope({ ...address, scope: "workspace", operationId: crypto.randomUUID() }))
      .toEqual({ ok: true, previousScope: "personal", previousObserved: false });
    expect(await channel().setDirectScope({
      ...address, scope: "personal", observed: false, operationId: crypto.randomUUID(),
    })).toEqual({ ok: true, previousScope: "workspace", previousObserved: true });

    // Which is what lets the first Space to reach it seed the real value. A
    // restore that marked the row observed would leave the Channel recorded as
    // private although it was Organization-wide.
    await seatSource({
      spaceId: SPACE_A, scope: "workspace", participantUserIds: [READER],
      channel: organizationWide([OWNER]),
    });
    expect(await channel().setDirectScope({ ...address, scope: "workspace", operationId: crypto.randomUUID() }))
      .toEqual({ ok: true, previousScope: "workspace", previousObserved: true });
  });

  it("given an attribution whose source was withdrawn first, when it runs, then it is refused by name", async () => {
    await seatSource({
      spaceId: SPACE_A, scope: "workspace", participantUserIds: [READER],
      channel: personal([OWNER]),
    });
    await retract(SPACE_A, personal([OWNER]));

    // A confirmation with no source of its own attributes readers to a Space
    // that is supposed to already be here. Silently converging would leave
    // those readers attributed to nothing.
    expect(await channel().confirmSpaceAccessSource({
      ...address, spaceId: SPACE_A, operationId: crypto.randomUUID(), seatedUserIds: [OTHER],
    })).toEqual({ ok: false, code: "space_not_found" });
  });

  it("given two changes to one Space interleaved, when the older one converges, then it is refused", async () => {
    // Two changes on one Space, reaching this Channel out of order. Both
    // converge by retract-then-apply, and the retraction is what deletes the
    // row the application and the confirmation fence on — so the older one
    // has to be refused *here* or it installs its stale roster over the newer.
    await seatSource({
      spaceId: SPACE_A, scope: "workspace", participantUserIds: [OWNER, READER],
      channel: personal([OWNER]), spaceRevision: 2,
    });

    expect(await channel().retractSpaceAccessSource({
      ...address, spaceId: SPACE_A, operationId: crypto.randomUUID(),
      expectedSpaceRevision: 1, channel: personal([OWNER]),
    })).toEqual({ ok: false, code: "space_revision_conflict" });
    // Refused rather than partly applied: the source the newer change
    // committed is still here, with its roster.
    expect(await storedSources()).toEqual({
      sources: [{ space_id: SPACE_A, participants_json: JSON.stringify([OWNER, READER]) }],
      supplied: [],
    });

    // The newer change's own convergence is not refused by its own fence.
    expect(await channel().retractSpaceAccessSource({
      ...address, spaceId: SPACE_A, operationId: crypto.randomUUID(),
      expectedSpaceRevision: 2, channel: personal([OWNER]),
    })).toMatchObject({ ok: true });
  });

  it("given a source that is already gone, when it is retracted again, then it converges on an empty plan", async () => {
    // A retraction reissued under a new operation id after a crash has to finish.
    expect(await retract(SPACE_A, personal([OWNER]))).toEqual({
      ok: true,
      plan: { narrowScope: false, seatUserIds: [], removeUserIds: [] },
    });
  });
});
