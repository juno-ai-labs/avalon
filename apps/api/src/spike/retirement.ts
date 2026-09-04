/**
 * SPIKE — throwaway. Not production code, not on the release path.
 *
 * The minimal workspace retirement protocol.
 *
 * Nothing in Rally retires a workspace today, and the nearest thing —
 * `workspaces.abandoned_at`, written by `WorkspaceService.leaveWorkspace` — is
 * three quarters short of one: it is reachable only by the last remaining
 * member, it gates *admission* in D1 and nothing else, and every Durable Object
 * beneath it keeps its alarms, its outbox, and its willingness to apply
 * whatever arrives.
 *
 * This adds the four missing halves, in the order they have to happen:
 *
 * 1. **Mark it retiring** and reject new product work. The D1 flag is reused,
 *    because it is already read on every authenticated request and by every
 *    object's own membership check — but it is written here directly rather
 *    than through `leaveWorkspace`, which refuses a workspace with more than
 *    one active member.
 * 2. **Pause its automations**, through `AutomationAgent.pause`, which is the
 *    production transition: it bumps the authority generation, withdraws the
 *    evaluator registrations and cancels the schedule entries.
 * 3. **Clear every alarm** on the workspace object, on each work stream's
 *    WorkstreamDO, and on each SubstreamAgent.
 * 4. **Fence the WorkspaceDO** so an effect that arrives afterwards is dropped
 *    rather than applied.
 *
 * Order matters and is not arbitrary. Admission is closed first so nothing new
 * enters while the walk is in progress; the objects are cleared leaf-first so a
 * child cannot re-arm a parent it has already passed; the WorkspaceDO fence is
 * set first of the object steps, because it is the thing that has to survive a
 * straggler from any of the rest.
 */
import { asAutomationId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import {
  automationAgentName,
  substreamAgentName,
  workspaceDOName,
  workstreamDOName,
} from "../durable-objects/names";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { readWorkstreamAuthorityControl } from "../services/workstream-authority";

export interface RetirementReport {
  workspaceId: string;
  retiredGeneration: number;
  abandonedAt: string;
  workstreamIds: string[];
  automationIds: string[];
  automationOutcomes: Record<string, string>;
  alarmsCancelled: {
    workspace: number;
    workstreams: number;
    substreams: number;
  };
  alarmsRemaining: {
    workspace: number | null;
    workstreams: Record<string, number | null>;
    substreams: Record<string, number | null>;
  };
  notes: string[];
}

export async function retireWorkspace(env: Env, input: {
  workspaceId: string;
  reason: string;
}): Promise<RetirementReport> {
  const notes: string[] = [];
  const control = await readWorkstreamAuthorityControl(env);
  const retiredGeneration = control.generation;
  const workspaceId = input.workspaceId;

  // 1. Reject new product work. The same column every request and every object
  //    membership check already reads, so nothing new has to learn about it.
  const abandonedAt = new Date().toISOString();
  const marked = await env.DB.prepare(
    `UPDATE workspaces SET abandoned_at = COALESCE(abandoned_at, ?), updated_at = ?
      WHERE id = ?`,
  ).bind(abandonedAt, abandonedAt, workspaceId).run();
  if (Number(marked.meta.changes ?? 0) !== 1) {
    throw new Error("spike_retire_workspace_row_missing");
  }
  notes.push("workspaces.abandoned_at set directly; leaveWorkspace() refuses a workspace with more than one active member");

  // 4 (first, deliberately). The fence has to exist before the walk, or an
  // effect drained by step 3 lands on an unfenced object.
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    workspaceId,
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
  );
  const retired = await workspace.spikeRetireWorkspace({
    workspaceId,
    retiredGeneration,
    reason: input.reason,
  });

  // 2. Pause the automations, through the production transition.
  const automationOutcomes: Record<string, string> = {};
  for (const automation of retired.automations) {
    const agent = await durableObjectStubForWorkspace(
      env,
      env.AUTOMATION_AGENTS,
      workspaceId,
      automationAgentName(
        env.AVALON_REGION,
        asWorkspaceId(workspaceId),
        asAutomationId(automation.automationId),
      ),
    );
    try {
      // `pause` is the production transition — it bumps the authority
      // generation, withdraws the evaluator registrations and cancels the
      // schedule entries — and it takes an *actor*, because every management
      // transition today is somebody's. A retirement has no person in it, so
      // the automation's own author is used. A production version has to decide
      // whether a system actor exists at all; see SPIKE-REPORT.md.
      await agent.pause({
        automationId: automation.automationId,
        workspaceId,
        userId: automation.authorUserId,
        actorRole: "owner",
      });
      automationOutcomes[automation.automationId] = "paused";
    } catch (error) {
      automationOutcomes[automation.automationId] = error instanceof Error
        ? error.message
        : "pause_failed";
    }
  }

  // 3. Clear the alarms, leaf-first.
  let substreamAlarms = 0;
  let workstreamAlarms = 0;
  const substreamRemaining: Record<string, number | null> = {};
  const workstreamRemaining: Record<string, number | null> = {};
  for (const workstreamId of retired.workstreamIds) {
    const substream = await durableObjectStubForWorkspace(
      env,
      env.SUBSTREAM_AGENTS,
      workspaceId,
      substreamAgentName(env.AVALON_REGION, asWorkspaceId(workspaceId), asWorkstreamId(workstreamId)),
    );
    const child = await substream.spikeRetire({ retiredGeneration, reason: input.reason });
    substreamAlarms += child.cancelledAlarms;
    substreamRemaining[workstreamId] = child.alarmAfter;

    const parent = await durableObjectStubForWorkspace(
      env,
      env.WORKSTREAM_DOS,
      workspaceId,
      workstreamDOName(env.AVALON_REGION, asWorkspaceId(workspaceId), asWorkstreamId(workstreamId)),
    );
    const parentResult = await parent.spikeRetire({ retiredGeneration, reason: input.reason });
    workstreamAlarms += parentResult.cancelledAlarms;
    workstreamRemaining[workstreamId] = parentResult.alarmAfter;
  }

  return {
    workspaceId,
    retiredGeneration,
    abandonedAt,
    workstreamIds: retired.workstreamIds,
    automationIds: retired.automations.map((automation) => automation.automationId),
    automationOutcomes,
    alarmsCancelled: {
      workspace: retired.cancelledAlarms,
      workstreams: workstreamAlarms,
      substreams: substreamAlarms,
    },
    alarmsRemaining: {
      workspace: retired.alarmAfter,
      workstreams: workstreamRemaining,
      substreams: substreamRemaining,
    },
    notes,
  };
}

/** What the retirement left behind, read back through the same objects. */
export async function retirementState(env: Env, input: {
  workspaceId: string;
  workstreamIds: readonly string[];
}) {
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    input.workspaceId,
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(input.workspaceId)),
  );
  const workspaceState = await workspace.spikeRetirementState({ workspaceId: input.workspaceId });
  const workstreams: Record<string, unknown> = {};
  for (const workstreamId of input.workstreamIds) {
    const substream = await durableObjectStubForWorkspace(
      env,
      env.SUBSTREAM_AGENTS,
      input.workspaceId,
      substreamAgentName(
        env.AVALON_REGION,
        asWorkspaceId(input.workspaceId),
        asWorkstreamId(workstreamId),
      ),
    );
    const parent = await durableObjectStubForWorkspace(
      env,
      env.WORKSTREAM_DOS,
      input.workspaceId,
      workstreamDOName(
        env.AVALON_REGION,
        asWorkspaceId(input.workspaceId),
        asWorkstreamId(workstreamId),
      ),
    );
    workstreams[workstreamId] = {
      substream: await substream.spikeRetirementState(),
      workstream: await parent.spikeRetirementState(),
    };
  }
  return { workspace: workspaceState, workstreams };
}
