/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A finished run has to become visible without the reader doing anything.
 *
 * A run reaching a terminal state is a projection between Durable Objects, not
 * an HTTP mutation, so nothing in `workspaceSyncTopicsForMutation` ever bumped
 * the `automations` topic for it. `POST /automations/:id/run` published one and
 * the desktop refetched the run as `running`; the run then failed within
 * seconds and no second event was ever sent, so the automation screen went on
 * saying "Rally is working…" for as long as it stayed open. This is the hop
 * that now closes that gap, and the acknowledgement rule that keeps a lost hop
 * from pinning the same row at `running` server-side.
 *
 * Seeded through the real regional effect WorkstreamDO publishes, on real
 * workerd SQLite across both objects: the defect lived in what one object did
 * with the other's answer, which a stub can only assert about itself.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asAutomationId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import type { AutomationAgent } from "../src/durable-objects/automation-agent";
import { automationAgentName, workspaceDOName } from "../src/durable-objects/names";
import {
  type WorkstreamRegionalEffect,
  workstreamRegionalEffectHash,
} from "../src/durable-objects/workstream-regional-effect";

/** Its own workspace: a shared id makes this file queue behind its siblings. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000d1a00");
const AUTHOR = asUserId("00000000-0000-7000-8000-0000000d1a01");
const AUTOMATION_ID = asAutomationId("00000000-0000-7000-8000-0000000d1a10");
/** Projected into the directory, but its agent is never given an identity. */
const UNREACHABLE_AUTOMATION_ID = asAutomationId("00000000-0000-7000-8000-0000000d1a11");
const RUN_ID = "00000000-0000-7000-8000-0000000d1a20";
const UNREACHABLE_RUN_ID = "00000000-0000-7000-8000-0000000d1a21";
const WORKSTREAM_ID = "00000000-0000-7000-8000-0000000d1a30";
const UNREACHABLE_WORKSTREAM_ID = "00000000-0000-7000-8000-0000000d1a31";
const NOW = 1_800_000_000_000;

let sequence = 0;

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

function agent(automationId = AUTOMATION_ID) {
  return env.AUTOMATION_AGENTS.get(env.AUTOMATION_AGENTS.idFromName(
    automationAgentName("global", WORKSPACE_ID, automationId),
  ));
}

async function projectAutomation(automationId: string, title: string): Promise<void> {
  await workspace().applyAutomationProjection({
    schemaVersion: 1,
    automationId,
    workspaceId: WORKSPACE_ID,
    authorUserId: AUTHOR,
    authorityGeneration: 1,
    projectionVersion: 1,
    payloadHash: `hash-${automationId}-1`,
    lifecycle: "active",
    scope: "workspace",
    title,
    description: "",
    nextRunAt: null,
    attentionCode: null,
  });
}

/** One in-flight run, as the agent holds it once the work stream is open. */
async function seedRunningRun(): Promise<void> {
  await runInDurableObject(agent(), async (_instance: AutomationAgent, state) => {
    state.storage.sql.exec(
      `INSERT INTO automation_identity
         (id, automation_id, workspace_id, author_user_id, region, authority_generation,
          created_at, updated_at)
       VALUES (1, ?, ?, ?, 'global', 1, ?, ?)`,
      AUTOMATION_ID, WORKSPACE_ID, AUTHOR, NOW, NOW,
    );
    state.storage.sql.exec(
      `INSERT INTO automation_state
         (id, lifecycle, title, definition_revision, accepted_definition_revision,
          event_sequence, created_at, updated_at)
       VALUES (1, 'active', 'Weekly brief', 1, 1, 0, ?, ?)`,
      NOW, NOW,
    );
    state.storage.sql.exec(
      `INSERT INTO automation_runs
         (run_id, occurrence_key, trigger_type, workstream_id, workstream_generation,
          admission_state, execution_state, delivery_state, context_json,
          source_version, created_at, updated_at)
       VALUES (?, 'manual:visibility', 'manual', ?, 1, 'provisioned', 'running',
               'pending', '{}', 1, ?, ?)`,
      RUN_ID, WORKSTREAM_ID, NOW, NOW,
    );
  });
}

function terminalEnvelope(input: {
  automationId: string;
  runId: string;
  workstreamId: string;
  state: string;
  sourceVersion: number;
}) {
  sequence += 1;
  const effect: WorkstreamRegionalEffect = {
    kind: "directory_common",
    title: "Weekly brief",
    description: "",
    preview: "",
    scope: "workspace",
    state: input.state,
    systemKind: null,
    lastActivityAt: "2026-09-01T12:00:00.000Z",
    completedAt: "2026-09-01T12:00:00.000Z",
    archivedAt: null,
    originType: "automation",
    createdByUserId: AUTHOR,
    automationSubscriptionId: input.automationId,
    automationRunId: input.runId,
    plannedFor: null,
    latestAttentionOrdinal: 0,
    unreadTrackingStartOrdinal: 0,
  };
  return {
    kind: "workstream_regional_effect" as const,
    contractVersion: 1 as const,
    region: "global" as const,
    workspaceId: WORKSPACE_ID,
    workstreamId: asWorkstreamId(input.workstreamId),
    generation: 1,
    messageId: `00000000-0000-7000-8000-${String(sequence).padStart(12, "0")}`,
    partitionKey: "common",
    sourceVersion: input.sourceVersion,
    requiredProjectionVersion: null,
    payloadHash: workstreamRegionalEffectHash(effect),
    effect,
  };
}

async function syncTopicsPublished(): Promise<string[][]> {
  return runInDurableObject(workspace(), (_instance, state) => (
    state.storage.sql.exec<{ topics_json: string }>(
      `SELECT topics_json FROM workspace_sync_events ORDER BY waterline`,
    ).toArray().map((row) => JSON.parse(row.topics_json) as string[])
  ));
}

async function runExecutionState(): Promise<string | undefined> {
  return runInDurableObject(agent(), (_instance: AutomationAgent, state) => (
    state.storage.sql.exec<{ execution_state: string }>(
      `SELECT execution_state FROM automation_runs WHERE run_id = ?`, RUN_ID,
    ).toArray()[0]?.execution_state
  ));
}

beforeEach(async () => {
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  // Both objects outlive a test, so each one starts from a known empty state
  // rather than from whatever the previous test projected.
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(`DELETE FROM automation_directory`);
    state.storage.sql.exec(`DELETE FROM workspace_workstream_directory`);
    state.storage.sql.exec(`DELETE FROM workspace_sync_events`);
  });
  for (const automationId of [AUTOMATION_ID, UNREACHABLE_AUTOMATION_ID]) {
    await runInDurableObject(agent(automationId), (_instance: AutomationAgent, state) => {
      state.storage.sql.exec(`DELETE FROM automation_runs`);
      // The event log outlives `automation_state`, and `event_sequence` — the
      // cursor that numbers it — lives in that row. Clearing one without the
      // other makes the next test's first append collide with a sequence the
      // last test already used.
      state.storage.sql.exec(`DELETE FROM automation_realtime_events`);
      state.storage.sql.exec(`DELETE FROM automation_state`);
      state.storage.sql.exec(`DELETE FROM automation_identity`);
    });
  }
}, 30_000);

describe("a run reaching a terminal state", () => {
  it("tells the workspace's readers, so an open automation screen stops saying it is working", async () => {
    await projectAutomation(AUTOMATION_ID, "Weekly brief");
    await seedRunningRun();

    const result = await workspace().applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: [terminalEnvelope({
        automationId: AUTOMATION_ID,
        runId: RUN_ID,
        workstreamId: WORKSTREAM_ID,
        state: "error",
        sourceVersion: 2,
      })],
    });

    expect(result.accepted).toHaveLength(1);
    expect(await runExecutionState()).toBe("failed");
    // The topic the desktop already invalidates `['automation', id]` on. Without
    // it the row the screen is showing stays `running` until a remount.
    expect(await syncTopicsPublished()).toContainEqual(["automations"]);
  });

  it("says nothing when the projection changes nothing a reader would see", async () => {
    await projectAutomation(AUTOMATION_ID, "Weekly brief");
    await seedRunningRun();

    // `idle` maps to `running`, which this run already is. It is a real
    // acknowledgement — the source version advances — and it is not news.
    await workspace().applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: [terminalEnvelope({
        automationId: AUTOMATION_ID,
        runId: RUN_ID,
        workstreamId: WORKSTREAM_ID,
        state: "idle",
        sourceVersion: 2,
      })],
    });

    expect(await runExecutionState()).toBe("running");
    expect(await syncTopicsPublished()).not.toContainEqual(["automations"]);
  });

  it("leaves the envelope unacknowledged when the agent cannot be reached", async () => {
    // A terminal run has no later projection to catch up on, so a hop dropped
    // here used to pin it at `running` in the agent's own history forever.
    // Withholding the acknowledgement is what makes the sender redeliver it.
    await projectAutomation(UNREACHABLE_AUTOMATION_ID, "Never activated");

    const result = await workspace().applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: [terminalEnvelope({
        automationId: UNREACHABLE_AUTOMATION_ID,
        runId: UNREACHABLE_RUN_ID,
        workstreamId: UNREACHABLE_WORKSTREAM_ID,
        state: "completed",
        sourceVersion: 2,
      })],
    });

    expect(result.accepted).toHaveLength(0);
    // The directory row itself still committed, so the redelivery reconciles
    // against a row that already matches and only repeats the hop.
    expect(result.directoryChanged).toBe(true);
  });

  it("acknowledges the automations it could reach in the same batch", async () => {
    await projectAutomation(AUTOMATION_ID, "Weekly brief");
    await projectAutomation(UNREACHABLE_AUTOMATION_ID, "Never activated");
    await seedRunningRun();
    const reachable = terminalEnvelope({
      automationId: AUTOMATION_ID,
      runId: RUN_ID,
      workstreamId: WORKSTREAM_ID,
      state: "completed",
      sourceVersion: 2,
    });

    const result = await workspace().applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: [
        reachable,
        terminalEnvelope({
          automationId: UNREACHABLE_AUTOMATION_ID,
          runId: UNREACHABLE_RUN_ID,
          workstreamId: UNREACHABLE_WORKSTREAM_ID,
          state: "completed",
          sourceVersion: 2,
        }),
      ],
    });

    // One automation's unreachable agent must not stall the directory for the
    // rest of them, which is what a rejection propagating out of the batch did.
    expect(result.accepted.map((entry) => entry.messageId)).toEqual([reachable.messageId]);
    expect(await runExecutionState()).toBe("completed");
  });
});
