/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A conversation's Sidekick attachments reach its parent on the
 * `directory_common` effect, which is how a Channel rail learns Main's list.
 *
 * Driven on a real SubstreamAgent: the attach a Sidekick skill load makes, the
 * removal the REST rail makes, and migration 71's one report for an object
 * that attached Sidekicks before the effect carried them. The effects stay in
 * the outbox (`useHeldEffectQueue`) and are read from there.
 * `docs/workstream-durable-object.md` owns the effect.
 */

import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { asSubstreamId, type ConversationEffectEnvelope, type WorkstreamWorkflowInput } from "@rally/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { conversationObjectName } from "../src/durable-objects/names";
import { SubstreamLoopStorage } from "../src/durable-objects/substream-loop-storage";
import { sidekickSkillRef } from "../src/services/sidekick-skills";
import { pendingChildEffects } from "./helpers/conversation-effects";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import {
  LOOP_ID,
  WORKSPACE_ID,
  WORKSTREAM_ID,
  boot,
  runInput,
  seedOpenWorkstreamAuthority,
  seedWorkstreamRoot,
} from "./helpers/substream-fixture";

useHeldEffectQueue();

beforeEach(async () => {
  await seedOpenWorkstreamAuthority(env.DB);
});

const SIDEKICK_A = "00000000-0000-4000-8000-0000000d7101";
const SIDEKICK_B = "00000000-0000-4000-8000-0000000d7102";
const RUN_ID = "00000000-0000-7000-8000-0000000d7103";

let unique = 0;
/** A fresh conversation per test; a reused id would carry the last test's rows. */
function conversation(): DurableObjectStub {
  unique += 1;
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName(
    "global", WORKSPACE_ID, WORKSTREAM_ID,
    asSubstreamId(`00000000-0000-7000-8000-${String(unique).padStart(12, "7")}`),
  )));
}

/** The attachment list each queued `directory_common` effect carried, oldest first. */
async function reportedLists(stub: DurableObjectStub): Promise<Array<string[] | undefined>> {
  return (await pendingChildEffects(stub))
    .map((envelope: ConversationEffectEnvelope) => envelope.effect)
    .flatMap((effect) => effect.kind === "directory_common" ? [effect.sidekickAttachmentIds] : []);
}

interface AgentInternals {
  activeLoopExecution: { runId: string; leaseOwner: string; executionEpoch: number } | null;
  persistentLoopRuntime(input: WorkstreamWorkflowInput): { activateSidekickSkill(ref: string): void | Promise<void> };
}

describe("a conversation's Sidekick attachments on its directory effect", () => {
  it("reports the new list when a skill load attaches a Sidekick, and only when the list moved", async () => {
    const stub = conversation();
    await boot(stub);
    await runInDurableObject(stub, async (instance, state) => {
      seedWorkstreamRoot(state);
      const now = Date.now();
      // The loop fence the runtime checks, as an executing loop leaves it.
      new SubstreamLoopStorage(state.storage).ensureLoop({ loopId: LOOP_ID, bindStateRevision: 0, now });
      state.storage.sql.exec(`UPDATE substream_loops SET status = 'executing', active_execution_id = ?,
        active_execution_epoch = 1, lease_owner = 'attach-test', lease_expires_at = ?`, RUN_ID, now + 600_000);
      state.storage.sql.exec(`INSERT INTO sidekick_execution_skills (execution_id, snapshot_json) VALUES (?, ?)`,
        RUN_ID, JSON.stringify({ activeRefs: [], sources: [SIDEKICK_A, SIDEKICK_B].map((id) => ({
          id, revision: 1, loadable: true, name: `Sidekick ${id.slice(-1)}`, description: "", whenToUse: "", instructions: "",
        })) }));
      const agent = instance as unknown as AgentInternals;
      agent.activeLoopExecution = { runId: RUN_ID, leaseOwner: "attach-test", executionEpoch: 1 };
      const runtime = agent.persistentLoopRuntime(runInput(RUN_ID));
      await runtime.activateSidekickSkill(sidekickSkillRef(SIDEKICK_B));
      await runtime.activateSidekickSkill(sidekickSkillRef(SIDEKICK_A));
      // Loading one already attached changes nothing the parent is told.
      await runtime.activateSidekickSkill(sidekickSkillRef(SIDEKICK_B));
    });

    const lists = await reportedLists(stub);
    expect(lists.at(-1)).toHaveLength(2);
    expect(new Set(lists.at(-1))).toEqual(new Set([SIDEKICK_A, SIDEKICK_B]));
    expect(lists.filter((list) => list?.length === 2)).toHaveLength(1);
  });

  it("reports the shorter list when the rail removes one", async () => {
    const stub = conversation();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      state.storage.sql.exec(`INSERT INTO sidekick_attachments (sidekick_id, attached_at) VALUES (?, 1), (?, 2)`,
        SIDEKICK_A, SIDEKICK_B);
    });
    const remote = stub as unknown as {
      sidekickAttachments(input: { workspaceId: string; workstreamId: string; removeId?: string }): Promise<string[]>;
    };

    expect(await remote.sidekickAttachments({ workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, removeId: SIDEKICK_A }))
      .toEqual([SIDEKICK_B]);
    expect(await reportedLists(stub)).toEqual([[SIDEKICK_B]]);

    // Removing one that is not attached is not a change.
    await remote.sidekickAttachments({ workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, removeId: SIDEKICK_A });
    expect(await reportedLists(stub)).toEqual([[SIDEKICK_B]]);
  });

  it("reports an older conversation's list once, the first time it wakes as an authority", async () => {
    const stub = conversation();
    await boot(stub);
    // An object that attached a Sidekick before the effect carried the list,
    // and has had nothing to project since.
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      state.storage.sql.exec(`INSERT INTO sidekick_attachments (sidekick_id, attached_at) VALUES (?, 1)`, SIDEKICK_A);
    });
    expect(await reportedLists(stub)).toEqual([]);

    await evictDurableObject(stub);
    await boot(stub);
    expect(await reportedLists(stub)).toEqual([[SIDEKICK_A]]);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT id FROM sidekick_attachment_projection_pending`).toArray()).toEqual([]);
    });

    await evictDurableObject(stub);
    await boot(stub);
    expect(await reportedLists(stub)).toEqual([[SIDEKICK_A]]);
  });
});
