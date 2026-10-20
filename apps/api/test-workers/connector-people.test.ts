/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { asWorkspaceId, type NormalizedActivity } from "@rally/contracts";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import { beforeEach, expect, it, vi } from "vitest";
import { WorkspaceConnectorEventSchema, WorkspaceConnectorEventClaimResultSchema, WorkspaceConnectorEventProcessQueueMessageSchema } from "../src/durable-objects/workspace-connector-event-protocol";
import { workspaceDOName } from "../src/durable-objects/names";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { readConnectorEventPeople, writeConnectorEventPeople } from "../src/durable-objects/connector-event-people";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import { enqueueWorkspaceConnectorEvent, workspaceConnectorEventQueueMessage } from "../src/services/workspace-connector-event-ingress";
import { ConnectorDeliveryReferenceSchema, readConnectorDeliveryReference, sendConnectorEventDelivery } from "../src/services/connector-queue-payload";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

const WORKSPACE = asWorkspaceId("00000000-0000-7000-8000-00000000f9e0");
const EVENT = "00000000-0000-7000-8000-00000000f9e1";
const USER = "00000000-0000-7000-8000-00000000f9e2";
const CONNECTION = "00000000-0000-7000-8000-00000000f9e3";
const workspace = () => env.WORKSPACE_DOS.getByName(workspaceDOName("global", WORKSPACE));
const person = (index: number) => ({ provider: "google", providerTenantId: "account", providerUserId: null,
  handle: null, email: `guest${index}@example.com`, displayName: null, role: "recipient", sourceText: "meeting evidence ".repeat(30) });

function activity(people: number): NormalizedActivity {
  return { id: EVENT, workspaceId: WORKSPACE, region: "global", connectionId: CONNECTION, connectionScope: "workspace",
    connectionOwnerUserId: null, provider: "google", providerEventId: "large-meeting", eventType: "calendar.event_changed",
    resourceType: "calendar_event", providerResourceId: "large-event", actor: {}, subject: {},
    occurredAt: "2026-10-19T00:00:00.000Z", receivedAt: "2026-10-19T00:00:01.000Z", title: "A large meeting",
    summary: "All invitees", textSnippet: "Meeting", payloadRef: null, visibility: { scope: "workspace" }, targetUserIds: [],
    entityKeys: [], dedupeKey: "large-meeting", rawContentHash: null, metadata: {},
    externalPeople: Array.from({ length: people }, (_, index) => person(index)),
  };
}

beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE, userId: USER, sessionId: "people-session" });
});

it.each([
  ["metadata", 524_288], ["actor", 262_144], ["subject", 262_144], ["summary", 65_536],
] as const)("rejects oversized %s before acknowledging canonical admission", async (field, maximum) => {
  const source = activity(1);
  const value = "x".repeat(maximum + 1);
  Object.assign(source, { [field]: field === "summary" ? value : { value } });
  const code = await enqueueWorkspaceConnectorEvent(env, { connectorType: "google", activity: source })
    .then(() => "unexpected_success", (error: unknown) => zodDiagnosticCode(error, "connector_event"));
  expect(code).toBe(`connector_event_invalid:activity.${field}:too_big`);
});

it("preserves 10,000 people through canonical admission, an ID-only Queue handoff, readback and claim", async () => {
  const probe = env.QUEUE_PROBE;
  const received = env.QUEUE_PROBE_TEST;
  if (!probe || !received) throw new Error("queue probe unavailable");
  await workspace().initializeWorkspace(WORKSPACE, "wnam");
  const source = activity(10_000);
  source.externalPeople!.push(person(0));
  source.metadata = { notes: "x".repeat(130_000) };
  const queueEnv = { ...env, ACTIVITY_QUEUE: probe };
  await enqueueWorkspaceConnectorEvent(queueEnv, { connectorType: "google", activity: source });
  const reference = await vi.waitFor(async () => {
    const references = (await received.received()).flatMap((body) => {
      const result = WorkspaceConnectorEventProcessQueueMessageSchema.safeParse(body);
      return result.success && result.data.workspaceId === WORKSPACE ? [result.data] : [];
    });
    expect(references).toHaveLength(1);
    return references[0]!;
  }, { timeout: 10_000, interval: 50 });
  expect(new TextEncoder().encode(JSON.stringify(reference)).byteLength).toBeLessThan(120_000);
  const stored = WorkspaceConnectorEventSchema.nullable().parse(await workspace().connectorEvent({ workspaceId: WORKSPACE, eventId: EVENT }));
  expect(stored?.activity.externalPeople).toHaveLength(10_000);
  expect(stored?.activity.externalPeople?.[100]?.email).toBe("guest100@example.com");
  expect(stored?.activity.externalPeople?.at(-1)?.email).toBe("guest9999@example.com");
  const claimed = WorkspaceConnectorEventClaimResultSchema.parse(await workspace().claimConnectorEvent({ workspaceId: WORKSPACE, eventId: EVENT,
    processingOwnerId: "00000000-0000-7000-8000-00000000f9e4", attempt: 0, orchestrator: "queue" }));
  expect(claimed.outcome).toBe("claimed");
  if (claimed.outcome === "claimed") expect(claimed.event.activity.externalPeople).toEqual(stored!.activity.externalPeople);
  await runInDurableObject(workspace(), (_instance, state) => {
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM workspace_connector_event_people WHERE event_id = ?", EVENT).one()).toEqual({ count: 10_000 });
    expect(state.storage.sql.exec("SELECT external_people_json FROM workspace_connector_events WHERE event_id = ?", EVENT).one()).toEqual({ external_people_json: "[]" });
    expect(() => state.storage.sql.exec("INSERT INTO workspace_connector_event_people VALUES (?, 10000, '{}')", EVENT)).toThrow(/CHECK/u);
  });
  await workspace().persistOpportunity({
    workspaceId: WORKSPACE, audience: { scope: "workspace", userId: null },
    proposedId: "00000000-0000-7000-8000-00000000f9e5", existingTargetId: null,
    sourceFingerprint: "b".repeat(64), displayPrompt: "Follow up", executionPrompt: "Follow up on the meeting",
    admissionReasoning: "Meeting follow-up", providerIcon: "google", sourceLabel: "Meeting",
    displayPromptHash: "c".repeat(64), executionPromptHash: "d".repeat(64),
    expiresAt: "2099-01-01T00:00:00.000Z", rankDueAt: "2099-01-01T00:00:00.000Z",
    sources: [{ id: EVENT, kind: "activity", provider: "google", providerTenantId: "account", connectionId: CONNECTION,
      title: "Meeting", summary: "", text: "Meeting details", actor: {}, subject: {}, externalPeople: stored!.activity.externalPeople!,
      entityKeys: [], canonicalUrl: null, workstreamId: null, occurredAt: "2026-10-19T00:00:00.000Z" }],
    links: [], rankUserIds: [], eagerUserIds: [],
  });
  await runInDurableObject(workspace(), (_instance, state) => {
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM opportunity_provenance_nodes WHERE node_kind = 'external_person'").one()).toEqual({ count: 10_000 });
  });
  // Large handoffs keep only canonical pointers in the Queue and create no
  // second retained copy of provider content in R2.
  expect((await env.PAYLOADS.list({ prefix: `global/connector-queue/${WORKSPACE}/` })).objects).toEqual([]);
  const delivery = {
    type: "workspace_external_event_delivery_v1" as const, schemaVersion: 1 as const, region: "global" as const,
    workspaceId: WORKSPACE, registrationId: "00000000-0000-7000-8000-00000000f9e8",
    destination: { kind: "automation" as const, automationId: "00000000-0000-7000-8000-00000000f9e9" },
    event: { id: EVENT, eventSequence: 1, eventType: "calendar.event_changed", title: "Meeting", summary: "",
      textSnippet: "Meeting", metadata: source.metadata, occurredAt: Date.parse(source.occurredAt), audienceUserIds: [], audienceKind: "workspace" as const },
    payloadHash: "sha256:" + "a".repeat(64),
  };
  await sendConnectorEventDelivery(queueEnv, delivery);
  const deliveryReference = await vi.waitFor(async () => {
    const matches = (await received.received()).flatMap((body) => {
      const parsed = ConnectorDeliveryReferenceSchema.safeParse(body);
      return parsed.success ? [parsed.data] : [];
    });
    expect(matches).toHaveLength(1);
    return matches[0]!;
  }, { timeout: 10_000, interval: 50 });
  expect(JSON.stringify(deliveryReference).length).toBeLessThan(120_000);
  expect((await readConnectorDeliveryReference(queueEnv, deliveryReference)).event.metadata).toEqual(source.metadata);
// 10,000 real SQLite writes plus Queue delivery and RPC serialization, not a latency assertion.
}, 60_000);

it.each(["calendar.event_changed", "calendar.event_completed", "email.received"])("replays legacy %s payloads, enriches once, and preserves processed status", async (eventType) => {
  await workspace().initializeWorkspace(WORKSPACE, "wnam");
  const legacy = { ...activity(100), eventType, providerEventId: "replay-provider", dedupeKey: "replay-provider" };
  const oldMessage = await workspaceConnectorEventQueueMessage({ connectorType: "google", activity: legacy });
  await workspace().ingestConnectorEvent(oldMessage.request);
  const owner = "normalization-replay";
  const claim = WorkspaceConnectorEventClaimResultSchema.parse(await workspace().claimConnectorEvent({
    workspaceId: WORKSPACE, eventId: EVENT, processingOwnerId: owner, attempt: 0, orchestrator: "queue",
  }));
  if (claim.outcome !== "claimed") throw new Error("expected claim");
  await workspace().settleConnectorEvent({ workspaceId: WORKSPACE, eventId: EVENT, processingOwnerId: owner,
    processingLeaseId: claim.processingLeaseId, outcome: "processed", error: null });
  if (eventType.startsWith("calendar.")) {
    const rosterFirst = await workspaceConnectorEventQueueMessage({ connectorType: "google", activity: {
      ...legacy, id: "00000000-0000-7000-8000-00000000f9f4", externalPeople: activity(151).externalPeople,
    } });
    const attachmentNext = await workspaceConnectorEventQueueMessage({ connectorType: "google", activity: {
      ...legacy, id: "00000000-0000-7000-8000-00000000f9f5", metadata: { attachments: [{ fileId: "transcript-doc", fileUrl: "https://docs.google.com/document/d/transcript-doc/edit", title: "Transcript", mimeType: "application/vnd.google-apps.document" }] },
    } });
    const partials = eventType === "calendar.event_changed" ? [rosterFirst, attachmentNext] : [attachmentNext, rosterFirst];
    for (const partial of partials) await workspace().ingestConnectorEvent(partial.request);
  }
  const upgraded = { ...legacy, id: "00000000-0000-7000-8000-00000000f9f0", externalPeople: activity(151).externalPeople };
  if (eventType.startsWith("calendar.")) upgraded.metadata = { attachments: [{ fileId: "transcript-doc", fileUrl: "https://docs.google.com/document/d/transcript-doc/edit", title: "Transcript", mimeType: "application/vnd.google-apps.document" }] };
  else upgraded.externalPeople = upgraded.externalPeople!.map((value) => ({ ...value, sourceText: value.email! }));
  const nextMessage = await workspaceConnectorEventQueueMessage({ connectorType: "google", activity: upgraded });
  expect(await workspace().ingestConnectorEvent(nextMessage.request)).toMatchObject({ eventId: EVENT, duplicate: true, processingStatus: "processed" });
  expect(await workspace().ingestConnectorEvent(oldMessage.request)).toMatchObject({ eventId: EVENT, duplicate: true, processingStatus: "processed" });
  // Old code can still deliver another page after the richer replay committed.
  const oldReplay = await workspaceConnectorEventQueueMessage({ connectorType: "google", activity: { ...legacy, id: "00000000-0000-7000-8000-00000000f9f1" } });
  expect(await workspace().ingestConnectorEvent(oldReplay.request)).toMatchObject({ eventId: EVENT, duplicate: true, processingStatus: "processed" });
  const read = WorkspaceConnectorEventSchema.parse(await workspace().connectorEvent({ workspaceId: WORKSPACE, eventId: EVENT }));
  expect(read.activity.externalPeople).toHaveLength(151);
  if (eventType.startsWith("calendar.")) expect(read.activity.metadata.attachments).toEqual(upgraded.metadata.attachments);
  const changed = await workspaceConnectorEventQueueMessage({ connectorType: "google", activity: { ...upgraded, id: "00000000-0000-7000-8000-00000000f9f2", title: "Different event content" } });
  await runInDurableObject(workspace(), async (instance, state) => {
    await expect(instance.ingestConnectorEvent(changed.request)).rejects.toThrow("connector_event_identity_reused_with_different_content");
    if (eventType.startsWith("calendar.")) {
      const differentAttachment = await workspaceConnectorEventQueueMessage({ connectorType: "google", activity: {
        ...upgraded, id: "00000000-0000-7000-8000-00000000f9f3", metadata: { attachments: [{ fileId: "different-doc" }] },
      } });
      await expect(instance.ingestConnectorEvent(differentAttachment.request)).rejects.toThrow("connector_event_identity_reused_with_different_content");
    }
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM workspace_connector_events").one()).toEqual({ count: 1 });
  });
});

it("opens populated v121 events without rewriting them and reads legacy people in order", async () => {
  const probe = env.MIGRATION_PROBE_DO!.getByName("connector-people-populated-v121");
  await probe.ping();
  await runInDurableObject(probe, (_instance, state) => {
    applyDurableObjectSqliteMigrations({ storage: state.storage,
      migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 121),
      component: "workspace_do", workerVersionId: "before-people", now: 1 });
    state.storage.sql.exec(`INSERT INTO workspace_connector_events
      (event_id, payload_hash, connection_id, connection_scope, connector_type, provider, provider_event_id, event_type,
       actor_json, subject_json, occurred_at, received_at, title, summary, text_snippet, visibility_json, target_user_ids_json,
       entity_keys_json, dedupe_key, metadata_json, external_people_json, processing_status, created_at, updated_at)
      VALUES (?, ?, ?, 'workspace', 'google', 'google', 'old-event', 'calendar.event_changed', '{}', '{}', 1, 1, 'Old event', '', '', '{}', '[]', '[]', 'old-event', '{}', ?, 'pending', 1, 1)`,
      EVENT, `sha256:${"a".repeat(64)}`, CONNECTION, JSON.stringify([person(0), person(1)]));
  });
  await runInDurableObject(probe, (_instance, state) => {
    applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
      component: "workspace_do", workerVersionId: "with-people", now: 2 });
    const sql = state.storage.sql;
    expect(sql.exec("SELECT COUNT(*) AS count FROM workspace_connector_event_people").one()).toEqual({ count: 0 });
    expect(sql.exec("SELECT external_people_json FROM workspace_connector_events WHERE event_id = ?", EVENT).one())
      .toEqual({ external_people_json: JSON.stringify([person(0), person(1)]) });
    expect(readConnectorEventPeople(sql, EVENT).map((value) => value.email)).toEqual(["guest0@example.com", "guest1@example.com"]);
    // New writes use child rows; the released legacy column stays compatible.
    writeConnectorEventPeople(sql, EVENT, [person(2)]);
    sql.exec("UPDATE workspace_connector_events SET external_people_json = '[]' WHERE event_id = ?", EVENT);
    expect(readConnectorEventPeople(sql, EVENT).map((value) => value.email)).toEqual(["guest2@example.com"]);
    sql.exec("DELETE FROM workspace_connector_events WHERE event_id = ?", EVENT);
    expect(sql.exec("SELECT COUNT(*) AS count FROM workspace_connector_event_people").one()).toEqual({ count: 0 });
    expect(sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
  });
});

it("restores every person when a late event makes a previously dropped repeat relevant", async () => {
  await workspace().initializeWorkspace(WORKSPACE, "wnam");
  const first = "00000000-0000-7000-8000-00000000f9e6";
  const repeat = "00000000-0000-7000-8000-00000000f9e7";
  const late = "00000000-0000-7000-8000-00000000f9e8";
  const ingest = async (id: string, occurredAt: string, title: string) => {
    const source = { ...activity(151), id, providerEventId: id, dedupeKey: id, occurredAt, title };
    const message = await workspaceConnectorEventQueueMessage({ connectorType: "google", activity: source });
    return workspace().ingestConnectorEvent(message.request);
  };
  await ingest(first, "2026-10-19T09:00:00.000Z", "A");
  const dropped = await ingest(repeat, "2026-10-19T11:00:00.000Z", "A");
  expect(dropped.unchangedContent).toBe(true);
  const accepted = await ingest(late, "2026-10-19T10:00:00.000Z", "B");
  expect(accepted.restoredEventId).toBe(repeat);
  const restored = WorkspaceConnectorEventSchema.parse(await workspace().connectorEvent({ workspaceId: WORKSPACE, eventId: repeat }));
  expect(restored.activity.externalPeople).toHaveLength(151);
  expect(restored.activity.externalPeople?.at(-1)?.email).toBe("guest150@example.com");
});
