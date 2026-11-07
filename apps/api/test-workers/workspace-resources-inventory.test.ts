/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The resource inventory's typed methods, against the object that owns it.
 *
 * These are the decisions the workspace runtime facade used to spread over
 * separate round trips: an upload commit racing its own existence check, a
 * connector resolve read-insert-reread, an inbound email's claim/reclaim, the
 * reaper's reference check racing a deletion, and the alias claim. Each is one
 * critical section in the object now, and each refusal is a typed outcome the
 * service maps to its own error rather than a bare thrown message.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";

/** Its own workspace: a shared id makes this file queue behind its siblings. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000ea0");
const UPLOADER = asUserId("00000000-0000-7000-8000-000000000ca1");
const OTHER_MEMBER = asUserId("00000000-0000-7000-8000-000000000ca2");
const CONNECTION = "00000000-0000-7000-8000-000000000cc0";
const WORKSTREAM = "00000000-0000-7000-8000-000000000cc1";
const AT = "2026-08-29T00:00:00.000Z";

function workspace(): DurableObjectStub<WorkspaceDO> {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

let sequence = 0;
function nextId(): string {
  sequence += 1;
  return `00000000-0000-7000-8000-00000000${String(sequence).padStart(4, "0")}`;
}

async function createDraft(input: {
  resourceId?: string;
  contentRef?: string;
  at?: string;
  uploadedByUserId?: string;
} = {}) {
  const resourceId = input.resourceId ?? nextId();
  const outcome = await workspace().createUploadDraftResource({
    workspaceId: WORKSPACE_ID,
    resourceId,
    title: "notes.txt",
    mimeType: "text/plain",
    contentRef: input.contentRef ?? `global/${WORKSPACE_ID}/resources/${resourceId}/sha/one`,
    contentSha256: "a".repeat(64),
    metadataJson: '{"size":5}',
    uploadedByUserId: input.uploadedByUserId ?? UPLOADER,
    // Today, not the fixture date. A draft dated `AT` is already past the
    // 24-hour expiry, so an expired-draft sweep from an alarm that was already
    // running when `disarm` ran could reap it mid-test. A case about expiry
    // passes its own old date.
    at: input.at ?? new Date().toISOString(),
  });
  return { resourceId, outcome };
}

async function outboxRow(objectRef: string): Promise<Record<string, unknown> | null> {
  return runInDurableObject(workspace(), (_instance, state) => (
    state.storage.sql.exec<Record<string, string | number | null>>(
      `SELECT object_ref, cleanup_eligible FROM resource_object_deletion_outbox
        WHERE object_ref = ?`,
      objectRef,
    ).toArray()[0] ?? null
  ));
}

beforeEach(async () => {
  await reset();
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  await disarm();
});

/**
 * Leave no wake-up behind.
 *
 * `reset()` clears an object's storage; it does not cancel a wake-up the
 * platform has already been told about. One is delivered as a real `alarm()`
 * that runs the whole handler — including the resource sweep, which reaps a
 * draft whose `created_at` is in the past, which every draft in this file's
 * fixture is. `scheduled-alarms.test.ts` disarms for the same reason.
 */
afterEach(disarm);

async function disarm(): Promise<void> {
  try {
    await runInDurableObject(workspace(), (_instance, state) => state.storage.deleteAlarm());
  } catch {
    // The object may never have been created, or may already be gone.
  }
}

describe("upload drafts", () => {
  it("commits the draft and adopts its staged object in one decision", async () => {
    const contentRef = "global/staged/upload-one";
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO resource_object_deletion_outbox
           (object_ref, workspace_id, resource_id, object_kind, cleanup_eligible, created_at, updated_at)
         VALUES (?, ?, ?, 'original', 0, ?, ?)`,
        contentRef, WORKSPACE_ID, "00000000-0000-7000-8000-00000000fff0", AT, AT,
      );
    });

    const created = await createDraft({
      resourceId: "00000000-0000-7000-8000-00000000fff0",
      contentRef,
    });

    expect(created.outcome).toEqual({ outcome: "created" });
    // The staged registration existed only to protect bytes with no pointer;
    // once the pointer commits, the same transaction retires it.
    expect(await outboxRow(contentRef)).toBeNull();
    expect(await workspace().resourceExists({
      workspaceId: WORKSPACE_ID,
      resourceId: "00000000-0000-7000-8000-00000000fff0",
    })).toEqual({ exists: true });
  });

  it("answers a duplicate draft id as an outcome rather than a constraint throw", async () => {
    const { resourceId } = await createDraft();
    const replay = await createDraft({ resourceId, contentRef: "global/staged/second" });
    expect(replay.outcome).toEqual({ outcome: "draft_exists" });
    // The loser wrote nothing, so its staged object stays whatever it was.
    expect(await outboxRow("global/staged/second")).toBeNull();
  });

  it("refuses to delete a reserved draft and deletes an unreserved one durably", async () => {
    const { resourceId } = await createDraft();
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO pending_attachment_reservations
           (workspace_id, workstream_id, input_id, resource_id, user_id, created_at)
         VALUES (?, ?, ?, ?, ?, 1)`,
        WORKSPACE_ID, WORKSTREAM, "00000000-0000-7000-8000-00000000ffe0", resourceId, UPLOADER,
      );
    });

    expect(await workspace().deleteUploadDraftResource({
      workspaceId: WORKSPACE_ID,
      resourceId,
      userId: UPLOADER,
    })).toEqual({ outcome: "not_found" });

    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM pending_attachment_reservations`);
    });
    expect(await workspace().deleteUploadDraftResource({
      workspaceId: WORKSPACE_ID,
      resourceId,
      userId: OTHER_MEMBER,
    })).toEqual({ outcome: "not_found" });
    expect(await workspace().deleteUploadDraftResource({
      workspaceId: WORKSPACE_ID,
      resourceId,
      userId: UPLOADER,
    })).toEqual({ outcome: "deleted" });
    // The schema's deletion triggers queued the original for the reaper.
    const queued = await runInDurableObject(workspace(), (_instance, state) => (
      state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM resource_object_deletion_outbox`,
      ).one()
    ));
    expect(queued.count).toBeGreaterThan(0);
  });

  it("reaps only expired drafts that nothing links and nothing reserves", async () => {
    const expired = await createDraft({ at: "2026-01-01T00:00:00.000Z", contentRef: "global/staged/expired" });
    const reserved = await createDraft({ at: "2026-01-01T00:00:00.000Z", contentRef: "global/staged/reserved" });
    const fresh = await createDraft({ at: new Date().toISOString(), contentRef: "global/staged/fresh" });
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO pending_attachment_reservations
           (workspace_id, workstream_id, input_id, resource_id, user_id, created_at)
         VALUES (?, ?, ?, ?, ?, 1)`,
        WORKSPACE_ID, WORKSTREAM, "00000000-0000-7000-8000-00000000ffe1", reserved.resourceId, UPLOADER,
      );
    });

    expect(await workspace().reapExpiredDraftResources({ workspaceId: WORKSPACE_ID }))
      .toEqual({ removed: 1 });

    const remaining = await runInDurableObject(workspace(), (_instance, state) => (
      state.storage.sql.exec<{ id: string }>(`SELECT id FROM resources ORDER BY id`).toArray()
    ));
    expect(remaining.map((row) => row.id).sort())
      .toEqual([reserved.resourceId, fresh.resourceId].sort());
    void expired;
  });
});

describe("connector resources", () => {
  it("starts and stops a design-specific Canva poll with its Sidekick registration", async () => {
    const resourceId = nextId();
    await workspace().resolveConnectorResource({ workspaceId: WORKSPACE_ID, candidateResourceId: resourceId,
      connectionId: CONNECTION, provider: "canva", providerResourceId: "design", resourceType: "canva_design",
      title: "Design", canonicalUrl: null, at: AT });
    const evaluatorId = nextId();
    const destination = { kind: "automation", automationId: nextId() };
    const project = (sourceGeneration: number, active: boolean) => workspace().applyExternalEventRegistrations({
      schemaVersion: 1, workspaceId: WORKSPACE_ID, destination, sourceGeneration,
      evaluators: active ? [{ evaluatorId, source: { connectorType: "canva", connectionId: CONNECTION,
        eventType: "design.revised", resourceId }, when: { kind: "always" } }] : [],
    });
    await project(1, true);
    const schedule = () => runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
      "SELECT enabled, interval_seconds FROM schedules WHERE id = ?", evaluatorId,
    ).one());
    expect(await schedule()).toEqual({ enabled: 1, interval_seconds: 600 });
    await project(2, false);
    expect(await schedule()).toEqual({ enabled: 0, interval_seconds: 600 });
    await project(1, true);
    expect(await schedule()).toEqual({ enabled: 0, interval_seconds: 600 });
  });
  it("persists and replaces protected access separately from ordinary resource metadata", async () => {
    const request = { workspaceId: WORKSPACE_ID, candidateResourceId: nextId(), connectionId: CONNECTION,
      provider: "canva", providerResourceId: "design", resourceType: "canva_design", title: "Design",
      canonicalUrl: "https://www.canva.com/design/design/view", protectedAccessJson: "encrypted-one", at: AT };
    const created = await workspace().resolveConnectorResource(request);
    if (created.outcome === "connection_unavailable") throw new Error("unexpected_connection_refusal");
    await workspace().resolveConnectorResource({ ...request, candidateResourceId: nextId(), protectedAccessJson: "encrypted-two" });
    const row = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
      "SELECT protected_access_json, canonical_url, metadata_json FROM resources WHERE id = ?", created.resourceId,
    ).one());
    expect(row).toEqual({ protected_access_json: "encrypted-two", canonical_url: request.canonicalUrl, metadata_json: "{}" });
  });
  it("gives every concurrent resolve of one provider identity the same row", async () => {
    const resolve = () => workspace().resolveConnectorResource({
      workspaceId: WORKSPACE_ID,
      candidateResourceId: nextId(),
      connectionId: CONNECTION,
      provider: "notion",
      providerResourceId: "page-1",
      resourceType: "document",
      title: "Spec",
      canonicalUrl: null,
      at: AT,
    });
    const results = await Promise.all([resolve(), resolve(), resolve()]);
    // Which caller the object serialized first is not this test's to assume:
    // exactly one resolve created the row, and every caller got the same id.
    expect(results.filter((result) => result.outcome === "created")).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "existing")).toHaveLength(2);
    expect(new Set(results.map((result) => {
      if (result.outcome === "connection_unavailable") throw new Error("unexpected_connection_refusal");
      return result.resourceId;
    })).size).toBe(1);
  });
});

describe("hydration and version history", () => {
  it("swaps content under its fence and records the history capture makes", async () => {
    const { resourceId } = await createDraft({ contentRef: "global/original-1" });
    const published = await workspace().publishResourceHydration({
      workspaceId: WORKSPACE_ID,
      resourceId,
      connectionId: CONNECTION,
      contentRef: "global/original-2",
      contentSha256: "b".repeat(64),
      expectedContentRef: "global/original-1",
      expectedContentSha256: "a".repeat(64),
      at: "2026-08-29T01:00:00.000Z",
    });
    expect(published).toEqual({ updated: true });

    const history = await workspace().listResourceVersions({
      workspaceId: WORKSPACE_ID,
      resourceId,
      version: null,
    });
    expect(history.items.map((item) => ({
      version: item.version,
      content_ref: item.content_ref,
      cause: item.cause,
    }))).toEqual([
      { version: 2, content_ref: "global/original-2", cause: "refetched" },
      { version: 1, content_ref: "global/original-1", cause: "created" },
    ]);

    // A swap fenced on content the row no longer holds writes nothing, which
    // is the caller's signal to release the object it staged for it.
    expect(await workspace().publishResourceHydration({
      workspaceId: WORKSPACE_ID,
      resourceId,
      connectionId: CONNECTION,
      contentRef: "global/original-3",
      contentSha256: "c".repeat(64),
      expectedContentRef: "global/original-1",
      expectedContentSha256: "a".repeat(64),
      at: "2026-08-29T02:00:00.000Z",
    })).toEqual({ updated: false });
    expect((await workspace().listResourceVersions({
      workspaceId: WORKSPACE_ID,
      resourceId,
      version: null,
    })).items).toHaveLength(2);
  });

  it("serves one version by number and draft descriptors by their owner alone", async () => {
    const { resourceId } = await createDraft();
    const one = await workspace().listResourceVersions({
      workspaceId: WORKSPACE_ID,
      resourceId,
      version: 1,
    });
    expect(one.items).toHaveLength(1);
    expect(one.items[0]).toMatchObject({ version: 1, title: "notes.txt" });
    expect((await workspace().listResourceVersions({
      workspaceId: WORKSPACE_ID,
      resourceId,
      version: 9,
    })).items).toEqual([]);

    // The draft filter travels with the request: another member cannot reach
    // this draft by id, and its owner can.
    const mine = await workspace().resourceDescriptors({
      workspaceId: WORKSPACE_ID,
      resourceIds: [resourceId],
      draftUploadedByUserId: UPLOADER,
    });
    expect(mine.items.map((item) => item.id)).toEqual([resourceId]);
    const theirs = await workspace().resourceDescriptors({
      workspaceId: WORKSPACE_ID,
      resourceIds: [resourceId],
      draftUploadedByUserId: OTHER_MEMBER,
    });
    expect(theirs.items).toEqual([]);
  });
});

describe("resource watches", () => {
  it("re-enables a paused watch on its existing row rather than a second one", async () => {
    const { resourceId } = await createDraft();
    const enable = (watchId: string, watchType: "incremental" | "webhook") =>
      workspace().enableResourceWatch({
        workspaceId: WORKSPACE_ID,
        watchId,
        workstreamId: WORKSTREAM,
        resourceId,
        connectionId: CONNECTION,
        watchType,
        nextPollAt: watchType === "incremental" ? AT : null,
        at: AT,
      });
    const firstWatchId = nextId();
    await enable(firstWatchId, "incremental");
    await workspace().disableResourceWatch({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM,
      resourceId,
      at: AT,
    });
    await enable(nextId(), "webhook");

    const rows = await runInDurableObject(workspace(), (_instance, state) => (
      state.storage.sql.exec<Record<string, string | number | null>>(
        `SELECT id, watch_type, next_poll_at, enabled FROM resource_watches`,
      ).toArray()
    ));
    expect(rows).toEqual([{
      id: firstWatchId,
      watch_type: "webhook",
      next_poll_at: null,
      enabled: 1,
    }]);
  });
});

describe("inbound email receipts", () => {
  const claim = (leaseExpiresAt = "2099-01-01T00:00:00.000Z") =>
    workspace().claimInboundEmailReceipt({
      workspaceId: WORKSPACE_ID,
      resendEmailId: "resend-email-1",
      workstreamId: WORKSTREAM,
      svixId: "svix-1",
      receivedAt: AT,
      leaseExpiresAt,
    });

  it("claims once, holds concurrents off, and settles under its lease", async () => {
    const claimed = await claim();
    expect(claimed.outcome).toBe("claimed");
    expect(claimed.leaseToken).not.toBeNull();

    expect((await claim()).outcome).toBe("in_progress");

    expect(await workspace().settleInboundEmailProcessed({
      workspaceId: WORKSPACE_ID,
      resendEmailId: "resend-email-1",
      workstreamId: WORKSTREAM,
      leaseToken: "somebody-else",
      payloadRef: "payload/one",
      processedAt: AT,
    })).toEqual({ outcome: "lease_lost" });

    expect(await workspace().settleInboundEmailProcessed({
      workspaceId: WORKSPACE_ID,
      resendEmailId: "resend-email-1",
      workstreamId: WORKSTREAM,
      leaseToken: claimed.leaseToken!,
      payloadRef: "payload/one",
      processedAt: AT,
    })).toEqual({ outcome: "processed" });

    expect((await claim()).outcome).toBe("already_processed");
  });

  it("takes over an expired lease and reports a renewal on it as lost", async () => {
    const interrupted = await claim("2000-01-01T00:00:00.000Z");
    expect(interrupted.outcome).toBe("claimed");

    const reclaimed = await claim();
    expect(reclaimed.outcome).toBe("claimed");
    expect(reclaimed.leaseToken).not.toBe(interrupted.leaseToken);

    expect(await workspace().renewInboundEmailLease({
      workspaceId: WORKSPACE_ID,
      resendEmailId: "resend-email-1",
      workstreamId: WORKSTREAM,
      leaseToken: interrupted.leaseToken!,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    })).toEqual({ outcome: "lease_lost" });
    expect(await workspace().renewInboundEmailLease({
      workspaceId: WORKSPACE_ID,
      resendEmailId: "resend-email-1",
      workstreamId: WORKSTREAM,
      leaseToken: reclaimed.leaseToken!,
      leaseExpiresAt: "2099-01-02T00:00:00.000Z",
    })).toEqual({ outcome: "renewed" });
  });

  it("records exactly one version for an email however many times it is delivered", async () => {
    const upsert = (contentRef: string, at: string) => workspace().upsertInboundEmailResource({
      workspaceId: WORKSPACE_ID,
      candidateResourceId: nextId(),
      resendEmailId: "resend-email-2",
      title: "Quarterly update",
      contentRef,
      metadataJson: "{}",
      at,
    });
    const versionCount = (resourceId: string) =>
      runInDurableObject(workspace(), (_instance, state) => (
        state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM resource_versions WHERE resource_id = ?`,
          resourceId,
        ).one()
      ));
    const first = await upsert("payload/email-one", AT);
    // The routed version followed its insert with an unconditional refresh,
    // which fired the semantic-version trigger and recorded a phantom second
    // version of every email on its first ingestion.
    expect((await versionCount(first.resourceId)).count).toBe(1);

    // The realistic replay — a crashed delivery whose lease was taken over —
    // re-derives byte-identical values from the same retrieved message, its
    // payload pointer included. SQLite's UPDATE-OF triggers fire on a column
    // being assigned, not changed, so an identical replay must write nothing.
    const replay = await upsert("payload/email-one", "2026-08-29T01:00:00.000Z");
    expect(replay.resourceId).toBe(first.resourceId);
    expect((await versionCount(first.resourceId)).count).toBe(1);

    // Genuinely changed content is a new state of the resource and is kept.
    const changed = await upsert("payload/email-one-refetched", "2026-08-29T02:00:00.000Z");
    expect(changed.resourceId).toBe(first.resourceId);
    const refreshed = await runInDurableObject(workspace(), (_instance, state) => (
      state.storage.sql.exec<{ content_ref: string }>(
        `SELECT content_ref FROM resources WHERE id = ?`,
        first.resourceId,
      ).one()
    ));
    expect(refreshed.content_ref).toBe("payload/email-one-refetched");
    expect((await versionCount(first.resourceId)).count).toBe(2);
  });
});

describe("object cleanup claims", () => {
  it("decides retired, awaiting-publisher and removable in one critical section", async () => {
    const { resourceId } = await createDraft({ contentRef: "global/referenced" });
    await runInDurableObject(workspace(), (_instance, state) => {
      const seed = (objectRef: string, eligible: number) => state.storage.sql.exec(
        `INSERT OR IGNORE INTO resource_object_deletion_outbox
           (object_ref, workspace_id, resource_id, object_kind, cleanup_eligible, created_at, updated_at)
         VALUES (?, ?, ?, 'original', ?, ?, ?)`,
        objectRef, WORKSPACE_ID, resourceId, eligible, AT, AT,
      );
      seed("global/referenced", 1);
      seed("global/staged-in-flight", 0);
      seed("global/abandoned", 1);
    });

    // A pointer still names the object: the row is retired and the bytes stay.
    expect(await workspace().claimResourceObjectRemoval({
      workspaceId: WORKSPACE_ID,
      objectRef: "global/referenced",
    })).toEqual({ outcome: "retired" });
    expect(await outboxRow("global/referenced")).toBeNull();

    // A publisher still owns this one; the reaper must not take the bytes.
    expect(await workspace().claimResourceObjectRemoval({
      workspaceId: WORKSPACE_ID,
      objectRef: "global/staged-in-flight",
    })).toEqual({ outcome: "awaiting_publisher" });

    expect(await workspace().claimResourceObjectRemoval({
      workspaceId: WORKSPACE_ID,
      objectRef: "global/abandoned",
    })).toEqual({ outcome: "removable" });
    expect(await workspace().retireResourceObjectStaging({
      workspaceId: WORKSPACE_ID,
      objectRef: "global/abandoned",
    })).toEqual({ retired: true });
    expect(await workspace().claimResourceObjectRemoval({
      workspaceId: WORKSPACE_ID,
      objectRef: "global/abandoned",
    })).toEqual({ outcome: "missing" });
  });
});

describe("discovered webhook resources", () => {
  it("registers a provider's resources once and refreshes what the connection knows", async () => {
    const first = nextId();
    const upsert = (id: string, title: string, canonicalUrl: string | null, metadataJson: string, at: string) =>
      workspace().upsertDiscoveredResources({
        workspaceId: WORKSPACE_ID,
        connectionId: CONNECTION,
        provider: "github",
        resources: [{
          id,
          resourceType: "github_pull_request",
          providerResourceId: "repo#41",
          title,
          canonicalUrl,
          metadataJson,
        }],
        at,
      });
    await upsert(first, "Fix the build", "https://github.com/acme/repo/pull/41", '{"state":"open"}', AT);
    await upsert(nextId(), "Fix the build (updated)", null, '{"merged":true}', "2026-08-29T01:00:00.000Z");

    const rows = await runInDurableObject(workspace(), (_instance, state) => (
      state.storage.sql.exec<Record<string, string | number | null>>(
        `SELECT id, title, canonical_url, metadata_json, updated_at FROM resources`,
      ).toArray()
    ));
    // One row: the second delivery refreshed the connection's existing
    // resource rather than minting a duplicate, kept the canonical URL it
    // could no longer see, and patched the metadata rather than replacing it.
    expect(rows).toEqual([{
      id: first,
      title: "Fix the build (updated)",
      canonical_url: "https://github.com/acme/repo/pull/41",
      metadata_json: '{"state":"open","merged":true}',
      updated_at: "2026-08-29T01:00:00.000Z",
    }]);
  });
});

describe("resource aliases", () => {
  it("answers a claim with exactly why it did or did not allocate", async () => {
    const first = await createDraft();
    const second = await createDraft();

    expect(await workspace().claimResourceSlug({
      workspaceId: WORKSPACE_ID,
      resourceId: first.resourceId,
      candidate: "bright-steady-luminous-curie",
    })).toEqual({ outcome: "allocated", slug: "bright-steady-luminous-curie" });

    expect(await workspace().claimResourceSlug({
      workspaceId: WORKSPACE_ID,
      resourceId: first.resourceId,
      candidate: "calm-quiet-amber-noether",
    })).toEqual({ outcome: "already_named", slug: "bright-steady-luminous-curie" });

    expect(await workspace().claimResourceSlug({
      workspaceId: WORKSPACE_ID,
      resourceId: second.resourceId,
      candidate: "bright-steady-luminous-curie",
    })).toEqual({ outcome: "candidate_taken", slug: null });

    expect(await workspace().claimResourceSlug({
      workspaceId: WORKSPACE_ID,
      resourceId: "00000000-0000-7000-8000-00000000ffee",
      candidate: "calm-quiet-amber-noether",
    })).toEqual({ outcome: "missing", slug: null });

    expect(await workspace().listResourcesAwaitingSlug({ workspaceId: WORKSPACE_ID }))
      .toEqual({ items: [second.resourceId] });
  });
});

describe("workspace identity", () => {
  it("refuses a request addressed to a different workspace", async () => {
    // Asserted inside the object's own isolate: a rejecting native RPC stub
    // holds a second rejected promise the caller cannot settle, which workerd
    // reports as an uncaught exception even when the test handles its own.
    await runInDurableObject(workspace(), async (instance: WorkspaceDO) => {
      const outcome = await instance.resourceExists({
        workspaceId: asWorkspaceId("00000000-0000-7000-8000-000000000eae"),
        resourceId: "00000000-0000-7000-8000-00000000ffef",
      }).then(() => null, (error: unknown) => error);
      expect(String(outcome)).toContain("workspace_object_identity_mismatch");
    });
  });
});
