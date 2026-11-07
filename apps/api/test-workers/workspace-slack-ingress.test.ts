/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The Slack ingress spine against the object that holds it: job admission and
 * its dedupe, the claim lease, settlement fencing, the exhaustion episode, the
 * maintenance sweep, thread claims, pending prompts, and App Home context.
 *
 * These are claim shapes, so what real workerd proves here is exactly what a
 * Node double cannot: the insert-or-report decision and the fail-and-check
 * episode are single transactions over real Durable Object SQLite, the fences
 * are returned witnesses rather than affected-row counts, and the foreign keys
 * to `connector_connections` are enforced rather than assumed.
 *
 * Every timestamp is minted in the real future, ordered only relative to the
 * requests' own `at`. The typed writes re-derive the workspace alarm, and a
 * seeded row that looks expired against real time would make that alarm due
 * immediately — its maintenance pass reaps the very rows these tests assert
 * on, which is the background-work race `docs/testing.md` warns about.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import {
  WorkspaceSlackIngressClaimResultSchema,
  WorkspaceSlackIngressEnqueueResultSchema,
  WorkspaceSlackIngressFailResultSchema,
  WorkspaceSlackIngressRecoverableResultSchema,
  WorkspaceSlackIngressSettleResultSchema,
  WorkspaceSlackIngressSweepResultSchema,
  WorkspaceSlackContextResultSchema,
  WorkspaceSlackPendingPromptResultSchema,
  WorkspaceSlackThreadClaimResultSchema,
  WorkspaceSlackThreadRoutableResultSchema,
} from "../src/durable-objects/workspace-slack-protocol";

/** Its own workspace: a shared id makes this file queue behind its siblings. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000c1d00");
const OTHER_WORKSPACE = asWorkspaceId("00000000-0000-7000-8000-0000000c1d99");
const CONNECTION = "00000000-0000-7000-8000-0000000c1d10";

/**
 * A base instant one hour into the real future. Logical "expired" rows sit
 * between it and the requests' own `at`, so nothing is ever due against the
 * real clock while the file runs.
 */
const BASE = Date.now() + 60 * 60_000;
const at = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

function enqueue(input: { jobId?: string; bodyHash?: string; payloadJson?: string; atMinutes?: number } = {}) {
  return workspace().enqueueSlackIngressJob({
    workspaceId: WORKSPACE_ID,
    jobId: input.jobId ?? "event:Ev1",
    connectionId: CONNECTION,
    teamId: "T1",
    bodyHash: input.bodyHash ?? "hash-1",
    kind: "event",
    payloadJson: input.payloadJson ?? JSON.stringify({ event: "payload" }),
    at: at(input.atMinutes ?? 0),
  }).then((result) => WorkspaceSlackIngressEnqueueResultSchema.parse(result));
}

function claim(input: { jobId?: string; atMinutes?: number } = {}) {
  return workspace().claimSlackIngressJob({
    workspaceId: WORKSPACE_ID,
    jobId: input.jobId ?? "event:Ev1",
    at: at(input.atMinutes ?? 1),
  }).then((result) => WorkspaceSlackIngressClaimResultSchema.parse(result));
}

/** Claim, and fail the test rather than the narrowing if it was refused. */
async function claimedJob(input: Parameters<typeof claim>[0] = {}) {
  const result = await claim(input);
  if (result.outcome !== "claimed") throw new Error(`expected a claim, got ${result.outcome}`);
  return result;
}

function fail(input: {
  jobId?: string;
  leaseId: string;
  errorCode?: string;
  retryable?: boolean;
  atMinutes?: number;
  episodeStartMinutes?: number;
}) {
  return workspace().failSlackIngressJob({
    workspaceId: WORKSPACE_ID,
    jobId: input.jobId ?? "event:Ev1",
    leaseId: input.leaseId,
    errorCode: input.errorCode ?? "invalid_auth",
    retryable: input.retryable ?? false,
    exhaustionEpisodeStartedAt: at(input.episodeStartMinutes ?? -120),
    at: at(input.atMinutes ?? 2),
  }).then((result) => WorkspaceSlackIngressFailResultSchema.parse(result));
}

function claimThread(input: { threadTs?: string; atMinutes?: number } = {}) {
  return workspace().claimSlackThread({
    workspaceId: WORKSPACE_ID,
    connectionId: CONNECTION,
    channelId: "C1",
    threadTs: input.threadTs ?? "1.0",
    at: at(input.atMinutes ?? 0),
  }).then((result) => WorkspaceSlackThreadClaimResultSchema.parse(result));
}

beforeEach(async () => {
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(`DELETE FROM slack_agent_pending_prompts`);
    state.storage.sql.exec(`DELETE FROM slack_agent_thread_claims`);
    state.storage.sql.exec(`DELETE FROM slack_agent_feedback`);
    state.storage.sql.exec(`DELETE FROM slack_agent_contexts`);
    state.storage.sql.exec(`DELETE FROM external_conversation_bindings`);
    state.storage.sql.exec(`DELETE FROM slack_link_challenges`);
    state.storage.sql.exec(`DELETE FROM slack_ingress_jobs`);
    state.storage.sql.exec(`DELETE FROM connector_connections`);
    // The parent row every Slack table's foreign key requires — enforced for
    // real here, so a job for an unknown connection would be refused.
    state.storage.sql.exec(
      `INSERT INTO connector_connections
         (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
          display_name, encrypted_credentials, credential_iv, credential_key_version,
          granted_scopes_json, status, cursor_json, config_json, created_at, updated_at,
          model_plugin_id)
       VALUES (?, ?, 'slack', 'workspace', NULL, 'T1', 'Slack', 'encrypted', 'iv', 1,
               '["slack.agent"]', 'healthy', '{}', '{}', ?, ?, 'plugin_slack_workspace')`,
      CONNECTION,
      WORKSPACE_ID,
      at(-30),
      at(-30),
    );
  });
}, 30_000);

describe("Slack ingress jobs", () => {
  it("admits a job once and converges Slack's redeliveries", async () => {
    expect(await enqueue()).toEqual({ outcome: "queued" });
    // Slack retries with the same id and body: an idempotent replay.
    expect(await enqueue()).toEqual({ outcome: "replayed", status: "queued" });
  });

  it("refuses the same identity carrying different content", async () => {
    await enqueue();
    expect(await enqueue({ bodyHash: "hash-2" })).toEqual({ outcome: "conflict" });
    // The conflicting insert changed nothing.
    const stored = await runInDurableObject(workspace(), (_instance, state) =>
      state.storage.sql.exec<{ body_hash: string }>(
        `SELECT body_hash FROM slack_ingress_jobs WHERE id = 'event:Ev1'`,
      ).one());
    expect(stored.body_hash).toBe("hash-1");
  });

  it("claims under an object-minted lease and refuses the live lease's rival", async () => {
    await enqueue();
    const first = await claimedJob();
    expect(first.job).toMatchObject({ jobId: "event:Ev1", teamId: "T1", kind: "event" });
    expect(first.job.payloadJson).toBe(JSON.stringify({ event: "payload" }));
    // The lease is live, so a second worker cannot take the job.
    expect(await claim({ atMinutes: 2 })).toEqual({ outcome: "unavailable" });
  });

  it("reclaims a processing job whose lease has lapsed", async () => {
    await enqueue();
    await claimedJob({ atMinutes: 0 });
    // Five minutes is the lease; six minutes later the worker is presumed dead.
    const retaken = await claimedJob({ atMinutes: 6 });
    expect(retaken.job.jobId).toBe("event:Ev1");
  });

  it("settles completion only under the lease that claimed it", async () => {
    await enqueue();
    const { leaseId } = await claimedJob();
    const stale = WorkspaceSlackIngressSettleResultSchema.parse(
      await workspace().completeSlackIngressJob({
        workspaceId: WORKSPACE_ID,
        jobId: "event:Ev1",
        leaseId: "someone-elses-lease",
        at: at(2),
      }),
    );
    expect(stale).toEqual({ outcome: "stale" });
    const settled = WorkspaceSlackIngressSettleResultSchema.parse(
      await workspace().completeSlackIngressJob({
        workspaceId: WORKSPACE_ID,
        jobId: "event:Ev1",
        leaseId,
        at: at(2),
      }),
    );
    expect(settled).toEqual({ outcome: "settled" });
    // Completion clears the stored payload; the row keeps only its outcome.
    const row = await runInDurableObject(workspace(), (_instance, state) =>
      state.storage.sql.exec<{ status: string; payload_json: string | null }>(
        `SELECT status, payload_json FROM slack_ingress_jobs WHERE id = 'event:Ev1'`,
      ).one());
    expect(row).toMatchObject({ status: "completed", payload_json: null });
  });

  it("keeps a retryable failure below the ceiling and pins a terminal one at it", async () => {
    await enqueue();
    const { leaseId } = await claimedJob();
    const retryable = await fail({ leaseId, retryable: true, errorCode: "token_expired" });
    expect(retryable).toEqual({
      outcome: "failed",
      attemptCount: 1,
      exhausted: false,
      firstExhaustionReport: false,
    });
    const again = await claimedJob({ atMinutes: 3 });
    const terminal = await fail({ leaseId: again.leaseId, retryable: false, atMinutes: 4 });
    expect(terminal).toMatchObject({ outcome: "failed", attemptCount: 20, exhausted: true });
    // At the ceiling the job is no longer claimable; only a re-drive resets it.
    expect(await claim({ atMinutes: 5 })).toEqual({ outcome: "unavailable" });
  });

  it("reports one exhaustion episode per connection and error code", async () => {
    await enqueue({ jobId: "event:first", bodyHash: "hash-first" });
    await enqueue({ jobId: "event:second", bodyHash: "hash-second" });
    const first = await claimedJob({ jobId: "event:first" });
    const second = await claimedJob({ jobId: "event:second" });
    expect(await fail({ jobId: "event:first", leaseId: first.leaseId }))
      .toMatchObject({ exhausted: true, firstExhaustionReport: true });
    // Same connection, same code, inside the window: a row, not a notice.
    expect(await fail({ jobId: "event:second", leaseId: second.leaseId, atMinutes: 3 }))
      .toMatchObject({ exhausted: true, firstExhaustionReport: false });
    // A different failure mode on the same connection is its own episode.
    await enqueue({ jobId: "event:third", bodyHash: "hash-third" });
    const third = await claimedJob({ jobId: "event:third" });
    expect(await fail({
      jobId: "event:third",
      leaseId: third.leaseId,
      errorCode: "account_inactive",
      atMinutes: 4,
    })).toMatchObject({ exhausted: true, firstExhaustionReport: true });
  });

  it("refuses to settle a failure under a lease it did not issue", async () => {
    await enqueue();
    await claimedJob();
    expect(await fail({ leaseId: "someone-elses-lease" })).toEqual({ outcome: "stale" });
  });

  it("names the jobs whose processing went quiet, oldest first", async () => {
    await enqueue({ jobId: "event:old", bodyHash: "hash-old", atMinutes: 0 });
    await enqueue({ jobId: "event:new", bodyHash: "hash-new", atMinutes: 30 });
    // A worker took a third job and died; its lease lapses before the scan's `at`.
    await enqueue({ jobId: "event:taken", bodyHash: "hash-taken", atMinutes: 0 });
    await claimedJob({ jobId: "event:taken", atMinutes: 1 });
    const recoverable = WorkspaceSlackIngressRecoverableResultSchema.parse(
      await workspace().recoverableSlackIngressJobs({
        workspaceId: WORKSPACE_ID,
        // Two minutes of quiet make a queued job worth re-announcing.
        staleBefore: at(20),
        at: at(20),
        limit: 10,
      }),
    );
    expect(recoverable.jobIds).toEqual(["event:old", "event:taken"]);
  });

  it("names a dead lease at the attempt ceiling, which nothing else can advance", async () => {
    await enqueue({ jobId: "event:doomed", bodyHash: "hash-doomed" });
    // Burn the attempts down to the last one the ceiling allows, retryably —
    // a non-retryable failure pins the count at the ceiling in one step.
    for (let attempt = 0; attempt < 19; attempt += 1) {
      const held = await claimedJob({ jobId: "event:doomed", atMinutes: attempt * 10 });
      await fail({
        jobId: "event:doomed",
        leaseId: held.leaseId,
        retryable: true,
        atMinutes: attempt * 10 + 1,
      });
    }
    // The twentieth claim succeeds and its worker dies: `processing`, at the
    // ceiling, with a lease that lapses. The claim will still reclaim it, the
    // alarm reads a processing row as due at its lease expiry, and no reap
    // takes a processing row — so if this scan skips it, the alarm wakes on
    // the same instant for ever.
    await claimedJob({ jobId: "event:doomed", atMinutes: 200 });
    const recoverable = WorkspaceSlackIngressRecoverableResultSchema.parse(
      await workspace().recoverableSlackIngressJobs({
        workspaceId: WORKSPACE_ID,
        staleBefore: at(220),
        at: at(220),
        limit: 10,
      }),
    );
    expect(recoverable.jobIds).toEqual(["event:doomed"]);
    expect(await claim({ jobId: "event:doomed", atMinutes: 220 }))
      .toMatchObject({ outcome: "claimed" });
  });
});

describe("Slack ingress maintenance sweep", () => {
  it("reaps what the alarm counts and reports the standing exhausted set", async () => {
    const seed = (sql: string, ...params: (string | number | null)[]) =>
      runInDurableObject(workspace(), (_instance, state) => {
        state.storage.sql.exec(sql, ...params);
      });
    // An old completed job, an old exhausted job, and a fresh exhausted one.
    await seed(
      `INSERT INTO slack_ingress_jobs
         (id, workspace_id, connection_id, team_id, body_hash, kind, payload_json,
          status, attempt_count, received_at, updated_at, completed_at)
       VALUES
         ('event:done-old', ?, ?, 'T1', 'h1', 'event', NULL, 'completed', 1, ?, ?, ?),
         ('event:dead-old', ?, ?, 'T1', 'h2', 'event', NULL, 'failed', 20, ?, ?, NULL),
         ('event:dead-new', ?, ?, 'T1', 'h3', 'event', NULL, 'failed', 20, ?, ?, NULL)`,
      WORKSPACE_ID, CONNECTION, at(-40), at(-40), at(-40),
      WORKSPACE_ID, CONNECTION, at(-40), at(-40),
      WORKSPACE_ID, CONNECTION, at(50), at(50),
    );
    await seed(
      `INSERT INTO slack_link_challenges
         (token_hash, connection_id, slack_team_id, slack_user_id, expires_at, consumed_at, created_at)
       VALUES ('spent', ?, 'T1', 'U1', ?, ?, ?), ('live', ?, 'T1', 'U1', ?, NULL, ?)`,
      CONNECTION, at(-40), at(-40), at(-40),
      CONNECTION, at(200), at(-40),
    );
    await seed(
      `INSERT INTO slack_agent_thread_claims
         (connection_id, slack_channel_id, slack_thread_ts, lease_id, lease_expires_at, created_at, updated_at)
       VALUES (?, 'C1', '1.0', 'lease-lapsed', ?, ?, ?), (?, 'C1', '2.0', 'lease-live', ?, ?, ?)`,
      CONNECTION, at(30), at(20), at(20),
      CONNECTION, at(200), at(20), at(20),
    );
    await seed(
      `INSERT INTO slack_agent_pending_prompts
         (connection_id, slack_channel_id, slack_thread_ts, slack_user_id, prompt,
          denial_reason, expires_at, created_at, updated_at)
       VALUES (?, 'C1', '1.0', 'U1', 'expired prompt', 'policy', ?, ?, ?),
              (?, 'C1', '2.0', 'U1', 'live prompt', 'policy', ?, ?, ?)`,
      CONNECTION, at(30), at(20), at(20),
      CONNECTION, at(200), at(20), at(20),
    );

    const swept = WorkspaceSlackIngressSweepResultSchema.parse(
      await workspace().sweepSlackIngress({
        workspaceId: WORKSPACE_ID,
        at: at(60),
        retentionCutoff: at(-10),
        spentBefore: at(-10),
        exhaustedReportLimit: 10,
      }),
    );
    expect(swept.exhausted).toEqual([{ jobId: "event:dead-new", errorCode: null }]);

    const remaining = await runInDurableObject(workspace(), (_instance, state) => ({
      jobs: state.storage.sql.exec<{ id: string }>(
        `SELECT id FROM slack_ingress_jobs ORDER BY id`,
      ).toArray().map((row) => row.id),
      challenges: state.storage.sql.exec<{ token_hash: string }>(
        `SELECT token_hash FROM slack_link_challenges`,
      ).toArray().map((row) => row.token_hash),
      claims: state.storage.sql.exec<{ lease_id: string }>(
        `SELECT lease_id FROM slack_agent_thread_claims`,
      ).toArray().map((row) => row.lease_id),
      prompts: state.storage.sql.exec<{ prompt: string }>(
        `SELECT prompt FROM slack_agent_pending_prompts`,
      ).toArray().map((row) => row.prompt),
    }));
    expect(remaining).toEqual({
      jobs: ["event:dead-new"],
      challenges: ["live"],
      claims: ["lease-live"],
      prompts: ["live prompt"],
    });
  });
});

describe("Slack thread claims", () => {
  it("gives the thread to one caller and answers the loser `held`", async () => {
    const winner = await claimThread();
    expect(winner.outcome).toBe("claimed");
    expect(await claimThread({ atMinutes: 1 })).toEqual({ outcome: "held" });
    // A different thread is its own claim.
    expect((await claimThread({ threadTs: "2.0" })).outcome).toBe("claimed");
  });

  it("lets a lapsed claim be taken over, with a new lease", async () => {
    const first = await claimThread({ atMinutes: 0 });
    if (first.outcome !== "claimed") throw new Error("expected a claim");
    const second = await claimThread({ atMinutes: 6 });
    if (second.outcome !== "claimed") throw new Error("expected a takeover");
    expect(second.leaseId).not.toBe(first.leaseId);
  });

  it("releases only the caller's own lease", async () => {
    const first = await claimThread();
    if (first.outcome !== "claimed") throw new Error("expected a claim");
    await workspace().releaseSlackThreadClaim({
      workspaceId: WORKSPACE_ID,
      connectionId: CONNECTION,
      channelId: "C1",
      threadTs: "1.0",
      leaseId: "someone-elses-lease",
    });
    // The stranger's release changed nothing: the thread is still held.
    expect(await claimThread({ atMinutes: 1 })).toEqual({ outcome: "held" });
    await workspace().releaseSlackThreadClaim({
      workspaceId: WORKSPACE_ID,
      connectionId: CONNECTION,
      channelId: "C1",
      threadTs: "1.0",
      leaseId: first.leaseId,
    });
    expect((await claimThread({ atMinutes: 2 })).outcome).toBe("claimed");
  });
});

describe("Slack pending prompts and thread routing", () => {
  const prompt = (threadTs: string, expiresMinutes: number) =>
    workspace().rememberSlackPendingPrompt({
      workspaceId: WORKSPACE_ID,
      connectionId: CONNECTION,
      channelId: "C1",
      threadTs,
      slackUserId: "U1",
      prompt: "investigate the deploy",
      denialReason: "policy",
      expiresAt: at(expiresMinutes),
      at: at(0),
    });

  const loadPrompt = (threadTs: string, atMinutes = 1) =>
    workspace().pendingSlackPrompt({
      workspaceId: WORKSPACE_ID,
      connectionId: CONNECTION,
      channelId: "C1",
      threadTs,
      slackUserId: "U1",
      at: at(atMinutes),
    }).then((result) => WorkspaceSlackPendingPromptResultSchema.parse(result));

  const routable = (threadTs: string, atMinutes = 1) =>
    workspace().slackThreadRoutable({
      workspaceId: WORKSPACE_ID,
      connectionId: CONNECTION,
      installationId: "slack:T1",
      channelId: "C1",
      threadTs,
      slackUserId: "U1",
      at: at(atMinutes),
    }).then((result) => WorkspaceSlackThreadRoutableResultSchema.parse(result));

  it("returns a retained prompt until it expires, and clears it exactly", async () => {
    await prompt("1.0", 60);
    expect(await loadPrompt("1.0")).toEqual({ prompt: "investigate the deploy" });
    // Past its horizon the prompt is gone even before the sweep removes it.
    expect(await loadPrompt("1.0", 90)).toEqual({ prompt: null });
    await workspace().clearSlackPendingPrompt({
      workspaceId: WORKSPACE_ID,
      connectionId: CONNECTION,
      channelId: "C1",
      threadTs: "1.0",
      slackUserId: "U1",
    });
    expect(await loadPrompt("1.0")).toEqual({ prompt: null });
  });

  it("routes a bare reply for a bound thread or a live pending prompt only", async () => {
    expect(await routable("1.0")).toEqual({ routable: false, suspended: false });
    await prompt("1.0", 60);
    expect(await routable("1.0")).toEqual({ routable: true, suspended: false });
    // An expired prompt no longer claims the thread.
    expect(await routable("1.0", 90)).toEqual({ routable: false, suspended: false });
    // A thread bound to a Sidekick run routes, written the way a run's send
    // records it.
    expect(await workspace().recordOutboundExternalConversationBinding({
      workspaceId: WORKSPACE_ID,
      installationId: "slack:T1",
      path: ["C1", "2.0"],
      target: {
        kind: "conversation",
        parentKind: "automation",
        parentId: "00000000-0000-7000-8000-0000000c1d40",
        substreamId: "00000000-0000-7000-8000-0000000c1d50",
      },
      at: at(0),
    })).toEqual({ outcome: "bound" });
    expect(await routable("2.0", 90)).toEqual({ routable: true, suspended: false });
    await workspace().suspendExternalConversationBindings({
      workspaceId: WORKSPACE_ID,
      installationId: "slack:T1",
      reason: "connection_disconnected",
      at: at(1),
    });
    expect(await routable("2.0", 90)).toEqual({ routable: false, suspended: true });
  });
});

describe("workspace fencing", () => {
  it("refuses another workspace's ingress request by identity, not by data", async () => {
    // On the instance, not through the stub: a stub's rejected pipelining
    // proxy leaves an unhandled rejection beside the one the assertion takes.
    const outcome = await runInDurableObject(workspace(), async (instance) =>
      instance.claimSlackIngressJob({
        workspaceId: OTHER_WORKSPACE,
        jobId: "event:Ev1",
        at: at(0),
      }).then(() => null, (error: unknown) => error));
    expect(String(outcome)).toContain("workspace_object_identity_mismatch");
  });
});

/** The App Home context, stored wholesale per Slack user on an installation. */
describe("Slack App Home context", () => {
  it("keeps one App Home context per Slack user on an installation", async () => {
    const read = (slackUserId: string) => workspace().slackAppContext({
      workspaceId: WORKSPACE_ID,
      connectionId: CONNECTION,
      slackUserId,
    }).then((result) => WorkspaceSlackContextResultSchema.parse(result));

    expect(await read("U1")).toEqual({ contextJson: null });
    await workspace().storeSlackAppContext({
      workspaceId: WORKSPACE_ID,
      connectionId: CONNECTION,
      slackUserId: "U1",
      contextJson: JSON.stringify({ view: "home" }),
      at: at(0),
    });
    expect(await read("U1")).toEqual({ contextJson: JSON.stringify({ view: "home" }) });
    // Stored wholesale: the second write replaces rather than merges.
    await workspace().storeSlackAppContext({
      workspaceId: WORKSPACE_ID,
      connectionId: CONNECTION,
      slackUserId: "U1",
      contextJson: JSON.stringify({ view: "tasks" }),
      at: at(1),
    });
    expect(await read("U1")).toEqual({ contextJson: JSON.stringify({ view: "tasks" }) });
    // Another Slack user on the same installation is a different row.
    expect(await read("U2")).toEqual({ contextJson: null });
  });
});
