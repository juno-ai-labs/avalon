/// <reference types="@cloudflare/vitest-pool-workers/types" />

/** Shared Sidekick routing and leases on real workerd; Daytona itself is not involved. */
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";

import { asSubstreamId } from "@rally/contracts";

import { conversationObjectName } from "../src/durable-objects/names";
import { resolveTerminalRunScope } from "../src/services/terminal/authority";
import { createTerminalPortFactory } from "../src/services/terminal/object-port";
import { WORKSPACE_ID, seedOpenWorkstreamAuthority } from "./helpers/substream-fixture";

it("shares the wizard's durable sandbox and mutation lease across Sidekick activations", async () => {
  await seedOpenWorkstreamAuthority(env.DB);
  const sidekickId = crypto.randomUUID();
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  const wizardRun = crypto.randomUUID();
  const firstRun = crypto.randomUUID();
  const secondRun = crypto.randomUUID();
  const stub = (parentId: string, substreamId: string) => env.SUBSTREAM_AGENTS.getByName(
    conversationObjectName("global", WORKSPACE_ID, parentId, asSubstreamId(substreamId)),
  );
  const bootstrap = async (parentId: string, substreamId: string) => {
    expect(await stub(parentId, substreamId).bootstrapRuntime({
      workspaceId: WORKSPACE_ID, parentId, parentKind: "automation",
      substreamId: asSubstreamId(substreamId), generation: 1,
    })).toMatchObject({ status: 200 });
  };
  for (const substreamId of ["0", first, second]) await bootstrap(sidekickId, substreamId);
  const owner = stub(sidekickId, "0");
  // Only the wizard's execution is local to the sandbox owner. Activation
  // executions remain in their own objects and must hold foreign-run leases.
  await runInDurableObject(owner, (_instance, state) => {
    state.storage.sql.exec(`INSERT INTO runs (
      run_id, substream_id, workflow_instance_id, status, budget, attempt_epoch,
      model_iteration, next_action_cursor, input_fence_seq, revision, started_at,
      active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
      tool_count, input_tokens, output_tokens, cost_micros, output_bytes, created_at, updated_at
    ) VALUES (?, '0', NULL, 'running', '{}', 0, 0, '', 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1)`, wizardRun);
  });
  const port = async (parentId: string, substreamId: string) => {
    const scope = await resolveTerminalRunScope({
      workspaceId: WORKSPACE_ID, parentId, parentKind: "automation",
      substreamId: asSubstreamId(substreamId), backgroundAgent: false,
    }, async () => { throw new Error("a primary run does not need a delegation lookup"); });
    return createTerminalPortFactory(env, undefined, scope.authoritySubstreamId)(WORKSPACE_ID, parentId);
  };
  const wizard = await port(sidekickId, "0");
  const activationA = await port(sidekickId, first);
  const activationB = await port(sidekickId, second);
  const now = Date.now();
  // These deadlines are fixture values, not a change to production retention.
  const deadlines = { idleExpiresAt: now + 600_000, archiveDueAt: now + 1_200_000, expireDueAt: now + 1_800_000 };
  await wizard.reserveFirstGeneration({ stableName: "shared-sidekick", authorityFingerprint: "same-principal",
    networkRevision: 1, runId: wizardRun, operationLeaseExpiresAt: now + 60_000, ...deadlines, now });
  await wizard.attachProviderSandbox({ generation: 1, sandboxId: "sidekick-provider-sandbox",
    lifecycleState: "running", ...deadlines, now });
  expect(await activationA.sandbox()).toMatchObject({ sandboxId: "sidekick-provider-sandbox", generation: 1 });
  expect(await wizard.releaseOperation({ runId: wizardRun, now })).toBe(true);
  expect(await activationA.claimOperation({ runId: firstRun, runSubstreamId: first,
    generation: 1, leaseExpiresAt: now + 60_000, now }))
    .toMatchObject({ operationRunId: firstRun, operationRunSubstreamId: first });
  await activationA.recordImportedResource({ sandboxGeneration: 1,
    resourceId: "00000000-0000-4000-8000-000000000099", destinationPath: ".rally-output/calendar",
    sourceSha256: "a".repeat(64), sizeBytes: 1, state: "completed", importedAt: now,
    attachedSubstreamId: first, now });
  expect(await activationB.claimOperation({ runId: secondRun, runSubstreamId: second,
    generation: 1, leaseExpiresAt: now + 60_000, now })).toBeNull();
  await evictDurableObject(owner);
  expect(await activationB.sandbox()).toMatchObject({ sandboxId: "sidekick-provider-sandbox", generation: 1,
    operationRunId: firstRun, operationRunSubstreamId: first });
  expect(await activationA.releaseOperation({ runId: firstRun, now })).toBe(true);
  expect(await activationB.claimOperation({ runId: secondRun, runSubstreamId: second,
    generation: 1, leaseExpiresAt: now + 60_000, now }))
    .toMatchObject({ sandboxId: "sidekick-provider-sandbox", operationRunId: secondRun });
  await activationB.recordImportedResource({ sandboxGeneration: 1,
    resourceId: "00000000-0000-4000-8000-000000000099", destinationPath: ".rally-output/calendar",
    sourceSha256: "b".repeat(64), sizeBytes: 2, state: "completed", importedAt: now,
    attachedSubstreamId: second, now });
  // Re-importing the same output replaces its authorizing activation. An
  // hourly refresh does not accumulate one link check per historical run.
  expect(await wizard.importedResources(1)).toEqual([{
    resourceId: "00000000-0000-4000-8000-000000000099", destinationPath: ".rally-output/calendar",
    state: "completed", attachedSubstreamId: second,
  }]);
  expect(await wizard.claimOperation({ runId: wizardRun, generation: 1,
    leaseExpiresAt: now + 60_000, now })).toBeNull();

  const otherSidekick = crypto.randomUUID();
  await bootstrap(otherSidekick, "0");
  expect(await (await port(otherSidekick, first)).sandbox()).toBeNull();
});
