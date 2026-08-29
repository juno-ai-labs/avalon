/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Version capture, on the runtime that actually commits it.
 *
 * The Node suite proves which columns the triggers carry. What only workerd
 * can answer is whether a pointer swap and the version recording the state it
 * superseded are one commit: a swap that landed without its version would
 * destroy the only copy of a draft, and a version written without its swap
 * would name a state the resource never left.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";

/** Its own workspace: every suite here addresses one object by name. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000009e0");
const RESOURCE = "00000000-0000-7000-8000-0000000009a1";
const RUN = "00000000-0000-7000-8000-0000000009a2";

function workspace(): DurableObjectStub {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

interface ResourceState extends Record<string, SqlStorageValue> {
  content_ref: string | null;
  current_version: number;
}

interface CapturedVersion extends Record<string, SqlStorageValue> {
  version: number;
  content_ref: string | null;
  author_kind: string | null;
  author_run_id: string | null;
  cause: string | null;
}

beforeEach(async () => {
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec("DELETE FROM resources");
    state.storage.sql.exec("DELETE FROM resource_object_deletion_outbox");
    state.storage.sql.exec(
      `INSERT OR IGNORE INTO workspace_identity
         (id, workspace_id, region, placement_affinity, created_at, updated_at)
       VALUES (1, ?, 'global', 'wnam', 0, 0)`,
      WORKSPACE_ID,
    );
    state.storage.sql.exec(
      `INSERT INTO resources
         (id, workspace_id, resource_type, provider, provider_resource_id, title, mime_type,
          content_ref, content_sha256, metadata_json, attachment_status, model_content_status,
          created_at, updated_at, revision_author_kind, revision_author_run_id, revision_cause)
       VALUES (?, ?, 'generated_file', 'avalon_generated', 'terminal:plan.md', 'Plan',
               'text/markdown', 'global/original-1', ?, '{}', 'attached', 'pending',
               '2026-08-28T01:00:00.000Z', '2026-08-28T01:00:00.000Z', 'agent', ?, 'created')`,
      RESOURCE,
      WORKSPACE_ID,
      "1".repeat(64),
      RUN,
    );
  });
});

function readState(state: DurableObjectState): ResourceState {
  return state.storage.sql.exec<ResourceState>(
    "SELECT content_ref, current_version FROM resources WHERE id = ?",
    RESOURCE,
  ).toArray()[0]!;
}

function readVersions(state: DurableObjectState): CapturedVersion[] {
  return state.storage.sql.exec<CapturedVersion>(
    `SELECT version, content_ref, author_kind, author_run_id, cause
       FROM resource_versions WHERE resource_id = ? ORDER BY version`,
    RESOURCE,
  ).toArray();
}

/** The republish swap, as the terminal bridge issues it. */
function swap(state: DurableObjectState, objectRef: string, authorColumn = "revision_author_run_id"): void {
  state.storage.sql.exec(
    `UPDATE resources
        SET content_ref = ?, content_sha256 = ?, updated_at = ?,
            revision_author_kind = 'agent', ${authorColumn} = ?, revision_cause = 'published'
      WHERE id = ? AND workspace_id = ?`,
    objectRef,
    "2".repeat(64),
    "2026-08-28T02:00:00.000Z",
    RUN,
    RESOURCE,
    WORKSPACE_ID,
  );
}

describe("resource version capture on real workerd", () => {
  it("commits a pointer swap and the version that records it together", async () => {
    await runInDurableObject(workspace(), (_instance, state) => {
      swap(state, "global/original-2");

      expect(readState(state)).toEqual({ content_ref: "global/original-2", current_version: 2 });
      // The superseded pointer is still named by history — the reason the
      // reaper leaves the prior draft's bytes alone.
      expect(readVersions(state)).toEqual([
        { version: 1, content_ref: "global/original-1", author_kind: "agent", author_run_id: RUN, cause: "created" },
        { version: 2, content_ref: "global/original-2", author_kind: "agent", author_run_id: RUN, cause: "published" },
      ]);
    });
  });

  it("leaves the pointer where it was when capture refuses the swap", async () => {
    await runInDurableObject(workspace(), (_instance, state) => {
      // Capture failing is the only way the two can come apart, so it is how
      // the crash between them is injected: the version row is written by a
      // trigger inside the swap's own statement, and this one aborts.
      expect(() => swap(state, "global/original-2", "revision_author_user_id"))
        .toThrow(/resource_version_provenance_mismatch/u);

      expect(readState(state)).toEqual({ content_ref: "global/original-1", current_version: 1 });
      expect(readVersions(state).map((row) => row.version)).toEqual([1]);
    });
  });

  it("keeps the swap and its capture together when the transaction around them fails", async () => {
    await runInDurableObject(workspace(), (_instance, state) => {
      expect(() => state.storage.transactionSync(() => {
        swap(state, "global/original-2");
        // Whatever fails after the swap — a caller's own guard, a later
        // statement in the same transition — takes the version row with it.
        throw new Error("injected_crash");
      })).toThrow(/injected_crash/u);

      expect(readState(state)).toEqual({ content_ref: "global/original-1", current_version: 1 });
      expect(readVersions(state).map((row) => row.version)).toEqual([1]);
    });
  });
});
