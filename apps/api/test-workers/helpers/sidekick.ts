import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { asWorkspaceId } from "@rally/contracts";

import type { WorkspaceDO } from "../../src/durable-objects/workspace-do";
import { workspaceDOName } from "../../src/durable-objects/names";
import type { Env } from "../../src/env";
import { sidekickClientFor } from "../../src/services/sidekick-client";
import { provisionSidekickRun } from "../../src/services/sidekick-run-provisioning";

/**
 * A hosted Sidekick, addressed the way production addresses it.
 *
 * Every Sidekick lives in its Organization's `WorkspaceDO`. A test that used
 * to hold a `SidekickDO` stub holds this client instead, with the same method
 * names, and reads the Sidekick's rows from the Organization object's
 * `automation_directory` and `sidekick_*` tables, keyed by `sidekick_id`.
 */
export function sidekickWorkspace(env: Env, workspaceId: string, region: string = "global") {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName(region, asWorkspaceId(workspaceId))));
}

export function sidekickStub(env: Env, workspaceId: string, region: string = "global") {
  return sidekickClientFor(sidekickWorkspace(env, workspaceId, region));
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
      workspaceId,
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
