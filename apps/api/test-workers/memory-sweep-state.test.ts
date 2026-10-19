/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The memory sweep's cursor and cadence, reached the way the Queue consumer
 * reaches them: through the scheduling port, over the real binding.
 *
 * The Node suite runs the same SQL through the port's in-isolate seam, which
 * passes arguments by reference and arms no alarm. Two things only the real
 * dispatch shows: that what a settle carries survives the trip (a closure does
 * not), and that a sweep write from outside the object leaves its alarm at the
 * time the row asks to be tried again. `docs/agent-memory.md` owns the lane.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { conversationObjectName } from "../src/durable-objects/names";
import { createSchedulingObjectPort } from "../src/runtime/scheduling-port";
import { WORKSPACE_ID, boot, seedOpenWorkstreamAuthority, seedWorkstreamRoot } from "./helpers/substream-fixture";

beforeEach(async () => {
  await seedOpenWorkstreamAuthority(env.DB);
});

const HOUR = 60 * 60_000;

let unique = 0;
/** A fresh conversation per test, addressed exactly as the port addresses it. */
function conversation(): { workstreamId: string; stub: DurableObjectStub } {
  unique += 1;
  const workstreamId = `00000000-0000-7000-8000-${String(unique).padStart(8, "0")}5e01`;
  return {
    workstreamId,
    stub: env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName("global", WORKSPACE_ID, workstreamId))),
  };
}

async function seeded(): Promise<{ workstreamId: string; stub: DurableObjectStub }> {
  const subject = conversation();
  await boot(subject.stub);
  await runInDurableObject(subject.stub, (_instance, state) => {
    seedWorkstreamRoot(state, 1, { workstreamId: subject.workstreamId });
  });
  return subject;
}

function sweepState(stub: DurableObjectStub) {
  return runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{
    swept_through_seq: number; rest_until: number; consecutive_quiet: number; claim_at: number | null; retry_at: number | null;
  }>(`SELECT swept_through_seq, rest_until, consecutive_quiet, claim_at, retry_at FROM memory_sweep_state WHERE id = 1`).one());
}

describe("the memory sweep state over the scheduling port", () => {
  it("settles a claim the consumer sends from outside the object", async () => {
    const { workstreamId, stub } = await seeded();
    const port = createSchedulingObjectPort(env, WORKSPACE_ID, workstreamId);
    const now = Date.now();
    const claim = await port.claimMemorySweep({ now, fromSeq: 0, toSeq: 12, restUntil: now + HOUR, claimTimeoutMs: 15 * 60_000 });
    expect(claim).toEqual({ attempt: 1 });

    expect(await port.settleMemorySweep({
      fromSeq: 0, toSeq: 12, attempt: 1, wrote: false, restFloorMs: HOUR, restCeilingMs: 24 * HOUR, now,
    })).toBe("settled");
    // A quiet sweep doubles the floor; nothing follows the range, so no retry.
    expect(await sweepState(stub)).toEqual({
      swept_through_seq: 12, rest_until: now + 2 * HOUR, consecutive_quiet: 1, claim_at: null, retry_at: null,
    });
  });

  it("arms the object's alarm at the rest when the consumer releases a claim", async () => {
    const { workstreamId, stub } = await seeded();
    const port = createSchedulingObjectPort(env, WORKSPACE_ID, workstreamId);
    const now = Date.now();
    const rest = now + HOUR;
    await port.claimMemorySweep({ now, fromSeq: 0, toSeq: 12, restUntil: rest, claimTimeoutMs: 15 * 60_000 });
    // Whatever the claim armed is gone: the release alone has to bring it back.
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
      expect(await state.storage.getAlarm()).toBeNull();
    });

    expect(await port.releaseMemorySweep({ attempt: 1, now })).toBe(true);

    expect(await sweepState(stub)).toMatchObject({ claim_at: null, retry_at: rest });
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(rest);
  });
});
