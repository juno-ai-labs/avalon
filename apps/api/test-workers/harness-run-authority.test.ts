/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The durable harness-run authority, on real workerd.
 *
 * The Node suite proves what the claim's SQL decides. This proves the two
 * things only the runtime can: that a claim and the sidebar projection it
 * feeds are one commit, and that the object refuses a claim it is not the
 * authority for before any lease moves.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { asSubstreamId } from "@rally/contracts";

import { substreamAgentName } from "../src/durable-objects/names";
import {
  WORKSPACE_ID,
  WORKSTREAM_ID,
  boot,
  post,
  seedOpenWorkstreamAuthority,
  seedRun,
  seedWorkstreamRoot,
} from "./helpers/substream-fixture";

beforeAll(async () => {
  await seedOpenWorkstreamAuthority(env.DB);
});

const RUN = "00000000-0000-7000-8000-0000000000b1";

let unique = 0;
/** A fresh object per test; a reused id would carry the last test's rows. */
function agent(): DurableObjectStub {
  unique += 1;
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    substreamAgentName(
      "global",
      WORKSPACE_ID,
      WORKSTREAM_ID,
      asSubstreamId(`00000000-0000-7000-8000-${String(unique).padStart(12, "3")}`),
    ),
  ));
}

/** Call the real endpoint, exactly as the Worker's port does. */
async function harnessRuns(
  stub: DurableObjectStub,
  operation: string,
  ...args: unknown[]
): Promise<{ status: number; value: unknown; error?: string }> {
  const { status, body } = await post(stub, "/internal/harness-runs", {
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    operation,
    args,
  });
  const parsed = body as { value?: unknown; error?: string } | null;
  return { status, value: parsed?.value ?? null, ...(parsed?.error ? { error: parsed.error } : {}) };
}

function claim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: RUN,
    attemptId: "attempt-1",
    owner: "owner-1",
    now: Date.now(),
    leaseSeconds: 60,
    lifecycleEventId: "00000000-0000-7000-8000-0000000000c1",
    ...overrides,
  };
}

describe("harness-run authority on real workerd", () => {
  it("commits the claim and the directory projection in one step", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      seedRun(state, RUN);
    });

    const result = await harnessRuns(stub, "claimAttempt", claim());

    expect(result.status).toBe(200);
    expect(result.value).toMatchObject({ outcome: "claimed", attemptEpoch: 1 });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT status FROM runs WHERE run_id = ?`, RUN).one().status)
        .toBe("running");
      // The routed claim wrote `workstreams.harness_status` as a third
      // statement guarded on the first having landed. The sidebar renders it,
      // and a guarded follow-up is a projection that can be lost; committing it
      // with the claim is what replaces the guard.
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM projection_keys WHERE projection_key = 'common'`,
      ).one().count).toBe(1);
    });
  });

  it("prepares the final payload before atomically publishing its message and projection", async () => {
    const stub = agent();
    await boot(stub);
    const now = Date.now();
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      seedRun(state, RUN);
    });
    await harnessRuns(stub, "claimAttempt", claim({ now }));

    const publishedAt = now + 1_000;
    const result = await harnessRuns(stub, "publishFinalMessage", {
      runId: RUN,
      attemptId: "attempt-1",
      owner: "owner-1",
      now: publishedAt,
      messageId: "final-message-1",
      text: "The work is complete.",
      hostOutcomeStatus: "completed",
      eventPayloadJson: "{}",
      lifecycleEventId: "final-message-event-1",
      allowCancellationRequested: false,
    });

    expect(result.value).toEqual({ outcome: "published", sequenceNumber: 1 });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT content FROM workstream_message_details WHERE id = 'final-message-1'`,
      ).one().content).toBe("The work is complete.");
      expect(state.storage.sql.exec(
        `SELECT event_type FROM run_lifecycle_events WHERE event_id = 'final-message-event-1'`,
      ).one().event_type).toBe("final_message_persisted");
      const envelope = JSON.parse(state.storage.sql.exec<{ payload_json: string }>(
        `SELECT payload_json FROM durable_outbox
          WHERE partition_key = 'common' ORDER BY source_version DESC LIMIT 1`,
      ).one().payload_json) as { effect: { updatedAt: string } };
      expect(envelope.effect.updatedAt).toBe(new Date(publishedAt).toISOString());
    });
  });

  it("leaves no projection behind for a heartbeat", async () => {
    const stub = agent();
    await boot(stub);
    const now = Date.now();
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      seedRun(state, RUN);
      // The lease is seeded directly rather than claimed, so this object has
      // never committed a projection. A claim would create the row and leave
      // only its version to compare — and the version is content-addressed, so
      // a heartbeat that *did* commit would not move it. Starting from no row
      // is what makes the assertion below about the commit rather than about
      // the preview happening not to change.
      state.storage.sql.exec(
        `UPDATE runs SET status = 'running', legacy_attempt_id = 'attempt-1',
                        lease_owner = 'owner-1', lease_expires_at = ?, updated_at = ?
          WHERE run_id = ?`,
        now + 60_000,
        now,
        RUN,
      );
    });

    const beat = await harnessRuns(stub, "heartbeatAttempt", {
      runId: RUN,
      attemptId: "attempt-1",
      owner: "owner-1",
      now,
      leaseSeconds: 60,
    });

    // A heartbeat moves a deadline nobody renders. Committing a projection
    // every few seconds for every live run is the failure the other direction.
    expect(beat.value).toMatchObject({ outcome: "renewed" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS count FROM projection_keys`).one().count)
        .toBe(0);
    });
  });

  it("refuses a claim naming another work stream, before any lease moves", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      seedRun(state, RUN);
    });

    const { status, body } = await post(stub, "/internal/harness-runs", {
      workspaceId: WORKSPACE_ID,
      workstreamId: "00000000-0000-7000-8000-0000000000ff",
      operation: "claimAttempt",
      args: [claim()],
    });

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: "workstream_harness_run_identity_mismatch" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT lease_owner FROM runs WHERE run_id = ?`, RUN,
      ).one().lease_owner).toBeNull();
    });
  });

  it("refuses a claim against an object that is no longer the authority", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      seedRun(state, RUN);
      state.storage.sql.exec(`UPDATE workstream SET authority_mode = 'quarantined' WHERE id = 1`);
    });

    const result = await harnessRuns(stub, "claimAttempt", claim());

    expect(result.status).toBe(409);
    expect(result.error).toBe("workstream_runtime_authority_fenced");
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT lease_owner FROM runs WHERE run_id = ?`, RUN,
      ).one().lease_owner).toBeNull();
    });
  });

  it("refuses an operation that is not on the contract", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));

    const { status, body } = await post(stub, "/internal/harness-runs", {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      operation: "terminalizeEverything",
      args: [],
    });

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: "invalid_harness_run_operation" });
  });
});
