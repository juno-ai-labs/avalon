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
 * What these tests are *about* is the union: the plans this object returns have
 * to be a function of every source that still reaches the Channel, not of the
 * one that is leaving. The PRD's negative control for that is skipping the
 * remaining-sources read in `retractSpaceAccessSource`, which leaves a reader
 * the departing Space alone supplied looking like the only reader to remove —
 * and leaves a reader another Space still supplies removed with them.
 */
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { asSpaceId, asUserId, asWorkspaceId, asWorkstreamId, type SpaceId, type UserId } from "@rally/contracts";

import { workstreamDOName } from "../src/durable-objects/names";
import type { ObservedChannel as Observed } from "../src/durable-objects/workstream-access-protocol";

/** Its own workspace: object names are shared across files, storage is not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000ac500");
const CHANNEL_ID = asWorkstreamId("00000000-0000-7000-8000-0000000ac501");
const SPACE_A = asSpaceId("00000000-0000-7000-8000-0000000ac502");
const SPACE_B = asSpaceId("00000000-0000-7000-8000-0000000ac503");
const OWNER = asUserId("00000000-0000-7000-8000-0000000ac504");
const READER = asUserId("00000000-0000-7000-8000-0000000ac505");
const OTHER = asUserId("00000000-0000-7000-8000-0000000ac506");

const channel = () => env.WORKSTREAM_DOS.getByName(workstreamDOName("global", WORKSPACE_ID, CHANNEL_ID));
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
  });
}

/**
 * Apply a source, then commit it with exactly what the plan said to seat.
 *
 * Two calls because the object takes two: the application is a plan and the
 * confirmation is what writes the source. A caller that stops after the first
 * has changed nothing here.
 */
async function seatSource(input: Parameters<typeof applySource>[0]) {
  const applied = await applySource(input);
  if (!applied.ok) throw new Error(`apply_refused:${applied.code}`);
  const confirmed = await confirmSource(input, applied.plan.seatUserIds);
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
  await runInDurableObject(channel(), (_instance, state) => {
    // The identity row every RPC asserts its address against. Written directly
    // because these tests are about the provenance tables, not about how a
    // Channel comes to exist.
    state.storage.sql.exec(
      `INSERT INTO workstream_metadata
         (id, workspace_id, workstream_id, region, authority_generation, title, description,
          preview, scope, exact_state, last_activity_at, created_at, updated_at)
       VALUES (1, ?, ?, 'global', 1, 'Hiring', '', '', 'personal', 'idle', 1, 1, 1)`,
      WORKSPACE_ID,
      CHANNEL_ID,
    );
    state.storage.sql.exec(
      `INSERT INTO conversation_children (substream_id, kind, created_by_user_id, created_at, status, updated_at)
       VALUES ('0', 'main', ?, 1, 'ready', 1)`,
      OWNER,
    );
  });
});

describe("a Channel's Space access sources", () => {
  it("given a personal Space, when it is applied, then it plans to seat only readers the Channel lacks", async () => {
    const seated = await seatSource({
      spaceId: SPACE_A, scope: "personal", participantUserIds: [OWNER, READER],
      channel: personal([OWNER]),
    });

    expect(seated.applied).toEqual({ ok: true, plan: { widenScope: false, seatUserIds: [READER] } });
    // The Channel's own audience is recorded from what the caller observed, so
    // a Channel created after migration 18 — whose backfill could only guess —
    // is exact from the first Space that reaches it. `READER` is out of the
    // direct source because this Space is what seated them: that is the whole
    // difference between a reader the Channel holds and one a Space supplies.
    expect(await channel().readAccessSources({ ...address, channel: personal([OWNER, READER]) }))
      .toEqual({
        direct: { scope: "personal", participantUserIds: [OWNER] },
        spaces: [{ spaceId: SPACE_A, scope: "personal", participantUserIds: [OWNER, READER] }],
      });
  });

  it("given an application nothing confirmed, when the Channel is read, then no source claims it", async () => {
    // The crash window the confirmation closes. A source recorded by the
    // application would survive a caller that died before seating anybody,
    // and would then claim a Space reaches this Channel while having supplied
    // no reader — provenance accounting for access that does not exist, which
    // the next retraction would act on.
    expect(await applySource({
      spaceId: SPACE_A, scope: "personal", participantUserIds: [OWNER, READER],
      channel: personal([OWNER]),
    })).toEqual({ ok: true, plan: { widenScope: false, seatUserIds: [READER] } });

    expect(await channel().readAccessSources({ ...address, channel: personal([OWNER]) }))
      .toEqual({ direct: { scope: "personal", participantUserIds: [OWNER] }, spaces: [] });
    await runInDurableObject(channel(), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT space_id FROM workstream_space_access_sources").toArray()).toEqual([]);
      // And the Channel's own scope is still unestablished, so the first
      // Space that *does* commit still seeds it from what it observed.
      expect(state.storage.sql.exec<{ updated_at: number }>(
        "SELECT updated_at FROM workstream_direct_audience WHERE id = 1",
      ).one().updated_at).toBe(0);
    });
  });

  it("given an Organization-wide Space, when it is applied, then it widens the scope and seats nobody", async () => {
    // Everyone can already read once the Channel is Organization-wide, so a
    // participant row would add no access and would have to be withdrawn later
    // as though it had.
    expect(await applySource({
      spaceId: SPACE_A, scope: "workspace", participantUserIds: [OWNER, READER],
      channel: personal([OWNER]),
    })).toEqual({ ok: true, plan: { widenScope: true, seatUserIds: [] } });
  });

  it("given a seated reader, when their Space is retracted, then only that reader is withdrawn", async () => {
    await seatSource({
      spaceId: SPACE_A, scope: "personal", participantUserIds: [READER],
      channel: personal([OWNER]),
    });

    const retracted = await retract(SPACE_A, personal([OWNER, READER]));

    expect(retracted).toEqual({
      ok: true,
      plan: { narrowScope: false, seatUserIds: [], removeUserIds: [READER] },
    });
    await runInDurableObject(channel(), (_instance, state) => {
      // The cascade, which is what makes "a source that no longer exists stops
      // granting" true of the provenance too.
      expect(state.storage.sql.exec("SELECT space_id FROM workstream_space_access_sources").toArray()).toEqual([]);
      expect(state.storage.sql.exec("SELECT user_id FROM workstream_space_supplied_readers").toArray()).toEqual([]);
    });
  });

  it("given a reader two Spaces supply, when one is retracted, then the reader stays", async () => {
    await seatSource({
      spaceId: SPACE_A, scope: "personal", participantUserIds: [READER],
      channel: personal([OWNER]),
    });
    // The second Space lists the same reader plus one of its own. It seats only
    // the one the Channel lacks, which is why the provenance and the source's
    // roster are different sets.
    const second = await seatSource({
      spaceId: SPACE_B, scope: "personal", participantUserIds: [READER, OTHER],
      channel: personal([OWNER, READER]),
    });
    expect(second.applied.ok && second.applied.plan.seatUserIds).toEqual([OTHER]);

    const retracted = await retract(SPACE_A, personal([OWNER, READER, OTHER]));

    // `READER` was seated by Space A and is still listed by Space B, so the
    // union that survives the retraction keeps them. This is the assertion the
    // negative control breaks.
    expect(retracted).toEqual({
      ok: true,
      plan: { narrowScope: false, seatUserIds: [], removeUserIds: [] },
    });
  });

  it("given a reader the Channel also holds directly, when their Space is retracted, then the reader stays", async () => {
    await seatSource({
      spaceId: SPACE_A, scope: "personal", participantUserIds: [READER],
      channel: personal([OWNER]),
    });
    // A direct add is the Channel taking responsibility for somebody: whichever
    // Space seated them first, they are here on the Channel's own account now.
    await channel().noteDirectReader({ ...address, userId: READER });

    expect(await retract(SPACE_A, personal([OWNER, READER]))).toEqual({
      ok: true,
      plan: { narrowScope: false, seatUserIds: [], removeUserIds: [] },
    });
  });

  it("given nothing else is Organization-wide, when the wide Space is retracted, then the scope narrows and survivors are seated", async () => {
    await seatSource({
      spaceId: SPACE_A, scope: "workspace", participantUserIds: [READER],
      channel: personal([OWNER]),
    });
    // Applied while everybody could already read, so it seated nobody: the
    // readers it supplies exist only as its roster until the audience stops
    // being Organization-wide.
    await seatSource({
      spaceId: SPACE_B, scope: "personal", participantUserIds: [OTHER],
      channel: organizationWide([OWNER]),
    });

    expect(await retract(SPACE_A, organizationWide([OWNER]))).toEqual({
      ok: true,
      plan: { narrowScope: true, seatUserIds: [OWNER, OTHER], removeUserIds: [] },
    });
  });

  it("given a survivor a remaining Space supplies, when the wide Space is retracted, then attributing them there is what withdraws them with it", async () => {
    await seatSource({
      spaceId: SPACE_A, scope: "workspace", participantUserIds: [READER],
      channel: personal([OWNER]),
    });
    await seatSource({
      spaceId: SPACE_B, scope: "personal", participantUserIds: [OTHER],
      channel: organizationWide([OWNER]),
    });

    expect(await retract(SPACE_A, organizationWide([OWNER]))).toEqual({
      ok: true,
      plan: { narrowScope: true, seatUserIds: [OWNER, OTHER], removeUserIds: [] },
    });

    // The departing Space is not an option for the attribution, and not merely
    // as a matter of labelling: the retraction above deleted its row, so
    // naming it here is refused outright and `OTHER` ends up supplied by
    // nobody.
    expect(await channel().confirmSpaceAccessSource({
      ...address, spaceId: SPACE_A, operationId: crypto.randomUUID(), seatedUserIds: [OTHER],
    })).toEqual({ ok: false, code: "space_not_found" });

    // The Space that does supply them, which is what the service seats them
    // under.
    expect(await channel().confirmSpaceAccessSource({
      ...address, spaceId: SPACE_B, operationId: crypto.randomUUID(), seatedUserIds: [OTHER],
    })).toEqual({ ok: true, suppliedUserIds: [OTHER] });

    // And that is what the *next* retraction reads. Without it `SPACE_B`
    // departs with no provenance for `OTHER` and leaves behind a reader the
    // Channel itself never admitted.
    expect(await retract(SPACE_B, personal([OWNER, OTHER]))).toEqual({
      ok: true,
      plan: { narrowScope: false, seatUserIds: [], removeUserIds: [OTHER] },
    });
  });

  it("given a remaining Space that is Organization-wide, when another is retracted, then nothing narrows", async () => {
    await seatSource({
      spaceId: SPACE_A, scope: "workspace", participantUserIds: [READER],
      channel: personal([OWNER]),
    });
    await seatSource({
      spaceId: SPACE_B, scope: "workspace", participantUserIds: [OTHER],
      channel: organizationWide([OWNER]),
    });

    expect(await retract(SPACE_A, organizationWide([OWNER]))).toEqual({
      ok: true,
      plan: { narrowScope: false, seatUserIds: [], removeUserIds: [] },
    });
  });

  it("given a staged application, when a newer one already landed, then the stale revision is refused", async () => {
    const newer = {
      spaceId: SPACE_A, scope: "personal" as const, participantUserIds: [READER],
      channel: personal([OWNER]), spaceRevision: 4, membershipGeneration: 2,
    };
    await seatSource(newer);

    // Re-read inside the transaction, after every external boundary the caller
    // crossed to get here: a staged application that lost the race must not
    // overwrite the newer one with the Space it saw. Both halves refuse, the
    // plan so the caller never runs the canonical operations and the
    // confirmation because that is where the write would land.
    const stale = {
      spaceId: SPACE_A, scope: "workspace" as const, participantUserIds: [READER, OTHER],
      channel: personal([OWNER]), spaceRevision: 3, membershipGeneration: 9,
    };
    expect(await applySource(stale)).toEqual({ ok: false, code: "space_revision_conflict" });
    expect(await confirmSource(stale, [])).toEqual({ ok: false, code: "space_revision_conflict" });
    expect(await applySource({ ...stale, spaceRevision: 4, membershipGeneration: 1 }))
      .toEqual({ ok: false, code: "space_revision_conflict" });

    expect(await channel().readAccessSources({ ...address, channel: personal([OWNER, READER]) }))
      .toMatchObject({ spaces: [{ spaceId: SPACE_A, scope: "personal", participantUserIds: [READER] }] });
  });

  it("given an operation that already ran, when it is replayed, then it returns its first answer without reapplying", async () => {
    const operationId = crypto.randomUUID();
    const staged = {
      spaceId: SPACE_A, scope: "personal" as const, participantUserIds: [READER],
      channel: personal([OWNER]), operationId,
    };
    const first = await applySource(staged);
    await confirmSource(staged, [READER]);

    // The replay observes a Channel that has moved on — `READER` is seated now
    // — and still answers what the first attempt did. Recomputing would report
    // an empty seating plan and the caller would never learn who it owed.
    const replay = await applySource({
      spaceId: SPACE_A, scope: "personal", participantUserIds: [READER],
      channel: personal([OWNER, READER]), operationId,
    });

    expect(replay).toEqual(first);
    expect(replay).toEqual({ ok: true, plan: { widenScope: false, seatUserIds: [READER] } });
  });

  it("given a direct narrowing, when a Space is still Organization-wide, then it is refused by name", async () => {
    await seatSource({
      spaceId: SPACE_A, scope: "workspace", participantUserIds: [READER],
      channel: personal([OWNER]),
    });

    // The effective audience would stay Organization-wide, so recording the
    // narrowing would leave the record disagreeing with the Channel.
    expect(await channel().setDirectScope({ ...address, scope: "personal", operationId: crypto.randomUUID() }))
      .toEqual({ ok: false, code: "channel_scope_locked_by_space" });
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
    // private although it was Organization-wide, and the next retraction would
    // narrow a Channel that was never private.
    await seatSource({
      spaceId: SPACE_A, scope: "personal", participantUserIds: [READER],
      channel: organizationWide([OWNER]),
    });
    expect(await channel().readAccessSources({ ...address, channel: organizationWide([OWNER, READER]) }))
      .toMatchObject({ direct: { scope: "workspace" } });
  });

  it("given an attribution whose source was withdrawn first, when it runs, then it is refused by name", async () => {
    await seatSource({
      spaceId: SPACE_A, scope: "personal", participantUserIds: [READER],
      channel: personal([OWNER]),
    });
    await retract(SPACE_A, personal([OWNER, READER]));

    // A confirmation with no source of its own is attributing readers to a
    // Space that is supposed to already be here — what a narrowing does when
    // it seats readers a Space has supplied all along. Silently converging
    // would leave those readers attributed to nothing, which reads as direct
    // access nobody granted; the caller has to retract again instead.
    expect(await channel().confirmSpaceAccessSource({
      ...address, spaceId: SPACE_A, operationId: crypto.randomUUID(), seatedUserIds: [OTHER],
    })).toEqual({ ok: false, code: "space_not_found" });
  });

  it("given a Space already here, when a narrowing attributes the readers it seats, then they become its own", async () => {
    // The other confirmation: no source, because this Space was committed when
    // it arrived. It supplied `OTHER` all along and seated nobody, because
    // everybody could read; the narrowing seats them and says so here, without
    // which the next retraction reads them as the Channel's own.
    await seatSource({
      spaceId: SPACE_A, scope: "personal", participantUserIds: [OTHER],
      channel: organizationWide([OWNER]),
    });
    expect(await channel().setDirectScope({ ...address, scope: "personal", operationId: crypto.randomUUID() }))
      .toEqual({ ok: true, previousScope: "workspace", previousObserved: true });

    expect(await channel().confirmSpaceAccessSource({
      ...address, spaceId: SPACE_A, operationId: crypto.randomUUID(), seatedUserIds: [OTHER],
    })).toEqual({ ok: true, suppliedUserIds: [OTHER] });

    // Withdrawn with the Space, which is what the attribution bought. Without
    // it the retraction finds no provenance for `OTHER` and leaves behind a
    // reader the Channel never granted anything to.
    expect(await retract(SPACE_A, personal([OWNER, OTHER]))).toEqual({
      ok: true,
      plan: { narrowScope: false, seatUserIds: [], removeUserIds: [OTHER] },
    });
  });

  it("given two audience changes interleaved, when the older one converges, then it is refused", async () => {
    // Two audience changes on one Space, reaching this Channel out of order.
    // Both converge by retract-then-apply, and the retraction is what deletes
    // the row the application and the confirmation fence on — so the older one
    // has to be refused *here* or it finds nothing to lose to and installs its
    // stale roster over the newer audience.
    await seatSource({
      spaceId: SPACE_A, scope: "personal", participantUserIds: [OWNER, READER],
      channel: personal([OWNER]), spaceRevision: 2,
    });

    expect(await channel().retractSpaceAccessSource({
      ...address, spaceId: SPACE_A, operationId: crypto.randomUUID(),
      expectedSpaceRevision: 1, channel: personal([OWNER, READER]),
    })).toEqual({ ok: false, code: "space_revision_conflict" });
    // Refused rather than partly applied: the source the newer change
    // committed is still here, with its roster.
    expect(await channel().readAccessSources({ ...address, channel: personal([OWNER, READER]) }))
      .toMatchObject({ spaces: [{ spaceId: SPACE_A, participantUserIds: [OWNER, READER] }] });

    // The newer change's own convergence is not refused by its own fence.
    expect(await channel().retractSpaceAccessSource({
      ...address, spaceId: SPACE_A, operationId: crypto.randomUUID(),
      expectedSpaceRevision: 2, channel: personal([OWNER, READER]),
    })).toMatchObject({ ok: true });
  });

  it("given a source that is already gone, when it is retracted again, then it converges on an empty plan", async () => {
    // Access is live: a source that does not exist grants nothing, and a
    // retraction reissued under a new operation id after a crash has to finish.
    expect(await retract(SPACE_A, personal([OWNER]))).toEqual({
      ok: true,
      plan: { narrowScope: false, seatUserIds: [], removeUserIds: [] },
    });
  });
});
