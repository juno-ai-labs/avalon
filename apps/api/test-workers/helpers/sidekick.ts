import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vitest";
import { asWorkspaceId } from "@rally/contracts";

import { HostedSidekick, type HostedSidekickHost } from "../../src/durable-objects/hosted-sidekick";
import type { WorkspaceDO } from "../../src/durable-objects/workspace-do";
import { workspaceDOName } from "../../src/durable-objects/names";
import type { Env } from "../../src/env";
import { SidekickRunProvisionQueueMessageSchema } from "../../src/durable-objects/automation-do-protocol";
import { provisionSidekickRun } from "../../src/services/sidekick-run-provisioning";

/**
 * A hosted Sidekick, addressed the way production addresses it.
 *
 * Every Sidekick lives in its Organization's `WorkspaceDO`, which answers its
 * methods as `sidekick*` (`sidekickPause`, `sidekickRunNow`) and the parent
 * contract under the shared names with the Sidekick's id as `parentId`. Its
 * rows are the Organization object's `automation_directory` and `sidekick_*`
 * tables, keyed by `sidekick_id`.
 */
export function sidekickWorkspace(env: Env, workspaceId: string, region: string = "global") {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName(region, asWorkspaceId(workspaceId))));
}

/**
 * Apply inside the object: `AutomationDetail` is what the stub returns, and a
 * rejection over a stub is reported a second time as unhandled, which fails
 * the run even when the assertion held.
 */
export async function applySidekick(env: Env, request: Parameters<WorkspaceDO["sidekickApply"]>[0], region = "global") {
  return runInDurableObject(sidekickWorkspace(env, request.workspaceId, region), (instance: WorkspaceDO) =>
    instance.sidekickApply(request));
}

/**
 * Hand every run the Organization has started to provisioning, the way the
 * activity Queue's consumer does in production.
 *
 * The test Worker's `ACTIVITY_QUEUE` has no consumer, so the message a run's
 * alarm sends goes nowhere. A run is ready for provisioning once that alarm
 * has registered its child; this reads exactly those runs and runs the real
 * consumer step for each.
 */
export async function provisionStartedSidekickRuns(env: Env, workspaceId: string, region = "global"): Promise<string[]> {
  const started = await runInDurableObject(sidekickWorkspace(env, workspaceId, region), (_instance, state) =>
    state.storage.sql.exec<{ sidekick_id: string; run_id: string }>(
      `SELECT r.sidekick_id, r.run_id FROM sidekick_runs r
         JOIN sidekick_children c ON c.sidekick_id = r.sidekick_id AND c.substream_id = r.run_id
        WHERE r.state = 'pending' ORDER BY r.created_at, r.run_id`,
    ).toArray());
  for (const run of started) {
    await provisionSidekickRun(env, {
      kind: "sidekick_run_provision",
      region,
      workspaceId: asWorkspaceId(workspaceId),
      automationId: run.sidekick_id,
      runId: run.run_id,
    });
  }
  return started.map((run) => run.run_id);
}

/** Fire the Organization's alarm, then provision whatever runs it started. */
export async function runSidekickAlarms(env: Env, workspaceId: string, region = "global"): Promise<string[]> {
  await runDurableObjectAlarm(sidekickWorkspace(env, workspaceId, region));
  return provisionStartedSidekickRuns(env, workspaceId, region);
}

/**
 * Replace a Sidekick's connector registrations the way an apply does, and set
 * its activation boundary to the sequence they take effect after, without the
 * rest of an apply. For a test that controls the event sequence itself.
 */
export async function writeSidekickRegistrations(
  env: Env, workspaceId: string, automationId: string, evaluators: readonly unknown[], region = "global",
): Promise<void> {
  await runInDurableObject(sidekickWorkspace(env, workspaceId, region), (instance, state) => {
    const host = (instance as unknown as { hostedSidekickHost: () => HostedSidekickHost }).hostedSidekickHost();
    const sidekick = new HostedSidekick(host, automationId) as unknown as {
      writeRegistrations: (evaluators: readonly unknown[], now: number) => void;
    };
    state.storage.transactionSync(() => sidekick.writeRegistrations(evaluators, Date.now()));
  });
}

type QueueSend = { send: (body: unknown, options?: QueueSendOptions) => Promise<void> };

/**
 * Stand in for the activity Queue's consumer for run provisioning, for a file
 * whose runs start on their own (a native alarm inside a seeding request)
 * rather than at a point the test can call `runSidekickAlarms`.
 *
 * The test Worker's `ACTIVITY_QUEUE` has no consumer, so a provisioning
 * message would be lost. This runs the real consumer step for that message
 * kind only, before the send returns; every other message passes through.
 */
export function useSidekickRunProvisionConsumer(): void {
  beforeEach(() => {
    const prototype = Object.getPrototypeOf(workerEnv.ACTIVITY_QUEUE) as QueueSend;
    const original = prototype.send;
    const consumerEnv: Env = workerEnv;
    vi.spyOn(prototype, "send").mockImplementation(async function (this: QueueSend, body, options) {
      const provision = SidekickRunProvisionQueueMessageSchema.safeParse(body);
      if (provision.success) return provisionSidekickRun(consumerEnv, provision.data);
      return original.call(this, body, options);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
}
