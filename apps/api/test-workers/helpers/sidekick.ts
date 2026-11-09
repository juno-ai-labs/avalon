import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { asWorkspaceId } from "@rally/contracts";

import { HostedSidekick, type HostedSidekickHost } from "../../src/durable-objects/hosted-sidekick";
import type { WorkspaceDO } from "../../src/durable-objects/workspace-do";
import { workspaceDOName } from "../../src/durable-objects/names";
import type { Env } from "../../src/env";
import { AUTOMATION_RUN_ALARM_KIND, SidekickRunProvisionQueueMessageSchema } from "../../src/durable-objects/automation-do-protocol";
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

/** The wait for a due run's handoff: well under the 30-second test budget. */
const RUN_HANDOFF_TIMEOUT_MS = 10_000;

/**
 * Fire the Organization's alarm, then provision whatever runs it started.
 *
 * A run is armed for now, so the object's own alarm can already be running it
 * when this is called, and `runDurableObjectAlarm` then returns without
 * waiting for it. A run the alarm handled has its entry moved later, so the
 * wait ends once no run entry is due: every due run has registered its child.
 */
export async function runSidekickAlarms(env: Env, workspaceId: string, region = "global"): Promise<string[]> {
  const stub = sidekickWorkspace(env, workspaceId, region);
  await runDurableObjectAlarm(stub);
  // Only waits: firing the alarm again here would start the same run a second
  // time while the first pass is still sending. Due is the scheduler's own
  // test, so an entry the handler deferred ends the wait, and the caller's
  // assertion reports the run that never started.
  await expect.poll(() => runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ count: number }>(
    `SELECT COUNT(*) AS count FROM _internal_durable_alarms WHERE kind = ? AND MAX(due_at, retry_at) <= ?`,
    AUTOMATION_RUN_ALARM_KIND, Date.now(),
  ).one().count), { timeout: RUN_HANDOFF_TIMEOUT_MS }).toBe(0);
  return provisionStartedSidekickRuns(env, workspaceId, region);
}

/**
 * Replace a Sidekick's connector registrations the way an apply does, and set
 * its activation boundary to the sequence they take effect after, without the
 * rest of an apply. For a test that controls the event sequence itself.
 *
 * With `revision`, it also takes the apply's post-commit step for that
 * revision (its Slack sources' joins), and in every case it re-arms the
 * workspace alarm as a hosted write does, so a Canva poll schedule the
 * registrations enabled is due.
 */
export async function writeSidekickRegistrations(
  env: Env, workspaceId: string, automationId: string, evaluators: readonly unknown[], region = "global",
  revision: number | null = null,
): Promise<void> {
  await runInDurableObject(sidekickWorkspace(env, workspaceId, region), async (instance, state) => {
    const object = instance as unknown as {
      hostedSidekickHost: () => HostedSidekickHost;
      afterHostedWrite: () => Promise<void>;
    };
    const host = object.hostedSidekickHost();
    const sidekick = new HostedSidekick(host, automationId) as unknown as {
      writeRegistrations: (evaluators: readonly unknown[]) => number;
      touchDirectory: (now: number, effectiveAfterEventSequence?: number) => void;
    };
    // The same two steps an apply takes: replace the registrations, then
    // record the sequence they take effect after on the Sidekick's row.
    state.storage.transactionSync(() => sidekick.touchDirectory(Date.now(), sidekick.writeRegistrations(evaluators)));
    await host.afterRegistrations(automationId, revision, evaluators);
    await object.afterHostedWrite();
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

/** A Sidekick's directory row, as a test needs it listed, renamed or deleted. */
export interface SidekickDirectoryRow {
  automationId: string;
  workspaceId: string;
  authorUserId: string;
  runAsUserId?: string;
  lifecycle: "draft" | "active" | "paused" | "deleted";
  scope: "personal" | "workspace";
  title: string;
  description: string;
  nextRunAt?: string | null;
  loadable?: boolean;
}

/**
 * Write a Sidekick's directory row the way a hosted change lands it: through
 * the Organization object's own storage, so the table's triggers and the rail
 * drain run, then the same directory hook a hosted change calls, which moves
 * the sidebar list and suspends a deleted Sidekick's bindings. For a test that
 * needs a Sidekick listed, renamed or deleted without a whole definition.
 */
export async function writeSidekickDirectoryRow(env: Env, row: SidekickDirectoryRow, region = "global"): Promise<void> {
  await runInDurableObject(sidekickWorkspace(env, row.workspaceId, region), (instance: WorkspaceDO) => {
    const workspace = instance as unknown as {
      hostedSidekickHost: () => HostedSidekickHost;
      publishSidebarList: (list: "automations") => void;
    };
    const host = workspace.hostedSidekickHost();
    const now = Date.now();
    host.storage.transactionSync(() => {
      host.storage.sql.exec(
        `INSERT INTO automation_directory
           (automation_id, workspace_id, author_user_id, run_as_user_id, source_version, payload_hash,
            lifecycle, scope, title, description, next_run_at, projected_at, loadable)
         VALUES (?, ?, ?, ?, 1, 'test-row', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(automation_id) DO UPDATE SET
           author_user_id = excluded.author_user_id,
           run_as_user_id = COALESCE(excluded.run_as_user_id, run_as_user_id),
           lifecycle = excluded.lifecycle,
           scope = excluded.scope,
           title = excluded.title,
           description = excluded.description,
           next_run_at = excluded.next_run_at,
           projected_at = excluded.projected_at,
           loadable = excluded.loadable`,
        row.automationId, row.workspaceId, row.authorUserId, row.runAsUserId ?? null,
        row.lifecycle, row.scope,
        row.title, row.description, row.nextRunAt ? Date.parse(row.nextRunAt) : null, now,
        row.loadable === undefined ? null : row.loadable ? 1 : 0,
      );
      host.noteDirectoryChanged(row.automationId, row.lifecycle === "deleted", now);
    });
    workspace.publishSidebarList("automations");
  });
}
