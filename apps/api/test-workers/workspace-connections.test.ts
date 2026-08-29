/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The connector OAuth attempt lifecycle and webhook receipt claims, against
 * the object that owns them.
 *
 * Through the workspace runtime facade an attempt's lazy expiry and the read
 * that reports it were two round trips, a finish's convergence check re-read
 * the row after a refused update, and a receipt claim's duplicate branch was
 * decided from workerd's physical `rowsWritten` counter. These tests drive the
 * typed methods across the real RPC boundary and assert domain outcomes and
 * returned witnesses instead.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import {
  WorkspaceConnectorOAuthAttemptFinishResultSchema,
  WorkspaceConnectorOAuthAttemptReadResultSchema,
  WorkspaceWebhookReceiptClaimResultSchema,
} from "../src/durable-objects/workspace-connections-protocol";

/** Its own workspace: a shared id makes this file queue behind its siblings. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000c1c00");
const MEMBER = "00000000-0000-7000-8000-0000000c1c01";
const OTHER_MEMBER = "00000000-0000-7000-8000-0000000c1c02";
const CONNECTION_ID = "00000000-0000-7000-8000-0000000c1c10";
const OTHER_WORKSPACE_ID = "00000000-0000-7000-8000-0000000c1cff";

const EARLIER = "2026-08-29T09:00:00.000Z";
const NOW = "2026-08-29T10:00:00.000Z";
const LATER = "2026-08-29T10:10:00.000Z";

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

let attemptSequence = 0;
function nextAttemptId(): string {
  attemptSequence += 1;
  return `attempt_${String(attemptSequence).padStart(4, "0")}_`.padEnd(43, "x");
}

async function startAttempt(input: {
  attemptId: string;
  userId?: string;
  expiresAt?: string;
}): Promise<void> {
  await workspace().startConnectorOAuthAttempt({
    workspaceId: WORKSPACE_ID,
    attemptId: input.attemptId,
    region: "global",
    provider: "linear",
    userId: input.userId ?? MEMBER,
    expiresAt: input.expiresAt ?? LATER,
    telemetryScope: "personal",
    telemetryCapabilityCount: 2,
    telemetryReconnect: false,
    at: EARLIER,
  });
}

async function readAttempt(input: {
  attemptId: string;
  userId?: string | null;
  expireDueAt?: string | null;
}) {
  return WorkspaceConnectorOAuthAttemptReadResultSchema.parse(
    await workspace().connectorOAuthAttempt({
      workspaceId: WORKSPACE_ID,
      attemptId: input.attemptId,
      region: "global",
      userId: input.userId === undefined ? null : input.userId,
      expireDueAt: input.expireDueAt === undefined ? null : input.expireDueAt,
    }),
  ).attempt;
}

async function finishAttempt(input: {
  attemptId: string;
  status: "succeeded" | "denied" | "failed";
  connectionId?: string | null;
  errorCode?: string | null;
}) {
  return WorkspaceConnectorOAuthAttemptFinishResultSchema.parse(
    await workspace().finishConnectorOAuthAttempt({
      workspaceId: WORKSPACE_ID,
      attemptId: input.attemptId,
      region: "global",
      status: input.status,
      connectionId: input.connectionId ?? null,
      errorCode: input.errorCode ?? null,
      at: NOW,
    }),
  );
}

async function claimReceipt(input: {
  receiptId: string;
  signatureHash: string;
  receivedAt?: string;
  expiresAt?: string;
}) {
  return WorkspaceWebhookReceiptClaimResultSchema.parse(
    await workspace().claimWebhookReceipt({
      workspaceId: WORKSPACE_ID,
      receiptId: input.receiptId,
      connectionId: CONNECTION_ID,
      signatureHash: input.signatureHash,
      receivedAt: input.receivedAt ?? NOW,
      expiresAt: input.expiresAt ?? LATER,
    }),
  );
}

beforeEach(async () => {
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(`DELETE FROM webhook_receipts`);
    state.storage.sql.exec(`DELETE FROM connector_oauth_attempts`);
    state.storage.sql.exec(`DELETE FROM connector_connections`);
    state.storage.sql.exec(
      `INSERT INTO connector_connections
         (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
          display_name, granted_scopes_json, status, cursor_json, config_json,
          created_at, updated_at, model_plugin_id)
       VALUES (?, ?, 'linear', 'workspace', NULL, 'org-1', 'Linear', '[]', 'healthy',
               '{}', '{}', ?, ?, 'plugin_linear')`,
      CONNECTION_ID,
      WORKSPACE_ID,
      EARLIER,
      EARLIER,
    );
  });
}, 30_000);

describe("connector OAuth attempts", () => {
  it("starts pending and settles once, with a replayed finish converging", async () => {
    const attemptId = nextAttemptId();
    await startAttempt({ attemptId });
    expect(await readAttempt({ attemptId })).toMatchObject({
      status: "pending",
      provider: "linear",
      telemetryScope: "personal",
      telemetryReconnect: false,
    });

    const first = await finishAttempt({ attemptId, status: "denied", errorCode: "oauth_denied" });
    expect(first).toMatchObject({
      outcome: "finished",
      attempt: { status: "denied", errorCode: "oauth_denied", connectionId: null },
    });

    // The same settlement again is a replayed callback step, not an error.
    const replay = await finishAttempt({ attemptId, status: "denied", errorCode: "oauth_denied" });
    expect(replay).toMatchObject({ outcome: "converged", attempt: { status: "denied" } });

    // A different settlement is a conflict the service reports as its 409.
    const conflicting = await finishAttempt({ attemptId, status: "failed", errorCode: "later" });
    expect(conflicting).toEqual({ outcome: "conflict" });
    expect(await readAttempt({ attemptId })).toMatchObject({ status: "denied" });
  });

  it("expires a due pending attempt in the read, and lets a consumed callback still win", async () => {
    const attemptId = nextAttemptId();
    await startAttempt({ attemptId, expiresAt: EARLIER });

    const expired = await readAttempt({ attemptId, userId: MEMBER, expireDueAt: NOW });
    expect(expired).toMatchObject({ status: "failed", errorCode: "oauth_attempt_expired" });

    // The callback consumed valid OAuth state before the poll expired the
    // attempt; success must override the lazy expiry, and only success.
    const finished = await finishAttempt({
      attemptId,
      status: "succeeded",
      connectionId: CONNECTION_ID,
    });
    expect(finished).toMatchObject({
      outcome: "finished",
      attempt: { status: "succeeded", connectionId: CONNECTION_ID, errorCode: null },
    });
  });

  it("keeps a denied settlement out of reach of the expiry override", async () => {
    const attemptId = nextAttemptId();
    await startAttempt({ attemptId });
    await finishAttempt({ attemptId, status: "denied", errorCode: "oauth_denied" });

    const late = await finishAttempt({ attemptId, status: "succeeded", connectionId: CONNECTION_ID });
    expect(late).toEqual({ outcome: "conflict" });
    expect(await readAttempt({ attemptId })).toMatchObject({ status: "denied", connectionId: null });
  });

  it("scopes a member's read so it neither reveals nor expires another member's attempt", async () => {
    const attemptId = nextAttemptId();
    await startAttempt({ attemptId, userId: MEMBER, expiresAt: EARLIER });

    expect(await readAttempt({ attemptId, userId: OTHER_MEMBER, expireDueAt: NOW })).toBeNull();
    // The wrong member's poll did not expire the owner's due attempt.
    expect(await readAttempt({ attemptId, userId: MEMBER })).toMatchObject({ status: "pending" });
  });

  it("revives only a lazily expired attempt for GitHub's second OAuth leg", async () => {
    const expiredId = nextAttemptId();
    await startAttempt({ attemptId: expiredId, expiresAt: EARLIER });
    await readAttempt({ attemptId: expiredId, expireDueAt: NOW });
    await workspace().extendConnectorOAuthAttempt({
      workspaceId: WORKSPACE_ID,
      attemptId: expiredId,
      region: "global",
      expiresAt: LATER,
      at: NOW,
    });
    expect(await readAttempt({ attemptId: expiredId })).toMatchObject({
      status: "pending",
      errorCode: null,
      expiresAt: LATER,
    });

    const deniedId = nextAttemptId();
    await startAttempt({ attemptId: deniedId });
    await finishAttempt({ attemptId: deniedId, status: "denied", errorCode: "oauth_denied" });
    await workspace().extendConnectorOAuthAttempt({
      workspaceId: WORKSPACE_ID,
      attemptId: deniedId,
      region: "global",
      expiresAt: LATER,
      at: NOW,
    });
    expect(await readAttempt({ attemptId: deniedId })).toMatchObject({ status: "denied" });
  });

  it("abandons only a pending start", async () => {
    const attemptId = nextAttemptId();
    await startAttempt({ attemptId });
    await workspace().abandonConnectorOAuthAttempt({ workspaceId: WORKSPACE_ID, attemptId });
    expect(await readAttempt({ attemptId })).toBeNull();

    const settledId = nextAttemptId();
    await startAttempt({ attemptId: settledId });
    await finishAttempt({ attemptId: settledId, status: "denied", errorCode: "oauth_denied" });
    await workspace().abandonConnectorOAuthAttempt({
      workspaceId: WORKSPACE_ID,
      attemptId: settledId,
    });
    expect(await readAttempt({ attemptId: settledId })).toMatchObject({ status: "denied" });
  });

  it("binds the first telemetry operation and keeps it", async () => {
    const attemptId = nextAttemptId();
    await startAttempt({ attemptId });
    await workspace().bindConnectorOAuthAttemptTelemetry({
      workspaceId: WORKSPACE_ID,
      attemptId,
      region: "global",
      operationId: "00000000-0000-7000-8000-0000000c1c20",
      eventVersion: 2,
      at: NOW,
    });
    await workspace().bindConnectorOAuthAttemptTelemetry({
      workspaceId: WORKSPACE_ID,
      attemptId,
      region: "global",
      operationId: "00000000-0000-7000-8000-0000000c1c21",
      eventVersion: 1,
      at: NOW,
    });
    expect(await readAttempt({ attemptId })).toMatchObject({
      telemetryOperationId: "00000000-0000-7000-8000-0000000c1c20",
      telemetryEventVersion: 2,
    });
  });

  it("refuses another workspace's id at the method boundary", async () => {
    const outcome = await runInDurableObject(workspace(), async (instance) =>
      instance.connectorOAuthAttempt({
        workspaceId: OTHER_WORKSPACE_ID,
        attemptId: nextAttemptId(),
        region: "global",
        userId: null,
        expireDueAt: null,
      }).then(() => null, (error: unknown) => error));
    expect(String(outcome)).toContain("workspace_object_identity_mismatch");
  });
});

describe("webhook receipt claims", () => {
  it("claims a delivery once and answers duplicate on the witness, not a write counter", async () => {
    const first = await claimReceipt({
      receiptId: "00000000-0000-7000-8000-0000000c1c30",
      signatureHash: "delivery-1",
    });
    expect(first).toEqual({
      outcome: "claimed",
      receiptId: "00000000-0000-7000-8000-0000000c1c30",
    });

    const replay = await claimReceipt({
      receiptId: "00000000-0000-7000-8000-0000000c1c31",
      signatureHash: "delivery-1",
    });
    expect(replay).toEqual({ outcome: "duplicate" });

    const other = await claimReceipt({
      receiptId: "00000000-0000-7000-8000-0000000c1c32",
      signatureHash: "delivery-2",
    });
    expect(other).toMatchObject({ outcome: "claimed" });
  });

  it("sweeps the connection's expired receipts in the claim's own transaction", async () => {
    await claimReceipt({
      receiptId: "00000000-0000-7000-8000-0000000c1c33",
      signatureHash: "delivery-old",
      receivedAt: EARLIER,
      expiresAt: NOW,
    });

    // A later claim arrives after the first receipt expired: the old row is
    // swept, so the same delivery identity claims again rather than reading as
    // a duplicate of a receipt whose lifetime already ended.
    const reclaimed = await claimReceipt({
      receiptId: "00000000-0000-7000-8000-0000000c1c34",
      signatureHash: "delivery-old",
      receivedAt: LATER,
      expiresAt: "2026-08-30T10:00:00.000Z",
    });
    expect(reclaimed).toMatchObject({ outcome: "claimed" });
    await runInDurableObject(workspace(), (_instance, state) => {
      expect(state.storage.sql.exec<{ id: string }>(
        `SELECT id FROM webhook_receipts WHERE connection_id = ? ORDER BY id`,
        CONNECTION_ID,
      ).toArray()).toEqual([{ id: "00000000-0000-7000-8000-0000000c1c34" }]);
    });
  });

  it("refuses generic runtime SQL naming the receipts table", async () => {
    const refused = await workspace().executeRuntimeSql({
      workspaceId: WORKSPACE_ID,
      requestId: "00000000-0000-7000-8000-0000000c1c40",
      statements: [{
        sql: `SELECT id FROM webhook_receipts WHERE connection_id = ?`,
        params: [CONNECTION_ID],
      }],
    });
    expect(refused.status).toBe(409);
    expect(refused.bodyJson).toContain(
      "workspace_runtime_table_requires_typed_rpc:webhook_receipts",
    );
  });
});
