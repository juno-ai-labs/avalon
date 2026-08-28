/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import { workstreamRegionalEffectHash } from "../src/durable-objects/workstream-regional-effect";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000008a0");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-0000000008a1");
const USER_ID = asUserId("00000000-0000-7000-8000-0000000008a2");
const OTHER_USER_ID = asUserId("00000000-0000-7000-8000-0000000008a7");
const INPUT_ID = "00000000-0000-7000-8000-0000000008a3";
const RESOURCE_ID = "00000000-0000-7000-8000-0000000008a4";
const OTHER_INPUT_ID = "00000000-0000-7000-8000-0000000008a6";

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

beforeEach(async () => {
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec("DELETE FROM pending_attachment_reservations");
    state.storage.sql.exec("DELETE FROM workspace_workstream_resource_links");
    state.storage.sql.exec("DELETE FROM workspace_workstream_directory");
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
      "2026-08-28T12:00:00.000Z",
      "2026-08-28T12:00:00.000Z",
    );
  });
});

describe("WorkspaceDO pending attachment reservations", () => {
  it("freezes the descriptor idempotently until canonical resource projection", async () => {
    const request = {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      inputId: INPUT_ID,
      userId: USER_ID,
      resourceIds: [RESOURCE_ID],
    };
    await expect(workspace().reserveDraftAttachments({
      ...request,
      userId: OTHER_USER_ID,
    })).resolves.toEqual({ outcome: "unavailable" });
    await expect(workspace().reserveDraftAttachments(request)).resolves.toMatchObject({
      outcome: "reserved",
      resources: [{ id: RESOURCE_ID, title: "pending.txt", contentRef: "global/test/pending" }],
    });
    await expect(workspace().reserveDraftAttachments(request)).resolves.toMatchObject({
      outcome: "replayed",
      resources: [{ id: RESOURCE_ID }],
    });
    await expect(workspace().reserveDraftAttachments({
      ...request,
      workstreamId: asWorkstreamId("00000000-0000-7000-8000-0000000008a8"),
    })).resolves.toEqual({ outcome: "unavailable" });
    await expect(workspace().reserveDraftAttachments({
      ...request,
      inputId: OTHER_INPUT_ID,
    })).resolves.toMatchObject({ outcome: "reserved" });

    await runInDurableObject(workspace(), (_instance, state) => {
      expect(state.storage.sql.exec<{ id: string }>(
        `DELETE FROM resources
          WHERE id = ?
            AND NOT EXISTS (SELECT 1 FROM pending_attachment_reservations reservation
                             WHERE reservation.resource_id = resources.id)
          RETURNING id`,
        RESOURCE_ID,
      ).toArray()).toEqual([]);
    });

    const effect = {
      kind: "directory_common" as const,
      title: "Attachment projection",
      description: "",
      preview: "",
      scope: "personal" as const,
      state: "running",
      systemKind: null,
      lastActivityAt: "2026-08-28T12:01:00.000Z",
      completedAt: null,
      archivedAt: null,
      originType: "ad_hoc" as const,
      createdByUserId: USER_ID,
      latestAttentionOrdinal: 1,
      unreadTrackingStartOrdinal: 0,
      createdAt: "2026-08-28T12:00:00.000Z",
      updatedAt: "2026-08-28T12:01:00.000Z",
      resourceLinks: [{
        resourceId: RESOURCE_ID,
        watchEnabled: false,
        relationshipType: "message_attachment" as const,
      }],
      attachmentReservationReleases: [{ inputId: INPUT_ID, resourceId: RESOURCE_ID }],
    };
    await workspace().applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: [{
        kind: "workstream_regional_effect" as const,
        contractVersion: 1 as const,
        region: "global" as const,
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        generation: 1,
        messageId: "00000000-0000-7000-8000-0000000008a5",
        partitionKey: "common",
        sourceVersion: 1,
        requiredProjectionVersion: null,
        payloadHash: workstreamRegionalEffectHash(effect),
        effect,
      }],
    });

    await runInDurableObject(workspace(), (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM pending_attachment_reservations",
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ input_id: string }>(
        "SELECT input_id FROM pending_attachment_reservations",
      ).one()).toEqual({ input_id: OTHER_INPUT_ID });
      expect(state.storage.sql.exec<{ attachment_status: string }>(
        "SELECT attachment_status FROM resources WHERE id = ?",
        RESOURCE_ID,
      ).one()).toEqual({ attachment_status: "attached" });
    });
    await workspace().releaseDraftAttachments({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      inputId: OTHER_INPUT_ID,
    });
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
