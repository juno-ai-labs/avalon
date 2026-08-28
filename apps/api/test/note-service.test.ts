import { asUserId, asWorkspaceId } from "@rally/contracts";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GenerateMeetingNotesRequest } from "@rally/contracts";
import type { AuthContext, Env } from "../src/env";
import { AutomationService } from "../src/services/automation-service";
import { processPendingNotePrivacyNotifications } from "../src/services/note-privacy-notification-service";
import { NoteService } from "../src/services/note-service";
import { reapDeletedNoteObjects } from "../src/services/note-resource-cleanup";
import { ResourceService } from "../src/services/resource-service";
import { createCloudflareTestBinding, createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";
import {
  openWorkstreamAuthorityForTest,
  seedWorkstreamObjectRoot,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
  workstreamObjectAll,
  workstreamObjectGet,
  workstreamObjectParticipantRows,
  workstreamObjectRootRow,
} from "./helpers/durable-authority";
import { legacyProductSqliteDatabase } from "./helpers/sqlite-d1";

const userId = asUserId("00000000-0000-4000-8000-000000000201");
const otherUserId = asUserId("00000000-0000-4000-8000-000000000202");
const workspaceId = asWorkspaceId("00000000-0000-4000-8000-000000000203");
const noteId = "00000000-0000-4000-8000-000000000204";

class SqliteD1Statement {
  private values: unknown[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): SqliteD1Statement {
    this.values = values;
    return this;
  }

  async run<T>(): Promise<D1Result<T>> {
    const result = this.statement.run(...this.values as SQLInputValue[]);
    return createTestD1Result<T>({ success: true, results: [], meta: { changes: Number(result.changes) } });
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values as SQLInputValue[]) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return createTestD1Result<T>({
      success: true,
      results: this.statement.all(...this.values as SQLInputValue[]) as T[],
      meta: { changes: 0 },
    });
  }
}

function sqliteD1(database: DatabaseSync): D1Database {
  return createTestD1Database({
    prepare: (sql: string) => createTestD1PreparedStatement(new SqliteD1Statement(database.prepare(sql))),
    batch: async (statements: D1PreparedStatement[]) => {
      const results: D1Result<unknown>[] = [];
      database.exec("BEGIN");
      try {
        for (const statement of statements) {
          results.push(await (statement as unknown as SqliteD1Statement).run());
        }
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  });
}

class MemoryBucket {
  readonly objects = new Map<string, string>();
  failNextDelete = false;

  async put(key: string, value: string): Promise<void> {
    this.objects.set(key, value);
  }

  async delete(key: string): Promise<void> {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error("temporary R2 outage");
    }
    this.objects.delete(key);
  }
}

const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function fixture(options: { openAuthority?: boolean } = {}): {
  auth: AuthContext;
  bucket: MemoryBucket;
  database: DatabaseSync;
  objectStores: Map<string, DatabaseSync>;
  env: Env;
} {
  const database = legacyProductSqliteDatabase();
  openDatabases.push(database);
  // Resource visibility and note privacy notification branch on the open
  // Durable-Object authority, so the fixture opens it the way a production
  // stack runs. A test of the pre-cutover D1 arms opts out.
  if (options.openAuthority !== false) openWorkstreamAuthorityForTest(database);
  database.exec(`
    INSERT INTO users
      (id, google_subject, email, name, created_at, updated_at)
    VALUES
      ('${userId}', 'google-note-owner', 'owner@example.com', 'Note Owner', '2026-01-01', '2026-01-01'),
      ('${otherUserId}', 'google-note-other', 'other@example.com', 'Other Member', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces
      (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${workspaceId}', 'Notes', 'notes', 'global', '${userId}', '2026-01-01', '2026-01-01');
  `);
  const bucket = new MemoryBucket();
  const objectStores = new Map<string, DatabaseSync>();
  return {
    database,
    bucket,
    objectStores,
    env: createTestEnv({
      DB: sqliteD1(database),
      PAYLOADS: createCloudflareTestBinding<R2Bucket>(bucket),
      AVALON_REGION: "global",
      ...(options.openAuthority === false ? {} : {
      SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
      // The privacy notifier asks the WorkspaceDO directory which work
      // streams hold the resource; the stub answers from the per-workstream
      // object links plus the regional directory row, the same two sources
      // the production directory is projected from.
      WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
        extra: {
          resourceAccess: async (input: { workspaceId: string; resourceId: string; userId: string }) => ({
            items: [...objectStores.entries()].flatMap(([linkedWorkstreamId, store]) => {
              const linked = store.prepare(
                "SELECT 1 FROM workstream_resource_links WHERE resource_id = ?",
              ).get(input.resourceId);
              if (!linked) return [];
              const workstream = database.prepare(
                `SELECT workstream.created_by_user_id, workstream.automation_subscription_id,
                        COALESCE(subscription.scope, 'personal') AS scope
                   FROM workstreams workstream
                   LEFT JOIN automation_subscriptions subscription
                     ON subscription.id = workstream.automation_subscription_id
                  WHERE workstream.id = ? AND workstream.workspace_id = ?
                    AND workstream.archived_at IS NULL`,
              ).get(linkedWorkstreamId, input.workspaceId) as {
                created_by_user_id: string | null;
                automation_subscription_id: string | null;
                scope: "personal" | "workspace";
              } | undefined;
              if (!workstream) return [];
              return [{
                workstreamId: linkedWorkstreamId,
                scope: workstream.scope,
                createdByUserId: workstream.created_by_user_id,
                automationSubscriptionId: workstream.automation_subscription_id,
                isParticipant: false,
              }];
            }),
          }),
        },
      }),
      }),
    }),
    auth: {
      sessionId: "note-session",
      userId,
      workspaceId,
      region: "global",
      role: "owner",
    },
  };
}

describe("NoteService", () => {
  it("stores editable notes and timestamped transcript segments without creating a work stream", async () => {
    const { auth, bucket, database, env } = fixture();
    const service = new NoteService(env, auth);
    const created = await service.create({ id: noteId, title: "Customer interview", scope: "personal" });

    expect(created).toMatchObject({
      id: noteId,
      title: "Customer interview",
      manualNotes: "",
      segments: [],
      recordingStatus: "idle",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstreams").get()).toEqual({ count: 0 });

    await service.update(noteId, { manualNotes: "Customer wants a faster import flow." });
    const first = await service.appendSegment(noteId, {
      clientSegmentId: "00000000-0000-4000-8000-000000000205",
      startOffsetMs: 1_250,
      endOffsetMs: 4_750,
      capturedAt: "2026-08-07T18:00:04.750Z",
      speakerLabel: null,
      text: "The current import takes too many steps.",
    });
    const repeated = await service.appendSegment(noteId, {
      clientSegmentId: "00000000-0000-4000-8000-000000000205",
      startOffsetMs: 1_250,
      endOffsetMs: 4_750,
      capturedAt: "2026-08-07T18:00:04.750Z",
      speakerLabel: null,
      text: "The current import takes too many steps.",
    });
    const second = await service.appendSegment(noteId, {
      clientSegmentId: "00000000-0000-4000-8000-000000000206",
      startOffsetMs: 5_000,
      endOffsetMs: 8_500,
      capturedAt: "2026-08-07T18:00:08.500Z",
      speakerLabel: "Customer",
      text: "I want to bring everything over at once.",
    });

    expect(first).toMatchObject({ sequenceNumber: 1, startOffsetMs: 1_250, endOffsetMs: 4_750 });
    expect(repeated).toEqual(first);
    expect(second).toMatchObject({ sequenceNumber: 2, speakerLabel: "Customer" });
    const stored = await service.get(noteId);
    expect(stored.manualNotes).toBe("Customer wants a faster import flow.");
    expect(stored.segments.map((segment) => [segment.sequenceNumber, segment.startOffsetMs, segment.endOffsetMs, segment.text])).toEqual([
      [1, 1_250, 4_750, "The current import takes too many steps."],
      [2, 5_000, 8_500, "I want to bring everything over at once."],
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM note_transcript_segments WHERE note_id = ?").get(noteId))
      .toEqual({ count: 2 });

    const resource = database.prepare(
      "SELECT content_ref, model_content_ref FROM resources WHERE id = ?",
    ).get(created.resourceId) as { content_ref: string; model_content_ref: string };
    const humanDocument = bucket.objects.get(resource.content_ref);
    const modelDocument = bucket.objects.get(resource.model_content_ref);
    expect(humanDocument).toContain("Customer wants a faster import flow.");
    expect(humanDocument).toContain("The current import takes too many steps.");
    expect(humanDocument).not.toContain("00:00:01");
    expect(modelDocument).toContain("[00:00:01–00:00:04]");
    expect(modelDocument).toContain("[00:00:05–00:00:08] Customer:");
  });

  it("keeps private notes creator-only and makes public notes workspace-visible", async () => {
    const { auth, env } = fixture();
    const ownerService = new NoteService(env, auth);
    const created = await ownerService.create({ id: noteId, title: "Private notes", scope: "personal" });
    const otherAuth = { ...auth, userId: otherUserId, role: "member" as const };

    await expect(new NoteService(env, otherAuth).get(noteId)).rejects.toMatchObject({ status: 404, code: "note_not_found" });
    await expect(new NoteService(env, otherAuth).create({
      id: noteId,
      title: "Guessed private note",
      scope: "workspace",
    })).rejects.toMatchObject({ status: 404, code: "note_not_found" });
    await expect(new ResourceService(env, otherAuth).get(created.resourceId)).rejects.toMatchObject({ status: 404, code: "resource_not_found" });

    await ownerService.update(noteId, { scope: "workspace" });
    const otherService = new NoteService(env, otherAuth);
    await expect(otherService.get(noteId)).resolves.toMatchObject({ id: noteId, scope: "workspace" });
    await expect(otherService.create({
      id: noteId,
      title: "Ignored idempotent title",
      scope: "personal",
    })).resolves.toMatchObject({ id: noteId, title: "Private notes", scope: "workspace" });
    await expect(otherService.update(noteId, { manualNotes: "Unauthorized edit" }))
      .rejects.toMatchObject({ status: 404, code: "note_not_found" });
    await expect(otherService.appendSegment(noteId, {
      clientSegmentId: "00000000-0000-4000-8000-000000000207",
      startOffsetMs: 0,
      endOffsetMs: 1_000,
      capturedAt: "2026-08-07T18:00:01.000Z",
      speakerLabel: null,
      text: "Unauthorized transcript",
    })).rejects.toMatchObject({ status: 404, code: "note_not_found" });
    await expect(otherService.generate(noteId, "request-other"))
      .rejects.toMatchObject({ status: 404, code: "note_not_found" });
    await expect(new ResourceService(env, otherAuth).get(created.resourceId)).resolves.toMatchObject({ id: created.resourceId });
  });

  it("injects an authored message only into workstreams that lose access when a note becomes private", async () => {
    const { auth, database, objectStores, env } = fixture();
    const service = new NoteService(env, auth);
    const note = await service.create({ id: noteId, title: "Shared research", scope: "workspace" });
    const templateId = "00000000-0000-4000-8000-000000000220";
    const versionId = "00000000-0000-4000-8000-000000000221";
    const workspaceSubscriptionId = "00000000-0000-4000-8000-000000000222";
    const otherSubscriptionId = "00000000-0000-4000-8000-000000000223";
    const ownerSubscriptionId = "00000000-0000-4000-8000-000000000224";
    const ownerAdHocId = "00000000-0000-4000-8000-000000000225";
    const otherAdHocId = "00000000-0000-4000-8000-000000000226";
    const workspaceAutomationId = "00000000-0000-4000-8000-000000000227";
    const otherAutomationId = "00000000-0000-4000-8000-000000000228";
    const ownerAutomationId = "00000000-0000-4000-8000-000000000229";
    const at = "2026-08-07T18:00:00.000Z";

    database.exec(`
      INSERT INTO automation_templates
        (id, workspace_id, owner_user_id, name, description, sharing_state,
         latest_version_number, created_at, updated_at)
      VALUES
        ('${templateId}', '${workspaceId}', '${userId}', 'Note consumer', '', 'workspace', 1, '${at}', '${at}');
      INSERT INTO automation_template_versions
        (id, template_id, version_number, instructions, trigger_definitions_json,
         created_by_user_id, created_at)
      VALUES
        ('${versionId}', '${templateId}', 1, 'Use the note', '[]', '${userId}', '${at}');
      INSERT INTO automation_subscriptions
        (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
         execution_principal_json, status, created_at, updated_at)
      VALUES
        ('${workspaceSubscriptionId}', '${workspaceId}', '${templateId}', '${versionId}',
         'workspace', NULL, '{"type":"workspace","workspaceId":"${workspaceId}"}', 'active', '${at}', '${at}'),
        ('${otherSubscriptionId}', '${workspaceId}', '${templateId}', '${versionId}',
         'personal', '${otherUserId}', '{"type":"user","userId":"${otherUserId}"}', 'active', '${at}', '${at}'),
        ('${ownerSubscriptionId}', '${workspaceId}', '${templateId}', '${versionId}',
         'personal', '${userId}', '{"type":"user","userId":"${userId}"}', 'active', '${at}', '${at}');
      INSERT INTO workstreams
        (id, workspace_id, title, origin_type, created_by_user_id,
         automation_subscription_id, last_activity_at, created_at, updated_at)
      VALUES
        ('${ownerAdHocId}', '${workspaceId}', 'Owner ad hoc', 'ad_hoc', '${userId}', NULL, '${at}', '${at}', '${at}'),
        ('${otherAdHocId}', '${workspaceId}', 'Other ad hoc', 'ad_hoc', '${otherUserId}', NULL, '${at}', '${at}', '${at}'),
        ('${workspaceAutomationId}', '${workspaceId}', 'Workspace automation', 'automation', '${userId}',
         '${workspaceSubscriptionId}', '${at}', '${at}', '${at}'),
        ('${otherAutomationId}', '${workspaceId}', 'Other automation', 'automation', '${otherUserId}',
         '${otherSubscriptionId}', '${at}', '${at}', '${at}'),
        ('${ownerAutomationId}', '${workspaceId}', 'Owner automation', 'automation', '${userId}',
         '${ownerSubscriptionId}', '${at}', '${at}', '${at}');
    `);
    // Each work stream's attachment link lives in its own object since
    // migration 0090; the fixture opens the five objects and links the note
    // resource there, the way the product attach path stores it.
    const allWorkstreamIds = [
      ownerAdHocId,
      otherAdHocId,
      workspaceAutomationId,
      otherAutomationId,
      ownerAutomationId,
    ];
    for (const attachedWorkstreamId of allWorkstreamIds) {
      const store = testWorkstreamObjectStore();
      openDatabases.push(store);
      seedWorkstreamObjectRoot(store, { workstreamId: attachedWorkstreamId, workspaceId });
      store.prepare(
        `INSERT INTO workstream_resource_links
           (resource_id, attached_by_user_id, watch_enabled, relationship_type, resource_json, attached_at, updated_at)
         VALUES (?, ?, 0, 'context', ?, ?, ?)`,
      ).run(
        note.resourceId,
        userId,
        JSON.stringify({ id: note.resourceId, title: "Shared research", provider: "avalon_note", type: "note" }),
        Date.parse(at),
        Date.parse(at),
      );
      objectStores.set(attachedWorkstreamId, store);
    }
    const objectMessages = () => allWorkstreamIds
      .slice()
      .sort()
      .flatMap((messageWorkstreamId) => workstreamObjectAll(
        objectStores.get(messageWorkstreamId)!,
        `SELECT author_type, author_user_id, message_type, content AS text_content, sequence_number
         FROM canonical_conversation_turn_details`,
      ).map((turn) => ({ workstream_id: messageWorkstreamId, ...turn })) as Array<Record<string, unknown>>);

    await service.update(noteId, { scope: "personal" });

    const messages = objectMessages();
    expect(messages).toEqual([
      {
        workstream_id: otherAdHocId,
        author_type: "system",
        author_user_id: null,
        message_type: "text",
        text_content: "Shared research is now private and no longer accessible",
        sequence_number: 1,
      },
      {
        workstream_id: workspaceAutomationId,
        author_type: "system",
        author_user_id: null,
        message_type: "text",
        text_content: "Shared research is now private and no longer accessible",
        sequence_number: 1,
      },
      {
        workstream_id: otherAutomationId,
        author_type: "system",
        author_user_id: null,
        message_type: "text",
        text_content: "Shared research is now private and no longer accessible",
        sequence_number: 1,
      },
    ]);
    expect(allWorkstreamIds.slice().sort().map((sequencedWorkstreamId) => ({
      id: sequencedWorkstreamId,
      ...workstreamObjectRootRow<Record<string, number>>(
        objectStores.get(sequencedWorkstreamId)!,
        "next_sequence_number, next_attention_ordinal",
      ),
    }))).toEqual([
      // `next_attention_ordinal` is the object's counter; the retired view
      // rendered it one lower, as `latest_attention_sequence_number`.
      { id: ownerAdHocId, next_sequence_number: 1, next_attention_ordinal: 1 },
      { id: otherAdHocId, next_sequence_number: 2, next_attention_ordinal: 2 },
      { id: workspaceAutomationId, next_sequence_number: 2, next_attention_ordinal: 2 },
      { id: otherAutomationId, next_sequence_number: 2, next_attention_ordinal: 2 },
      { id: ownerAutomationId, next_sequence_number: 1, next_attention_ordinal: 1 },
    ]);
    for (const untouchedWorkstreamId of allWorkstreamIds) {
      const store = objectStores.get(untouchedWorkstreamId)!;
      expect(workstreamObjectGet(store, "SELECT COUNT(*) AS count FROM runs")).toEqual({ count: 0 });
      expect(workstreamObjectParticipantRows(store)).toEqual([]);
    }
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM note_privacy_change_outbox WHERE processed_at IS NOT NULL",
    ).get()).toEqual({ count: 1 });

    await processPendingNotePrivacyNotifications(env, { noteId });
    expect(objectMessages()).toHaveLength(3);

    await service.update(noteId, { scope: "workspace" });
    await service.update(noteId, { scope: "personal" });
    expect(objectMessages()).toHaveLength(6);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM note_privacy_change_outbox WHERE processed_at IS NOT NULL",
    ).get()).toEqual({ count: 2 });
  });

  it("keeps generated-note progress monotonic when two windows generate concurrently", async () => {
    const { auth, env } = fixture();
    const invocations: Array<{
      input: GenerateMeetingNotesRequest;
      resolve: (value: { notes: string; generatedAt: string }) => void;
    }> = [];
    const generator = {
      generate: vi.fn((input: GenerateMeetingNotesRequest) =>
        new Promise<{ notes: string; generatedAt: string }>((resolve) => invocations.push({ input, resolve }))),
    };
    const service = new NoteService(env, auth, generator);
    await service.create({ id: noteId, title: "Concurrent notes", scope: "personal" });
    await service.appendSegment(noteId, {
      clientSegmentId: "00000000-0000-4000-8000-000000000211",
      startOffsetMs: 0,
      endOffsetMs: 1_000,
      capturedAt: "2026-08-07T18:00:01.000Z",
      speakerLabel: null,
      text: "First segment",
    });

    const olderGeneration = service.generate(noteId, "request-older");
    await vi.waitFor(() => expect(invocations).toHaveLength(1));
    await service.appendSegment(noteId, {
      clientSegmentId: "00000000-0000-4000-8000-000000000212",
      startOffsetMs: 1_000,
      endOffsetMs: 2_000,
      capturedAt: "2026-08-07T18:00:02.000Z",
      speakerLabel: null,
      text: "Second segment",
    });
    const newerGeneration = service.generate(noteId, "request-newer");
    await vi.waitFor(() => expect(invocations).toHaveLength(2));

    invocations[1]!.resolve({ notes: "Newer summary", generatedAt: "2026-08-07T18:01:00.000Z" });
    await expect(newerGeneration).resolves.toMatchObject({ liveNotes: "Newer summary", notesThroughSequence: 2 });
    invocations[0]!.resolve({ notes: "Stale summary", generatedAt: "2026-08-07T18:00:30.000Z" });
    await expect(olderGeneration).resolves.toMatchObject({ liveNotes: "Newer summary", notesThroughSequence: 2 });
    await expect(service.get(noteId)).resolves.toMatchObject({ liveNotes: "Newer summary", notesThroughSequence: 2 });
  });

  it("retries a final summary that loses a race with a live Control Tower refresh", async () => {
    const { auth, env } = fixture();
    const invocations: Array<{
      input: GenerateMeetingNotesRequest;
      resolve: (value: { notes: string; generatedAt: string }) => void;
    }> = [];
    const service = new NoteService(env, auth, {
      generate: vi.fn((input: GenerateMeetingNotesRequest) =>
        new Promise<{ notes: string; generatedAt: string }>((resolve) => invocations.push({ input, resolve }))),
    });
    await service.create({ id: noteId, title: "Final summary race", scope: "personal" });
    await service.appendSegment(noteId, {
      clientSegmentId: "00000000-0000-4000-8000-000000000232",
      startOffsetMs: 0,
      endOffsetMs: 1_000,
      capturedAt: "2026-08-07T18:00:01.000Z",
      speakerLabel: null,
      text: "The complete meeting transcript.",
    });

    const liveGeneration = service.generate(noteId, "request-live-race", "live", "partial");
    await vi.waitFor(() => expect(invocations).toHaveLength(1));
    const finalGeneration = service.generate(noteId, "request-final-race", "final", "complete");
    await vi.waitFor(() => expect(invocations).toHaveLength(2));

    invocations[0]!.resolve({ notes: "## Right now\n\nLive briefing", generatedAt: "2026-08-07T18:01:00.000Z" });
    await expect(liveGeneration).resolves.toMatchObject({ liveNotes: expect.stringContaining("Live briefing") });
    invocations[1]!.resolve({ notes: "## Action items\n\nOriginal final result", generatedAt: "2026-08-07T18:01:01.000Z" });
    await vi.waitFor(() => expect(invocations).toHaveLength(3));

    expect(invocations[2]!.input).toMatchObject({ mode: "final", transcriptStatus: "complete" });
    expect(invocations[2]!.input.transcript).toContain("The complete meeting transcript.");
    invocations[2]!.resolve({ notes: "## Action items\n\nRetried final summary", generatedAt: "2026-08-07T18:01:02.000Z" });

    await expect(finalGeneration).resolves.toMatchObject({
      liveNotes: "## Action items\n\nRetried final summary",
      notesThroughSequence: 1,
    });
    await expect(service.get(noteId)).resolves.toMatchObject({
      liveNotes: "## Action items\n\nRetried final summary",
      notesThroughSequence: 1,
    });
  });

  it("validates note resources against automation scope and current visibility", async () => {
    const { auth, env } = fixture();
    const noteService = new NoteService(env, auth);
    const note = await noteService.create({ id: noteId, title: "Automation context", scope: "personal" });
    const validate = (service: AutomationService, scope: "personal" | "workspace", resourceIds: string[]) =>
      (service as unknown as {
        validateAutomationResources: (targetScope: "personal" | "workspace", ids: string[]) => Promise<string[]>;
      }).validateAutomationResources(scope, resourceIds);
    const ownerAutomation = new AutomationService(env, auth);

    await expect(validate(ownerAutomation, "personal", [note.resourceId])).resolves.toEqual([note.resourceId]);
    await expect(validate(ownerAutomation, "workspace", [note.resourceId]))
      .rejects.toMatchObject({ status: 422, code: "personal_resource_in_workspace_automation" });

    await noteService.update(noteId, { scope: "workspace" });
    await expect(validate(ownerAutomation, "workspace", [note.resourceId])).resolves.toEqual([note.resourceId]);
    const otherAutomation = new AutomationService(env, { ...auth, userId: otherUserId, role: "member" });
    await expect(validate(otherAutomation, "personal", [note.resourceId])).resolves.toEqual([note.resourceId]);

    await noteService.update(noteId, { scope: "personal" });
    await expect(validate(otherAutomation, "personal", [note.resourceId]))
      .rejects.toMatchObject({ status: 422, code: "invalid_automation_resource" });
  });

  it("bounds model context without silently cutting off either end", async () => {
    const { auth, database, env } = fixture();
    let captured: GenerateMeetingNotesRequest | undefined;
    const service = new NoteService(env, auth, {
      generate: vi.fn(async (input: GenerateMeetingNotesRequest) => {
        captured = input;
        return { notes: "Bounded summary", generatedAt: "2026-08-07T18:01:00.000Z" };
      }),
    });
    await service.create({ id: noteId, title: "Long notes", scope: "personal" });
    const manualNotes = `manual-start\n\n${"m".repeat(30_000)}\n\nmanual-end`;
    const liveNotes = `live-start\n\n${"l".repeat(30_000)}\n\nlive-end`;
    await service.update(noteId, { manualNotes });
    database.prepare("UPDATE notes SET live_notes_markdown = ? WHERE id = ?").run(liveNotes, noteId);
    await service.appendSegment(noteId, {
      clientSegmentId: "00000000-0000-4000-8000-000000000213",
      startOffsetMs: 0,
      endOffsetMs: 1_000,
      capturedAt: "2026-08-07T18:00:01.000Z",
      speakerLabel: "Speaker",
      text: `segment-start-${"x".repeat(79_960)}-segment-end`,
    });

    await service.generate(noteId, "request-bounded");

    expect(captured?.previousNotes.length).toBeLessThanOrEqual(50_000);
    expect(captured?.previousNotes).toContain("live-start");
    expect(captured?.previousNotes).toContain("live-end");
    expect(captured?.userNotes).toBe(manualNotes);
    expect(captured?.mode).toBe("live");
    expect(captured?.transcript.length).toBeLessThanOrEqual(400_000);
    expect(captured?.transcript).toContain("segment-start");
    expect(captured?.transcript).toContain("segment-end");
    expect(captured?.recentTranscript).toContain("segment-start");
    expect(captured?.recentTranscript).toContain("segment-end");
  });

  it("uses full history for live briefings and runs a separate final pass even with no pending segments", async () => {
    const { auth, env } = fixture();
    const inputs: GenerateMeetingNotesRequest[] = [];
    const service = new NoteService(env, auth, {
      generate: vi.fn(async (input: GenerateMeetingNotesRequest) => {
        inputs.push(input);
        return {
          notes: input.mode === "final" ? "## Action items\n\nNo explicit action items captured." : "## Right now\n\nA live briefing.",
          generatedAt: input.mode === "final" ? "2026-08-07T18:31:00.000Z" : "2026-08-07T18:30:00.000Z",
        };
      }),
    });
    await service.create({ id: noteId, title: "Whole meeting", scope: "personal" });
    await service.update(noteId, {
      manualNotes: "User context that should reach both passes.",
      startedAt: "2026-08-07T18:00:00.000Z",
    });
    await service.appendSegment(noteId, {
      clientSegmentId: "00000000-0000-4000-8000-000000000230",
      startOffsetMs: 0,
      endOffsetMs: 1_000,
      capturedAt: "2026-08-07T18:00:01.000Z",
      speakerLabel: "Maya",
      text: "The original launch constraint.",
    });
    await service.appendSegment(noteId, {
      clientSegmentId: "00000000-0000-4000-8000-000000000231",
      startOffsetMs: 11 * 60 * 1_000,
      endOffsetMs: 11 * 60 * 1_000 + 1_000,
      capturedAt: "2026-08-07T18:11:01.000Z",
      speakerLabel: "Leo",
      text: "The current launch question.",
    });

    await service.generate(noteId, "request-live", "live", "partial");
    await service.generate(noteId, "request-final", "final", "complete");

    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({
      mode: "live",
      meetingTitle: "Whole meeting",
      userNotes: "User context that should reach both passes.",
      transcriptStatus: "partial",
    });
    expect(inputs[0]!.transcript).toContain("The original launch constraint");
    expect(inputs[0]!.transcript).toContain("The current launch question");
    expect(inputs[0]!.recentTranscript).not.toContain("The original launch constraint");
    expect(inputs[0]!.recentTranscript).toContain("The current launch question");
    expect(inputs[1]).toMatchObject({
      mode: "final",
      previousNotes: "",
      recentTranscript: "",
      transcriptStatus: "complete",
    });
    expect(inputs[1]!.transcript).toContain("The original launch constraint");
    expect(inputs[1]!.transcript).toContain("The current launch question");
    await expect(service.get(noteId)).resolves.toMatchObject({
      liveNotes: "## Action items\n\nNo explicit action items captured.",
      notesThroughSequence: 2,
    });
  });

  it("archives a note out of every listing without destroying its transcript", async () => {
    const { auth, database, env } = fixture();
    const ownerService = new NoteService(env, auth);
    const created = await ownerService.create({ id: noteId, title: "Finished interview", scope: "workspace" });
    await ownerService.appendSegment(noteId, {
      clientSegmentId: "00000000-0000-4000-8000-000000000215",
      startOffsetMs: 0,
      endOffsetMs: 2_000,
      capturedAt: "2026-08-07T18:00:02.000Z",
      speakerLabel: null,
      text: "Worth keeping after the row leaves the sidebar.",
    });
    const otherAuth = { ...auth, userId: otherUserId, role: "member" as const };

    // A workspace note is readable by every member, but archiving it is the
    // owner's call alone.
    await expect(new NoteService(env, otherAuth).archive(noteId))
      .rejects.toMatchObject({ status: 404, code: "note_not_found" });
    await expect(new NoteService(env, otherAuth).get(noteId)).resolves.toMatchObject({ id: noteId });

    // Archiving underneath a live meeting window would 404 its next segment
    // save while capture kept running, so a recording note refuses distinctly
    // from one the caller may not touch at all.
    await ownerService.update(noteId, { recordingStatus: "recording" });
    await expect(ownerService.archive(noteId))
      .rejects.toMatchObject({ status: 409, code: "note_recording" });
    expect(database.prepare("SELECT archived_at FROM notes WHERE id = ?").get(noteId))
      .toEqual({ archived_at: null });
    await ownerService.update(noteId, { recordingStatus: "complete" });

    await ownerService.archive(noteId);

    await expect(ownerService.list(250)).resolves.toEqual({ items: [] });
    await expect(new NoteService(env, otherAuth).list(250)).resolves.toEqual({ items: [] });
    await expect(ownerService.get(noteId)).rejects.toMatchObject({ status: 404, code: "note_not_found" });
    await expect(ownerService.update(noteId, { title: "Renamed after archiving" }))
      .rejects.toMatchObject({ status: 404, code: "note_not_found" });
    await expect(new ResourceService(env, auth).get(created.resourceId))
      .rejects.toMatchObject({ status: 404, code: "resource_not_found" });
    // Archiving twice is the same answer as archiving something that is gone.
    await expect(ownerService.archive(noteId)).rejects.toMatchObject({ status: 404, code: "note_not_found" });

    expect(database.prepare("SELECT archived_at FROM notes WHERE id = ?").get(noteId))
      .toMatchObject({ archived_at: expect.any(String) });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM note_transcript_segments WHERE note_id = ?",
    ).get(noteId)).toEqual({ count: 1 });
  });

  it("deletes the owned resource row when a note is deleted", async () => {
    // The D1 deletion-outbox trigger this test exercises is confined by 0089
    // to the phases where D1 is still the authority; post-cutover the
    // WorkspaceDO owns note object lifecycle. The pre-open stack is the one
    // place this arm still runs, so the test stays in that regime.
    const { auth, bucket, database, env } = fixture({ openAuthority: false });
    const noteService = new NoteService(env, auth);
    const created = await noteService.create({ id: noteId, title: "Disposable", scope: "personal" });

    database.prepare("DELETE FROM notes WHERE id = ?").run(noteId);

    expect(database.prepare("SELECT id FROM resources WHERE id = ?").get(created.resourceId)).toBeUndefined();
    expect(database.prepare(
      "SELECT resource_id, content_ref, model_content_ref FROM note_resource_deletion_outbox WHERE resource_id = ?",
    ).get(created.resourceId)).toMatchObject({
      resource_id: created.resourceId,
      content_ref: expect.stringContaining("/note.md"),
      model_content_ref: expect.stringContaining("/note-model.md"),
    });
    const foreignKeys = database.prepare("PRAGMA foreign_key_list(automation_resources)").all() as Array<Record<string, unknown>>;
    expect(foreignKeys.find((row) => row.table === "resources")?.on_delete).toBe("CASCADE");

    const secondNoteId = "00000000-0000-4000-8000-000000000214";
    const second = await noteService.create({ id: secondNoteId, title: "Resource-deleted", scope: "personal" });
    database.prepare("DELETE FROM resources WHERE id = ?").run(second.resourceId);
    expect(database.prepare("SELECT id FROM notes WHERE id = ?").get(secondNoteId)).toBeUndefined();
    expect(database.prepare(
      "SELECT resource_id FROM note_resource_deletion_outbox WHERE resource_id = ?",
    ).get(second.resourceId)).toEqual({ resource_id: second.resourceId });

    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    bucket.failNextDelete = true;
    await reapDeletedNoteObjects(env);
    expect(database.prepare("SELECT COUNT(*) AS count FROM note_resource_deletion_outbox").get())
      .toEqual({ count: 1 });
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({
      event: "note_object_cleanup_failed",
      reason: "temporary R2 outage",
    }));

    await reapDeletedNoteObjects(env);
    expect(bucket.objects.size).toBe(0);
    expect(database.prepare(
      "SELECT resource_id FROM note_resource_deletion_outbox WHERE resource_id = ?",
    ).get(created.resourceId)).toBeUndefined();
    warning.mockRestore();
  });
});
