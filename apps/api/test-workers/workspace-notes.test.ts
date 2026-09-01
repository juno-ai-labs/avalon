/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The notes domain's decisions, against the object that owns the tables.
 *
 * Appending a segment was five facade statements — fence, duplicate check,
 * sequence allocation, insert, recorded-time bump — whose races the service
 * papered over with a compensating re-read. Archiving classified its refusal
 * from a read one round trip after the write it explains. And a note going
 * private relied on a D1 trigger that never travelled to the object, so the
 * privacy outbox row it owes the notifier was written nowhere. Each of those
 * is one transaction here, and these tests assert the outcomes the object
 * decides.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId, type WorkstreamBatchFilter } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import { WorkspaceBatchNoteArchiveResultSchema } from "../src/durable-objects/workspace-directory-protocol";
import {
  WorkspaceNoteArchiveResultSchema,
  WorkspaceNoteDeletionOutboxSchema,
  WorkspaceNoteDeletionRetireResultSchema,
  WorkspaceNoteGenerationCommitResultSchema,
  WorkspaceNotePrivacyMarkResultSchema,
  WorkspaceNotePrivacyPendingResultSchema,
  WorkspaceNoteSegmentAppendResultSchema,
  WorkspaceNoteSidebarListSchema,
  WorkspaceNoteStateSchema,
  WorkspaceNoteUpdateResultSchema,
  WorkspaceNoteVisibilityResultSchema,
  type WorkspaceNoteAccess,
} from "../src/durable-objects/workspace-notes-protocol";

/** Its own workspace: a shared id makes this file queue behind its siblings. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000da0");
const OWNER = asUserId("00000000-0000-7000-8000-000000000ca1");
const OTHER_MEMBER = asUserId("00000000-0000-7000-8000-000000000ca2");
const NOTE = "00000000-0000-7000-8000-000000000cb0";
const RESOURCE = "00000000-0000-7000-8000-000000000cb1";
// Deliberately in the future: an outbox row's `created_at` is also the
// instant its maintenance pass comes due, and a real object keeps running
// between this file's awaits — a past instant had the alarm draining the
// privacy outbox mid-test.
const AT = "2033-01-01T00:00:00.000Z";
const LATER = "2033-01-01T00:01:00.000Z";

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

let sequence = 0;
function nextId(): string {
  sequence += 1;
  return `00000000-0000-7000-8000-${String(sequence).padStart(12, "0")}`;
}

async function seedNote(overrides: {
  noteId?: string;
  resourceId?: string;
  scope?: "personal" | "workspace";
  title?: string;
  ownerUserId?: string;
  recordingStatus?: "idle" | "recording" | "complete";
  lastActivityAt?: string;
} = {}): Promise<void> {
  const noteId = overrides.noteId ?? NOTE;
  const resourceId = overrides.resourceId ?? RESOURCE;
  const scope = overrides.scope ?? "personal";
  const title = overrides.title ?? "Customer interview";
  const ownerUserId = overrides.ownerUserId ?? OWNER;
  const recordingStatus = overrides.recordingStatus ?? "idle";
  const lastActivityAt = overrides.lastActivityAt ?? AT;
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO resources
         (id, workspace_id, resource_type, provider, provider_resource_id, title,
          mime_type, content_ref, content_sha256, metadata_json, last_hydrated_at,
          uploaded_by_user_id, attachment_status, created_at, updated_at)
       VALUES (?, ?, 'note', 'avalon_note', ?, ?, 'text/markdown; charset=utf-8',
               ?, ?, '{}', ?, ?, 'attached', ?, ?)`,
      resourceId,
      WORKSPACE_ID,
      noteId,
      title,
      `global/${WORKSPACE_ID}/resources/${resourceId}/versions/seed/note.md`,
      "seed-sha",
      AT,
      ownerUserId,
      AT,
      AT,
    );
    state.storage.sql.exec(
      `INSERT INTO notes
         (id, workspace_id, owner_user_id, resource_id, scope, title,
          recording_status, last_activity_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      noteId,
      WORKSPACE_ID,
      ownerUserId,
      resourceId,
      scope,
      title,
      recordingStatus,
      lastActivityAt,
      AT,
      AT,
    );
  });
}

async function noteState(userId: string, access: WorkspaceNoteAccess, noteId = NOTE) {
  return WorkspaceNoteStateSchema.parse(await workspace().noteWithSegments({
    workspaceId: WORKSPACE_ID,
    noteId,
    userId,
    access,
  }));
}

async function appendSegment(input: { clientSegmentId: string; userId?: string; text?: string }) {
  return WorkspaceNoteSegmentAppendResultSchema.parse(await workspace().appendNoteSegment({
    workspaceId: WORKSPACE_ID,
    noteId: NOTE,
    userId: input.userId ?? OWNER,
    segmentId: nextId(),
    clientSegmentId: input.clientSegmentId,
    startOffsetMs: 0,
    endOffsetMs: 1_000,
    capturedAt: AT,
    speakerLabel: null,
    text: input.text ?? "A transcript segment.",
    at: AT,
  }));
}

async function updateNote(input: Record<string, unknown>) {
  return WorkspaceNoteUpdateResultSchema.parse(await workspace().updateNote({
    workspaceId: WORKSPACE_ID,
    noteId: NOTE,
    userId: OWNER,
    at: LATER,
    ...input,
  }));
}

beforeEach(async () => {
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(`DELETE FROM note_transcript_segments`);
    state.storage.sql.exec(`DELETE FROM note_privacy_change_outbox`);
    state.storage.sql.exec(`DELETE FROM note_resource_deletion_outbox`);
    state.storage.sql.exec(`DELETE FROM notes`);
    state.storage.sql.exec(`DELETE FROM resource_versions`);
    state.storage.sql.exec(`DELETE FROM resources`);
    // Deleting the resources rows above enqueues their refs through the
    // generic cleanup trigger; a seeded file must not leave that behind.
    state.storage.sql.exec(`DELETE FROM resource_object_deletion_outbox`);
  });
  sequence = 0;
}, 30_000);

describe("workspace notes", () => {
  it("hands concurrent segment appends consecutive sequence numbers", async () => {
    // The defect the facade round trips allowed: two appends read the same
    // `next_segment_sequence` and the unique constraint refused the second as
    // a 500 mid-recording. Inside the object each append is one critical
    // section, so the numbers are consecutive rather than colliding.
    await seedNote();
    const results = await Promise.all([
      appendSegment({ clientSegmentId: nextId() }),
      appendSegment({ clientSegmentId: nextId() }),
      appendSegment({ clientSegmentId: nextId() }),
    ]);
    expect(results.map((result) => result.outcome)).toEqual(["appended", "appended", "appended"]);
    // A comparator, not the default lexicographic sort: this passes at three
    // appends and would fail at ten on `[1, 10, 2]`, for a reason that has
    // nothing to do with what the test is about.
    expect(results
      .map((result) => result.segment?.sequenceNumber ?? 0)
      .sort((left, right) => left - right)).toEqual([1, 2, 3]);
  });

  it("answers a replayed segment with the stored row instead of a second copy", async () => {
    await seedNote();
    const clientSegmentId = nextId();
    const first = await appendSegment({ clientSegmentId, text: "Original words." });
    const replay = await appendSegment({ clientSegmentId, text: "Retried words." });
    expect(replay.outcome).toBe("duplicate");
    expect(replay.segment).toEqual(first.segment);
    const stored = await runInDurableObject(workspace(), (_instance, state) =>
      state.storage.sql.exec(`SELECT COUNT(*) AS count FROM note_transcript_segments`).one());
    expect(stored).toEqual({ count: 1 });
  });

  it("refuses a segment from somebody who does not own the note", async () => {
    await seedNote({ scope: "workspace" });
    expect((await appendSegment({ clientSegmentId: nextId(), userId: OTHER_MEMBER })).outcome)
      .toBe("note_not_found");
  });

  it("tells a recording note apart from one the caller may not archive", async () => {
    await seedNote();
    const archive = (userId: string) => workspace().archiveNote({
      workspaceId: WORKSPACE_ID,
      noteId: NOTE,
      userId,
      at: LATER,
    }).then((result) => WorkspaceNoteArchiveResultSchema.parse(result));

    expect(await archive(OTHER_MEMBER)).toEqual({ outcome: "not_found" });
    await updateNote({ recordingStatus: "recording" });
    expect(await archive(OWNER)).toEqual({ outcome: "recording" });
    expect((await noteState(OWNER, "view")).note?.archivedAt).toBeNull();
    await updateNote({ recordingStatus: "complete" });
    expect(await archive(OWNER)).toEqual({ outcome: "archived" });
    expect(await archive(OWNER)).toEqual({ outcome: "not_found" });
  });

  it("records a workspace-to-personal transition with the scope change, once", async () => {
    await seedNote({ scope: "workspace", title: "Shared research" });
    const update = await updateNote({ scope: "personal" });
    expect(update).toEqual({ outcome: "updated", becamePrivate: true });

    const pending = WorkspaceNotePrivacyPendingResultSchema.parse(
      await workspace().pendingNotePrivacyTransitions({ workspaceId: WORKSPACE_ID }),
    );
    expect(pending.items).toHaveLength(1);
    expect(pending.items[0]).toMatchObject({
      noteId: NOTE,
      resourceId: RESOURCE,
      noteTitle: "Shared research",
      actorUserId: OWNER,
    });

    // Already personal: the same request again is an update, not a transition.
    expect(await updateNote({ scope: "personal" })).toEqual({ outcome: "updated", becamePrivate: false });
    expect(WorkspaceNotePrivacyPendingResultSchema.parse(
      await workspace().pendingNotePrivacyTransitions({ workspaceId: WORKSPACE_ID }),
    ).items).toHaveLength(1);

    const mark = (transitionId: string) => workspace().markNotePrivacyTransitionProcessed({
      workspaceId: WORKSPACE_ID,
      transitionId,
      at: LATER,
    }).then((result) => WorkspaceNotePrivacyMarkResultSchema.parse(result));
    expect(await mark(pending.items[0]!.id)).toEqual({ outcome: "processed" });
    expect(await mark(pending.items[0]!.id)).toEqual({ outcome: "not_pending" });
    expect(WorkspaceNotePrivacyPendingResultSchema.parse(
      await workspace().pendingNotePrivacyTransitions({ workspaceId: WORKSPACE_ID }),
    ).items).toEqual([]);
  });

  it("refuses a stale generation instead of rewinding the cursor", async () => {
    await seedNote();
    const commit = (notes: string, expectedGeneratedAt: string | null) =>
      workspace().commitNoteGeneration({
        workspaceId: WORKSPACE_ID,
        noteId: NOTE,
        userId: OWNER,
        liveNotesMarkdown: notes,
        throughSequence: 1,
        generatedAt: LATER,
        expectedThroughSequence: 0,
        expectedGeneratedAt,
      }).then((result) => WorkspaceNoteGenerationCommitResultSchema.parse(result));

    expect(await commit("First briefing", null)).toEqual({ outcome: "committed" });
    // A second window that read the note before the first commit now carries
    // a stale cursor pair; its result is discarded rather than landed.
    expect(await commit("Stale briefing", null)).toEqual({ outcome: "stale" });
    const note = (await noteState(OWNER, "view")).note;
    expect(note?.liveNotesMarkdown).toBe("First briefing");
    expect(note?.notesThroughSequence).toBe(1);
  });

  it("keeps another member's personal note opaque while sharing workspace notes", async () => {
    await seedNote({ scope: "personal" });
    expect((await noteState(OTHER_MEMBER, "view")).note).toBeNull();
    expect((await noteState(OTHER_MEMBER, "any")).note).not.toBeNull();
    expect((await noteState(OWNER, "view")).note).not.toBeNull();

    const sharedNote = nextId();
    await seedNote({ noteId: sharedNote, resourceId: nextId(), scope: "workspace" });
    expect((await noteState(OTHER_MEMBER, "view", sharedNote)).note).not.toBeNull();
    // Readable is not editable: the owner fence stays the owner's.
    expect((await noteState(OTHER_MEMBER, "edit", sharedNote)).note).toBeNull();

    const sidebar = (userId: string) => workspace().listNoteSidebar({
      workspaceId: WORKSPACE_ID,
      userId,
      limit: 250,
    }).then((result) => WorkspaceNoteSidebarListSchema.parse(result));
    expect((await sidebar(OWNER)).items.map((item) => item.id).sort()).toEqual([NOTE, sharedNote].sort());
    expect((await sidebar(OTHER_MEMBER)).items.map((item) => item.id)).toEqual([sharedNote]);
  });

  it("answers a visibility check wider than one statement's bound parameters", async () => {
    // The engine refuses a statement with more than 100 bound parameters, and
    // the revoked-import security fence forwards every imported note id in one
    // call. An unchunked IN list turns that call into a thrown SQLITE_ERROR —
    // the fence fails instead of evaluating.
    await seedNote({ scope: "workspace" });
    const resourceIds = [RESOURCE, ...Array.from({ length: 149 }, () => nextId())];
    const visible = WorkspaceNoteVisibilityResultSchema.parse(
      await workspace().visibleNoteResourceIds({
        workspaceId: WORKSPACE_ID,
        userId: OTHER_MEMBER,
        resourceIds,
      }),
    );
    expect(visible.resourceIds).toEqual([RESOURCE]);
  });

  it("answers a bare existence check without shipping the transcript", async () => {
    // The idempotent create endpoint asks only "does this id exist here" and
    // then re-reads under the view guard; carrying the whole transcript on the
    // existence answer doubles the payload of every existing-note open.
    await seedNote();
    await appendSegment({ clientSegmentId: nextId() });
    expect((await noteState(OWNER, "any")).segments).toEqual([]);
    expect((await noteState(OWNER, "view")).segments).toHaveLength(1);
  });

  it("retires a deletion-outbox entry exactly once", async () => {
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO note_resource_deletion_outbox
           (resource_id, content_ref, model_content_ref, created_at)
         VALUES (?, 'refs/note.md', 'refs/note-model.md', ?)`,
        RESOURCE,
        AT,
      );
    });
    const listed = WorkspaceNoteDeletionOutboxSchema.parse(
      await workspace().noteResourceDeletionOutbox({ workspaceId: WORKSPACE_ID }),
    );
    expect(listed.items).toEqual([{
      resourceId: RESOURCE,
      contentRef: "refs/note.md",
      modelContentRef: "refs/note-model.md",
    }]);
    const retire = () => workspace().retireNoteResourceDeletion({
      workspaceId: WORKSPACE_ID,
      resourceId: RESOURCE,
    }).then((result) => WorkspaceNoteDeletionRetireResultSchema.parse(result));
    expect(await retire()).toEqual({ outcome: "retired" });
    expect(await retire()).toEqual({ outcome: "not_found" });
  });

  it("refuses a request addressed to a different workspace", async () => {
    // Settled once, by hand: an RPC promise is a pipelining thenable, and
    // `rejects.toThrow` reads through it a second time, which surfaces the
    // same rejection again as an unhandled error and fails the run.
    const outcome = await workspace().noteWithSegments({
      workspaceId: asWorkspaceId("00000000-0000-7000-8000-000000000dae"),
      noteId: NOTE,
      userId: OWNER,
      access: "view",
    }).then(() => null, (error: unknown) => error);
    expect(String(outcome)).toContain("workspace_object_identity_mismatch");
  });

  describe("the visibility fence", () => {
    // The only converted method reached from outside the notes service:
    // `hasRevokedImportedResource` asks it whether a sandbox may still read a
    // note it imported. A `false` there means a running sandbox keeps reading a
    // note that was just made private, so each arm of the predicate is asserted
    // rather than described.
    const PERSONAL_RESOURCE = "00000000-0000-7000-8000-000000000cb1";
    const SHARED_RESOURCE = "00000000-0000-7000-8000-000000000cb2";
    const ARCHIVED_RESOURCE = "00000000-0000-7000-8000-000000000cb3";

    async function visible(userId: string | null, resourceIds: string[]) {
      return WorkspaceNoteVisibilityResultSchema.parse(
        await workspace().visibleNoteResourceIds({
          workspaceId: WORKSPACE_ID,
          userId,
          resourceIds,
        }),
      ).resourceIds.sort();
    }

    beforeEach(async () => {
      await seedNote({
        noteId: "00000000-0000-7000-8000-000000000cc1",
        resourceId: PERSONAL_RESOURCE,
        scope: "personal",
      });
      await seedNote({
        noteId: "00000000-0000-7000-8000-000000000cc2",
        resourceId: SHARED_RESOURCE,
        scope: "workspace",
      });
      await seedNote({
        noteId: "00000000-0000-7000-8000-000000000cc3",
        resourceId: ARCHIVED_RESOURCE,
        scope: "workspace",
      });
      await runInDurableObject(workspace(), (_instance, state) => {
        state.storage.sql.exec(
          `UPDATE notes SET archived_at = ? WHERE id = ?`,
          AT,
          "00000000-0000-7000-8000-000000000cc3",
        );
      });
    });

    it("shows an owner their own personal note and the workspace's", async () => {
      expect(await visible(OWNER, [PERSONAL_RESOURCE, SHARED_RESOURCE]))
        .toEqual([PERSONAL_RESOURCE, SHARED_RESOURCE].sort());
    });

    it("hides another member's personal note", async () => {
      expect(await visible(OTHER_MEMBER, [PERSONAL_RESOURCE, SHARED_RESOURCE]))
        .toEqual([SHARED_RESOURCE]);
    });

    it("shows a non-user principal only workspace-scoped notes", async () => {
      // The null arm is behaviour this conversion states rather than inherits.
      // What this pins is that a non-user principal sees no personal note: the
      // comparison against a null parameter yields null, not a match. It does
      // not pin a change from `=` to `IS`, and cannot — `notes.owner_user_id`
      // is `NOT NULL`, so `owner_user_id IS NULL` matches no row either way.
      expect(await visible(null, [PERSONAL_RESOURCE, SHARED_RESOURCE]))
        .toEqual([SHARED_RESOURCE]);
    });

    it("drops an archived note for everyone", async () => {
      expect(await visible(OWNER, [ARCHIVED_RESOURCE])).toEqual([]);
      expect(await visible(null, [ARCHIVED_RESOURCE])).toEqual([]);
    });
  });
  describe("archiving a whole sidebar grouping", () => {
    // A recency heading holds work streams and notes together, so **Archive
    // all** under it has to reach both. The work-stream half leaves as one
    // Queue event per object; the notes are rows in this database and go here,
    // in one transaction, fenced by the same operation.
    const GROUP = {
      atOrAfter: "2033-06-01T00:00:00.000Z",
      before: "2033-07-01T00:00:00.000Z",
    } as const;
    const IN_RANGE = "2033-06-15T12:00:00.000Z";
    const filter = {
      lastActivityAt: GROUP,
      pinned: false,
      includeSystem: false,
    } as const;

    /** The dispatch row the note archive is fenced by, as the Worker opens it. */
    async function freeze(operationId: string, requestHash: string): Promise<void> {
      await workspace().beginWorkstreamBatchDispatch({
        workspaceId: WORKSPACE_ID,
        userId: OWNER,
        operationId,
        requestHash,
        filter,
      });
    }

    async function archive(input: {
      operationId: string;
      requestHash: string;
      userId?: string;
      filter?: WorkstreamBatchFilter;
    }) {
      return WorkspaceBatchNoteArchiveResultSchema.parse(await workspace().archiveNotesForBatch({
        workspaceId: WORKSPACE_ID,
        userId: input.userId ?? OWNER,
        operationId: input.operationId,
        requestHash: input.requestHash,
        filter: input.filter ?? filter,
        at: LATER,
      }));
    }

    async function archivedTitles(): Promise<string[]> {
      return runInDurableObject(workspace(), (_instance, state) =>
        state.storage.sql.exec<{ title: string }>(
          `SELECT title FROM notes WHERE archived_at IS NOT NULL ORDER BY title`,
        ).toArray().map((row) => row.title));
    }

    /** One note per thing the selection has to decide, all under one heading. */
    async function seedTheGrouping(): Promise<void> {
      await seedNote({
        noteId: nextId(), resourceId: nextId(), title: "In the group", lastActivityAt: IN_RANGE,
      });
      await seedNote({
        noteId: nextId(),
        resourceId: nextId(),
        title: "Shared, and mine",
        scope: "workspace",
        lastActivityAt: IN_RANGE,
      });
      await seedNote({
        noteId: nextId(),
        resourceId: nextId(),
        title: "An older heading",
        lastActivityAt: "2033-05-31T23:59:59.999Z",
      });
      await seedNote({
        noteId: nextId(),
        resourceId: nextId(),
        title: "A newer heading",
        lastActivityAt: GROUP.before,
      });
      await seedNote({
        noteId: nextId(),
        resourceId: nextId(),
        title: "Somebody else's, shared with me",
        scope: "workspace",
        ownerUserId: OTHER_MEMBER,
        lastActivityAt: IN_RANGE,
      });
      await seedNote({
        noteId: nextId(),
        resourceId: nextId(),
        title: "Still recording",
        recordingStatus: "recording",
        lastActivityAt: IN_RANGE,
      });
    }

    it("takes the reader's own idle notes in the range, and nothing else", async () => {
      await seedTheGrouping();
      const operationId = "00000000-0000-7000-8000-000000000e01";
      const requestHash = "fnv1a64:aaaaaaaaaaaaaaaa";
      await freeze(operationId, requestHash);

      await expect(archive({ operationId, requestHash }))
        .resolves.toEqual({ archivedNoteCount: 2, replayed: false });

      // The half-open range at both ends, the owner fence a single archive
      // enforces, and the recording refusal that exists because archiving under
      // a live meeting window 404s the next segment save.
      expect(await archivedTitles()).toEqual(["In the group", "Shared, and mine"]);
    });

    it("counts for the confirmation exactly what the archive will take", async () => {
      // The number the dialog shows and the number that goes are the same
      // selection, or the reader is agreeing to something else.
      await seedTheGrouping();
      const targets = await workspace().batchUpdateTargets({
        workspaceId: WORKSPACE_ID,
        userId: OWNER,
        filter,
      });

      expect(targets.noteIds).toHaveLength(2);

      const operationId = "00000000-0000-7000-8000-000000000e02";
      const requestHash = "fnv1a64:bbbbbbbbbbbbbbbb";
      await freeze(operationId, requestHash);
      await expect(archive({ operationId, requestHash }))
        .resolves.toEqual({ archivedNoteCount: 2, replayed: false });
    });

    it("answers a retried operation with its receipt instead of widening", async () => {
      // The retry exists for the work streams' Queue chunks, and it reaches
      // here again on the way. "Last hour" has no upper bound, so re-selecting
      // would take whatever arrived while the operator was retrying.
      await seedNote({
        noteId: nextId(), resourceId: nextId(), title: "First pass", lastActivityAt: IN_RANGE,
      });
      const operationId = "00000000-0000-7000-8000-000000000e03";
      const requestHash = "fnv1a64:cccccccccccccccc";
      await freeze(operationId, requestHash);
      await expect(archive({ operationId, requestHash }))
        .resolves.toEqual({ archivedNoteCount: 1, replayed: false });

      await seedNote({
        noteId: nextId(),
        resourceId: nextId(),
        title: "Arrived during the retry",
        lastActivityAt: IN_RANGE,
      });
      await expect(archive({ operationId, requestHash }))
        .resolves.toEqual({ archivedNoteCount: 1, replayed: true });

      expect(await archivedTitles()).toEqual(["First pass"]);
    });

    it("refuses an operation id reused with another filter or another person", async () => {
      await seedNote({
        noteId: nextId(), resourceId: nextId(), title: "Not yours", lastActivityAt: IN_RANGE,
      });
      const operationId = "00000000-0000-7000-8000-000000000e04";
      const requestHash = "fnv1a64:dddddddddddddddd";
      await freeze(operationId, requestHash);

      // The request hash covers the filter and the update, so a different
      // selection under this operation id arrives as a different hash.
      await expect(archive({ operationId, requestHash: "fnv1a64:eeeeeeeeeeeeeeee" }))
        .rejects.toThrow(/workstream_batch_dispatch_conflict/u);
      await expect(archive({ operationId, requestHash, userId: OTHER_MEMBER }))
        .rejects.toThrow(/workstream_batch_dispatch_conflict/u);
      expect(await archivedTitles()).toEqual([]);
    });

    it("has nothing to archive for a filter that asks only for pinned rows", async () => {
      // A note cannot be pinned, so this asks for none — and must not answer
      // by ignoring the field and taking every note in the range.
      await seedNote({
        noteId: nextId(), resourceId: nextId(), title: "Unpinnable", lastActivityAt: IN_RANGE,
      });
      const operationId = "00000000-0000-7000-8000-000000000e05";
      const requestHash = "fnv1a64:ffffffffffffffff";
      const pinnedOnly = { ...filter, pinned: true } as const;
      await workspace().beginWorkstreamBatchDispatch({
        workspaceId: WORKSPACE_ID,
        userId: OWNER,
        operationId,
        requestHash,
        filter: pinnedOnly,
      });

      await expect(archive({ operationId, requestHash, filter: pinnedOnly }))
        .resolves.toEqual({ archivedNoteCount: 0, replayed: false });
      expect(await archivedTitles()).toEqual([]);
    });
  });
});
