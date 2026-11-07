/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";

/** Its own workspace, for the reason `workspace-directory-reads` states. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000008c0");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-0000000008a1");
const USER_ID = asUserId("00000000-0000-7000-8000-0000000008a2");
const INPUT_ID = "00000000-0000-7000-8000-0000000008a3";
const RESOURCE_ID = "00000000-0000-7000-8000-0000000008a4";

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

/**
 * The seeded draft's age, minted against real time on purpose.
 *
 * `reapExpiredDraftResources` deletes an unattached `avalon_upload` draft once
 * `created_at` is more than `DRAFT_ATTACHMENT_TTL_HOURS` (24) old, and the
 * workspace alarm runs that pass in the background of these tests. This
 * fixture used a fixed `2026-08-28T12:00:00.000Z`, which was inside the window
 * when it was written and silently left it: from 12:00 UTC on the 29th the
 * seeded row was reapable, and the release test — which ends with no
 * reservation holding the row and its status back at `draft`, the exact shape
 * the reap looks for — lost it between the release and the assertion. It began
 * failing on every branch at once, by the clock rather than by a commit.
 *
 * Minting it now keeps the row inside the TTL however long this suite lives,
 * which is what `docs/testing.md` means about ordering fixture timestamps
 * against real time rather than against a literal.
 */
function seededAt(): string {
  return new Date().toISOString();
}

beforeEach(async () => {
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  const seeded = seededAt();
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec("DELETE FROM pending_attachment_reservations");
    state.storage.sql.exec("DELETE FROM workspace_workstream_resource_links");
    state.storage.sql.exec("DELETE FROM channels");
    state.storage.sql.exec("DELETE FROM resources");
    state.storage.sql.exec(
      `INSERT INTO resources
         (id, workspace_id, resource_type, provider, title, mime_type, content_ref,
          metadata_json, uploaded_by_user_id, attachment_status, created_at, updated_at)
       VALUES (?, ?, 'document', 'avalon_upload', 'pending.txt', 'text/plain',
               'global/test/pending', '{"size":7}', ?, 'draft', ?, ?)`,
      RESOURCE_ID,
      WORKSPACE_ID,
      USER_ID,
      seeded,
      seeded,
    );
  });
});

describe("WorkspaceDO pending attachment reservations", () => {
  it("rejects 100 unavailable drafts without exceeding the SQLite bind limit", async () => {
    const resourceIds = Array.from({ length: 100 }, (_, index) => (
      `00000000-0000-7000-8000-${String(920_000 + index).padStart(12, "0")}`
    ));

    await expect(workspace().reserveDraftAttachments({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      inputId: INPUT_ID,
      userId: USER_ID,
      resourceIds,
    })).resolves.toEqual({ outcome: "unavailable" });
  });

  it("releases failed preparation holds idempotently without deleting history", async () => {
    await workspace().reserveDraftAttachments({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      inputId: INPUT_ID,
      userId: USER_ID,
      resourceIds: [RESOURCE_ID],
    });
    await expect(workspace().releaseDraftAttachments({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      inputId: INPUT_ID,
    })).resolves.toEqual({ released: 1 });
    await expect(workspace().releaseDraftAttachments({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      inputId: INPUT_ID,
    })).resolves.toEqual({ released: 0 });
    await runInDurableObject(workspace(), (_instance, state) => {
      expect(state.storage.sql.exec<{ attachment_status: string }>(
        "SELECT attachment_status FROM resources WHERE id = ?",
        RESOURCE_ID,
      ).one()).toEqual({ attachment_status: "draft" });
    });
  });
});
