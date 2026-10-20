/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { asWorkspaceId, type NormalizedActivity } from "@rally/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { WorkspaceConnectorEventSchema, WorkspaceConnectorEventClaimResultSchema } from "../src/durable-objects/workspace-connector-event-protocol";
import { workspaceDOName } from "../src/durable-objects/names";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import { enqueueWorkspaceConnectorEvent, workspaceConnectorEventQueueMessage } from "../src/services/workspace-connector-event-ingress";
import { ConnectorQueuePayloadSchema, readConnectorQueuePayload } from "../src/services/connector-queue-payload";
import { consumeEffectBodies } from "./helpers/conversation-effects";
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

it("preserves 10,000 deduplicated people through a real Queue, R2 staging, ingestion, readback and claim", async () => {
  const probe = env.QUEUE_PROBE;
  const received = env.QUEUE_PROBE_TEST;
  if (!probe || !received) throw new Error("queue probe unavailable");
  await workspace().initializeWorkspace(WORKSPACE, "wnam");
  const source = activity(10_000);
  source.externalPeople!.push(person(0));
  const queueEnv = { ...env, ACTIVITY_QUEUE: probe };
  await enqueueWorkspaceConnectorEvent(queueEnv, { connectorType: "google", activity: source });
  const reference = await vi.waitFor(async () => {
    const references = (await received.received()).flatMap((body) => {
      const result = ConnectorQueuePayloadSchema.safeParse(body);
      return result.success && result.data.workspaceId === WORKSPACE ? [result.data] : [];
    });
    expect(references).toHaveLength(1);
    return references[0]!;
  }, { timeout: 10_000, interval: 50 });
  expect(new TextEncoder().encode(JSON.stringify(reference)).byteLength).toBeLessThan(120_000);
  expect(await consumeEffectBodies(queueEnv, [reference])).toEqual({ acked: 1, retried: 0 });
  const stored = WorkspaceConnectorEventSchema.nullable().parse(await workspace().connectorEvent({ workspaceId: WORKSPACE, eventId: EVENT }));
  expect(stored?.activity.externalPeople).toHaveLength(10_000);
  expect(stored?.activity.externalPeople?.[100]?.email).toBe("guest100@example.com");
  expect(stored?.activity.externalPeople?.at(-1)?.email).toBe("guest9999@example.com");
  const claimed = WorkspaceConnectorEventClaimResultSchema.parse(await workspace().claimConnectorEvent({ workspaceId: WORKSPACE, eventId: EVENT,
    processingOwnerId: "00000000-0000-7000-8000-00000000f9e4", attempt: 0, orchestrator: "queue" }));
  expect(claimed.outcome).toBe("claimed");
  if (claimed.outcome === "claimed") expect(claimed.event.activity.externalPeople).toEqual(stored!.activity.externalPeople);
  expect(await consumeEffectBodies(queueEnv, [reference])).toEqual({ acked: 1, retried: 0 });
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
  // The immutable payload is retained for replay, and corruption cannot be admitted.
  const key = `global/connector-queue/${WORKSPACE}/${reference.sha256}.json`;
  await env.PAYLOADS.put(key, '{}');
  await expect(readConnectorQueuePayload(queueEnv, reference)).rejects.toThrow("connector_queue_payload_hash_mismatch");
  await env.PAYLOADS.delete(key);
  await expect(readConnectorQueuePayload(queueEnv, reference)).rejects.toThrow("connector_queue_payload_missing");
// 10,000 real SQLite writes plus Queue delivery and RPC serialization, not a latency assertion.
}, 60_000);

it("migrates populated v121 people without losing their order and cascades their deletion", async () => {
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
    expect(sql.exec<{ person_json: string }>("SELECT person_json FROM workspace_connector_event_people WHERE event_id = ? ORDER BY position", EVENT)
      .toArray().map((row) => JSON.parse(row.person_json).email)).toEqual(["guest0@example.com", "guest1@example.com"]);
    expect(sql.exec("SELECT external_people_json FROM workspace_connector_events WHERE event_id = ?", EVENT).one()).toEqual({ external_people_json: "[]" });
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
