import {
  DemoSeedSchema,
  asAutomationId,
  asHarnessRunId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
} from "@rally/contracts";

import type { SidekickRunProvisionQueueMessage } from "../durable-objects/automation-do-protocol";
import type { SidekickRunProvisioning } from "../durable-objects/hosted-sidekick";
import { substreamLoopId, workspaceDOName } from "../durable-objects/names";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { uuidV7 } from "../lib/uuid-v7";
import { createHarnessRunObjectPort } from "../runtime/harness-run-port";
import { createMessageObjectPort } from "../runtime/message-port";
import { automationModelOverride, scheduledWorkstreamModel } from "./agent-model-flags";
import { activateWorkstreamLoop } from "./integrations";
import { refreshMemoryDigestCopy } from "./memory-digest-service";
import { attachWorkstreamRuntimeResource } from "./workstream-object-client";
import { bootstrapConversationChildRuntime, provisionWorkstreamObject } from "./workstream-runtime-database";

/**
 * Open a hosted Sidekick's run conversation and start its loop.
 *
 * The Organization object hands each pending run here on the activity Queue
 * rather than awaiting it from its own alarm, where one slow cold conversation
 * would hold every other alarm job behind it. Every step is idempotent, so a
 * redelivery or a re-send resumes rather than provisioning twice: the child
 * bootstrap and provision are replays on an opened object, the run admission
 * answers `exists`, and the loop activation keys its receipt on the run. The
 * last step tells the Organization the run is running, which settles the entry
 * that sent this. See `HostedSidekick.startRun`.
 */
export async function provisionSidekickRun(env: Env, message: SidekickRunProvisionQueueMessage): Promise<void> {
  const workspaceId = asWorkspaceId(message.workspaceId);
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId,
    workspaceDOName(env.AVALON_REGION, workspaceId));
  const address = { workspaceId, automationId: message.automationId, runId: message.runId };
  // Typed here: the run definition's shape is opaque to the RPC type mapping.
  const run = await workspace.sidekickRunProvisioning(address) as SidekickRunProvisioning | null;
  // No longer pending: provisioned already, or stopped by a pause.
  if (!run) return;
  const { definition } = run;
  const now = Date.now();
  await bootstrapConversationChildRuntime(env, run.workspaceId, "automation", run.automationId, run.runId);
  await provisionWorkstreamObject(env, {
    workspaceId: run.workspaceId,
    workstreamId: run.automationId,
    substreamId: run.runId,
    title: definition.definition.name,
    objective: definition.definition.instructions,
    // A run is nested implementation detail, not a room: it admits only the
    // person it runs as.
    scope: "personal",
    createdByUserId: run.runAsUserId,
    participantUserIds: [run.runAsUserId],
    harnessStatus: "scheduled",
    emailAddress: null,
    emailRouteStatus: null,
    systemKind: null,
    modelOverride: run.modelOverride,
    now,
  });
  // Every run is a new conversation with no digest copy of its own, and the
  // copy is otherwise written only after a run settles: read it now so the
  // first activation starts with the Sidekick's facts. Never throws.
  await refreshMemoryDigestCopy(
    env,
    { workspaceId: run.workspaceId, parentKind: "automation", parentId: run.automationId, substreamId: run.runId },
    { kind: "sidekick", automationId: run.automationId },
  );
  let triggerMessageId: string | null = null;
  if (definition.opening) {
    // Only an email is also a resource the run can open; an event is prose.
    if (definition.opening.resourceId) {
      await attachWorkstreamRuntimeResource(env, {
        workspaceId: run.workspaceId,
        workstreamId: run.automationId,
        substreamId: run.runId,
        resourceId: definition.opening.resourceId,
        attachedByUserId: null,
        relationshipType: "inbound_email",
      });
    }
    const appended = await createMessageObjectPort(env, run.workspaceId, run.automationId, undefined, run.runId)
      .appendMessage({
        messageId: uuidV7(Date.now()),
        clientMessageId: `automation-opening:${run.runId}`,
        authorType: "system",
        authorUserId: null,
        externalActorJson: null,
        messageType: "system",
        text: definition.opening.textContent,
        structuredContentJson: JSON.stringify(definition.opening.structuredContent),
        producedByRunId: null,
        now: Date.now(),
      });
    triggerMessageId = appended.messageId;
  }
  const pinned = automationModelOverride(env, run.modelOverride, {
    workspaceId: run.workspaceId,
    automationId: run.automationId,
  });
  const model = pinned ?? await scheduledWorkstreamModel(env, {
    workspaceId: run.workspaceId,
    workstreamId: run.automationId,
  });
  const runs = createHarnessRunObjectPort(env, run.workspaceId, run.automationId, undefined, run.runId);
  const executionPrincipal = { type: "user" as const, userId: asUserId(run.runAsUserId) };
  if (!await runs.run({ runId: run.harnessRunId })) {
    await runs.admitRun({
      runId: run.harnessRunId,
      origin: "automation_run",
      executionPrincipalJson: JSON.stringify(executionPrincipal),
      status: "admitted",
      startedAt: null,
      model,
      triggerPartId: null,
      parentRunId: null,
      expectedLatestRunId: null,
      now: Date.now(),
    });
  }
  await activateWorkstreamLoop(env, {
    region: run.region,
    workspaceId,
    parentKind: "automation",
    parentId: run.automationId,
    substreamId: asSubstreamId(run.runId),
    loopId: substreamLoopId(run.automationId, asSubstreamId(run.runId)),
    harnessRunId: asHarnessRunId(run.harnessRunId),
    triggerMessageId,
    activityId: null,
    automationRun: {
      schemaVersion: 1,
      automationId: asAutomationId(run.automationId),
      runId: run.runId,
      definitionRevision: run.definitionRevision,
      trigger: definition.trigger,
    },
    executionPrincipal,
    // A seeded run answers its own provider requests from here; every other
    // run carries nothing and reaches the real provider. See `runSeeded`.
    ...(run.seedJson ? { seed: DemoSeedSchema.parse(JSON.parse(run.seedJson)) } : {}),
    reason: definition.trigger.kind,
  });
  await workspace.sidekickRunProvisioned(address);
}
