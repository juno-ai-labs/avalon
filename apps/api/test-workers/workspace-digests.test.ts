/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The digest domain's claims and settlements, against the object that owns
 * them.
 *
 * Three of these lifecycle moments were read-then-write sequences through the
 * workspace runtime facade, each a separate round trip: the first save of a
 * digest read "nothing yet" before inserting, an occurrence claim relied on a
 * unique constraint it could not answer for, and settlement read the status
 * before writing it. Inside the object each is one critical section with a
 * returned witness, so the racing caller learns it lost instead of 500ing or
 * repeating a side effect.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import {
  WorkspaceDigestClaimResultSchema,
  WorkspaceDigestDefaultResultSchema,
  WorkspaceDigestReplaceResultSchema,
  WorkspaceDigestSettingsSchema,
  WorkspaceDigestSettleResultSchema,
} from "../src/durable-objects/workspace-digests-protocol";

/** Its own workspace: a shared id makes this file queue behind its siblings. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000ca0");
const RECIPIENT = asUserId("00000000-0000-7000-8000-000000000ca1");
const AT = "2026-08-29T00:00:00.000Z";
const PLANNED_FOR = "2026-08-29T09:00:00.000Z";

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

let sequence = 0;
function nextId(): string {
  sequence += 1;
  return `00000000-0000-7000-8000-${String(sequence).padStart(12, "0")}`;
}

function replaceRequest(overrides: {
  scheduleId?: string;
  enabled?: boolean;
  times?: number[];
  scheduleRows?: Array<{ id: string; rrule: string; nextRunAt: string }>;
} = {}) {
  return {
    workspaceId: WORKSPACE_ID,
    userId: RECIPIENT,
    scheduleId: overrides.scheduleId ?? nextId(),
    dayMask: 62,
    enabled: overrides.enabled ?? true,
    executionPrincipalJson: JSON.stringify({ type: "user", userId: RECIPIENT }),
    times: overrides.times ?? [9 * 60],
    targets: [{
      id: nextId(),
      targetType: "email",
      connectionId: null,
      providerTenantId: null,
      providerUserId: null,
      emailAddress: "recipient@example.com",
    }],
    scheduleRows: overrides.scheduleRows ?? [],
    timezone: "Europe/London",
    at: AT,
  };
}

async function replace(overrides: Parameters<typeof replaceRequest>[0] = {}) {
  return WorkspaceDigestReplaceResultSchema.parse(
    await workspace().replaceDigestSchedule(replaceRequest(overrides)),
  );
}

async function settings() {
  return WorkspaceDigestSettingsSchema.parse(
    await workspace().digestSettings({ workspaceId: WORKSPACE_ID, userId: RECIPIENT }),
  );
}

async function claim(overrides: {
  deliveryId?: string;
  digestScheduleId: string;
  plannedFor?: string;
  status?: "empty" | "planned";
  cursorThrough?: number;
}) {
  return WorkspaceDigestClaimResultSchema.parse(await workspace().claimDigestDelivery({
    workspaceId: WORKSPACE_ID,
    deliveryId: overrides.deliveryId ?? nextId(),
    digestScheduleId: overrides.digestScheduleId,
    userId: RECIPIENT,
    plannedFor: overrides.plannedFor ?? PLANNED_FOR,
    cursorFrom: null,
    cursorThrough: overrides.cursorThrough ?? 4,
    eventCount: 4,
    highlightCount: 1,
    status: overrides.status ?? "planned",
    at: AT,
  }));
}

async function settle(deliveryId: string, status: "delivered" | "failed" = "delivered") {
  return WorkspaceDigestSettleResultSchema.parse(await workspace().settleDigestDelivery({
    workspaceId: WORKSPACE_ID,
    deliveryId,
    status,
    errorJson: status === "failed" ? JSON.stringify({ code: "digest_not_delivered" }) : null,
    at: AT,
  }));
}

beforeEach(async () => {
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(`DELETE FROM digest_deliveries`);
    state.storage.sql.exec(`DELETE FROM schedules WHERE digest_schedule_id IS NOT NULL`);
    state.storage.sql.exec(`DELETE FROM digest_schedule_times`);
    state.storage.sql.exec(`DELETE FROM digest_delivery_targets`);
    state.storage.sql.exec(`DELETE FROM digest_schedules`);
  });
}, 30_000);

describe("saving a digest", () => {
  it("creates on the first save and updates in place on the next", async () => {
    const first = await replace();
    expect(first.outcome).toBe("created");

    const second = await replace({ times: [17 * 60] });

    expect(second).toEqual({ scheduleId: first.scheduleId, outcome: "updated" });
    const state = await settings();
    expect(state.schedule?.id).toBe(first.scheduleId);
    expect(state.times).toEqual([17 * 60]);
  });

  it("converges two racing first saves on one digest instead of 500ing the loser", async () => {
    // The defect the round trips allowed: both saves read "nothing yet", both
    // inserted, and `UNIQUE (workspace_id, user_id)` refused whichever landed
    // second. Inside the object the existence check and the write share one
    // critical section, so the second save becomes the update it meant to be.
    const results = await Promise.all([replace(), replace()]);

    expect(results.map((result) => result.outcome).sort()).toEqual(["created", "updated"]);
    expect(new Set(results.map((result) => result.scheduleId)).size).toBe(1);
    expect((await settings()).schedule?.id).toBe(results[0]!.scheduleId);
  });

  it("reports the earliest derived occurrence as the next run", async () => {
    await replace({
      scheduleRows: [
        { id: nextId(), rrule: "FREQ=WEEKLY;BYDAY=MO", nextRunAt: "2026-08-31T09:00:00.000Z" },
        { id: nextId(), rrule: "FREQ=WEEKLY;BYDAY=SA", nextRunAt: "2026-08-29T09:00:00.000Z" },
      ],
    });

    expect((await settings()).nextRunAt).toBe("2026-08-29T09:00:00.000Z");
  });
});

describe("the on-by-default digest", () => {
  it("creates the default once and answers with the existing digest after", async () => {
    const request = () => workspace().ensureDefaultDigestSchedule({
      workspaceId: WORKSPACE_ID,
      userId: RECIPIENT,
      scheduleId: nextId(),
      targetId: nextId(),
      dayMask: 62,
      minuteOfDay: 9 * 60,
      emailAddress: "recipient@example.com",
      executionPrincipalJson: JSON.stringify({ type: "user", userId: RECIPIENT }),
      at: AT,
    });
    const first = WorkspaceDigestDefaultResultSchema.parse(await request());
    expect(first.created).toBe(true);
    expect(first.times).toEqual([9 * 60]);

    const second = WorkspaceDigestDefaultResultSchema.parse(await request());

    expect(second.created).toBe(false);
    expect(second.schedule.id).toBe(first.schedule.id);
  });

  it("never resurrects a digest somebody switched off", async () => {
    const saved = await replace({ enabled: false });

    const ensured = WorkspaceDigestDefaultResultSchema.parse(
      await workspace().ensureDefaultDigestSchedule({
        workspaceId: WORKSPACE_ID,
        userId: RECIPIENT,
        scheduleId: nextId(),
        targetId: nextId(),
        dayMask: 62,
        minuteOfDay: 9 * 60,
        emailAddress: "recipient@example.com",
        executionPrincipalJson: JSON.stringify({ type: "user", userId: RECIPIENT }),
        at: AT,
      }),
    );

    // Switching off keeps the row with enabled = 0, so absence stays the one
    // unambiguous signal that nobody has ever had a digest here.
    expect(ensured).toMatchObject({
      created: false,
      schedule: { id: saved.scheduleId, enabled: false },
    });
  });
});

describe("claiming an occurrence", () => {
  it("hands a retried alarm the claim the first attempt already took", async () => {
    const { scheduleId } = await replace();
    expect(await claim({ digestScheduleId: scheduleId })).toEqual({ outcome: "claimed" });

    expect(await claim({ digestScheduleId: scheduleId })).toEqual({ outcome: "already_planned" });
  });

  it("lets exactly one of two concurrent claims win an occurrence", async () => {
    const { scheduleId } = await replace();

    const outcomes = await Promise.all([
      claim({ digestScheduleId: scheduleId }),
      claim({ digestScheduleId: scheduleId }),
    ]);

    expect(outcomes.map((result) => result.outcome).sort()).toEqual(["already_planned", "claimed"]);
  });

  it("releases a claim only while it is still planned", async () => {
    const { scheduleId } = await replace();
    const deliveryId = nextId();
    await claim({ deliveryId, digestScheduleId: scheduleId });
    await workspace().markDigestDeliveryRunning({
      workspaceId: WORKSPACE_ID,
      deliveryId,
      harnessRunId: "run-1",
      at: AT,
    });

    // A launch that recorded its run keeps the occurrence: deleting it now
    // would let the scheduler's retry digest the same window twice.
    expect(await workspace().releaseDigestDeliveryClaim({
      workspaceId: WORKSPACE_ID,
      deliveryId,
    })).toEqual({ outcome: "kept" });
  });

  it("says so when the running transition finds no planned claim", async () => {
    const { scheduleId } = await replace();
    const deliveryId = nextId();
    await claim({ deliveryId, digestScheduleId: scheduleId });

    const mark = (harnessRunId: string) => workspace().markDigestDeliveryRunning({
      workspaceId: WORKSPACE_ID,
      deliveryId,
      harnessRunId,
      at: AT,
    });

    expect(await mark("run-1")).toEqual({ outcome: "running" });
    // The claim has already left `planned`, so a second transition must answer
    // rather than silently matching zero rows.
    expect(await mark("run-2")).toEqual({ outcome: "not_planned" });
  });

  it("folds a failed window into the next cursor and counts everything else", async () => {
    const { scheduleId } = await replace();
    const failedId = nextId();
    await claim({ deliveryId: failedId, digestScheduleId: scheduleId, cursorThrough: 9 });
    await settle(failedId, "failed");
    await claim({
      digestScheduleId: scheduleId,
      plannedFor: "2026-08-29T12:00:00.000Z",
      status: "empty",
      cursorThrough: 6,
    });

    // The failed occurrence's window comes back — its cursor does not count —
    // while an empty one still advances, so its window is never re-scanned.
    expect(await workspace().latestDigestCursor({
      workspaceId: WORKSPACE_ID,
      digestScheduleId: scheduleId,
    })).toEqual({ cursorThrough: 6 });
  });
});

describe("settling a delivery", () => {
  it("lets exactly one settlement attempt own the side effects", async () => {
    // The two-consumer shape: a retried workflow step whose first attempt is
    // still in flight. Both read an unsettled status, both delivered, and both
    // then emitted the terminal telemetry and appended the delivery note. The
    // compare-and-set's witness is what tells the loser to stand down.
    const { scheduleId } = await replace();
    const deliveryId = nextId();
    await claim({ deliveryId, digestScheduleId: scheduleId });

    expect(await settle(deliveryId)).toEqual({ outcome: "settled" });
    expect(await settle(deliveryId)).toEqual({ outcome: "already_settled" });
  });

  it("says a delivery that never existed is not one that settled", async () => {
    expect(await settle(nextId())).toEqual({ outcome: "not_found" });
  });
});

describe("delivery targets", () => {
  it("serves an occurrence its schedule's frozen destinations", async () => {
    const { scheduleId } = await replace();
    const deliveryId = nextId();
    await claim({ deliveryId, digestScheduleId: scheduleId });

    const result = await workspace().digestDeliveryTargets({
      workspaceId: WORKSPACE_ID,
      deliveryId,
      userId: RECIPIENT,
    });

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]).toMatchObject({
      targetType: "email",
      emailAddress: "recipient@example.com",
      lastDeliveredDeliveryId: null,
    });
  });

  it("records a destination's copy so a retried step skips it", async () => {
    const { scheduleId } = await replace();
    const deliveryId = nextId();
    await claim({ deliveryId, digestScheduleId: scheduleId });
    const target = (await workspace().digestDeliveryTargets({
      workspaceId: WORKSPACE_ID,
      deliveryId,
      userId: RECIPIENT,
    })).targets[0]!;

    expect(await workspace().markDigestTargetDelivered({
      workspaceId: WORKSPACE_ID,
      targetId: target.id,
      deliveryId,
      at: AT,
    })).toEqual({ outcome: "recorded" });
    const after = await workspace().digestDeliveryTargets({
      workspaceId: WORKSPACE_ID,
      deliveryId,
      userId: RECIPIENT,
    });
    expect(after.targets[0]?.lastDeliveredDeliveryId).toBe(deliveryId);
  });

  it("answers with the outcome rather than a counter when the target is gone", async () => {
    expect(await workspace().markDigestTargetDelivered({
      workspaceId: WORKSPACE_ID,
      targetId: nextId(),
      deliveryId: nextId(),
      at: AT,
    })).toEqual({ outcome: "target_not_found" });
  });
});

describe("workspace identity", () => {
  it("refuses a request addressed to a different workspace", async () => {
    // Settled once, by hand: an RPC promise is a pipelining thenable, and
    // `rejects.toThrow` reads through it a second time, which surfaces the same
    // rejection again as an unhandled error and fails the run. The RPC layer
    // can still print an uncaught-exception notice for its own copy of the
    // rejection — the sibling identity tests print the same one — so the run's
    // exit code, not a quiet log, is what says this file passed.
    const outcome = await workspace().digestSettings({
      workspaceId: asWorkspaceId("00000000-0000-7000-8000-000000000cae"),
      userId: RECIPIENT,
    }).then(() => null, (error: unknown) => error);
    expect(String(outcome)).toContain("workspace_object_identity_mismatch");
  });
});
