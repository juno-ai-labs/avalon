/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * `workspace_resource_versions`, on real workerd.
 *
 * The event is a socket message and nothing else, so the suite opens real
 * workspace sockets and reads what each is sent. Every producer writes a
 * version through `resources` triggers; the suite writes through the object's
 * own runtime-SQL port and its rename RPC, the two paths producers use, so the
 * write hook that drains the ledger runs as it does in production.
 */
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  WorkspaceNavigationStateEventSchema,
  WorkspaceResourceVersionsEventSchema,
  WorkspaceSocketSyncEventSchema,
  type ResourceHead,
  type UserId,
  type WorkstreamId,
} from "@rally/contracts";
import {
  conversationEffectHash,
  ParentEffectEnvelopeSchema,
  type ParentEffect,
} from "@rally/contracts/conversation-effects";

import { linkSpaceResources } from "../src/durable-objects/authorization-storage";
import { workspaceDOName } from "../src/durable-objects/names";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000e300");
const OWNER = asUserId("00000000-0000-7000-8000-00000000e301");
const MEMBER = asUserId("00000000-0000-7000-8000-00000000e302");
const OPEN_THREAD = asWorkstreamId("00000000-0000-7000-8000-00000000e303");
const PRIVATE_THREAD = asWorkstreamId("00000000-0000-7000-8000-00000000e304");
const REPORT = "00000000-0000-7000-8000-00000000e3a1";
const COMP_TABLE = "00000000-0000-7000-8000-00000000e3a2";
const LATE = "00000000-0000-7000-8000-00000000e3a3";

const workspace = () => env.WORKSPACE_DOS.getByName(workspaceDOName("global", WORKSPACE_ID));

let sequence = 0;
function nextId(suffix: string): string {
  sequence += 1;
  return `00000000-0000-7000-8000-${String(sequence).padStart(10, "0")}${suffix}`;
}

async function establishWorkspace(): Promise<void> {
  const members = [OWNER, MEMBER];
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT, abandoned_at TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (
      incarnation TEXT DEFAULT 'existing-member',
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT, access_class TEXT NOT NULL DEFAULT 'member',
      revision INTEGER NOT NULL DEFAULT 1,
      last_seen_at TEXT, PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      workspace_incarnation TEXT DEFAULT 'existing-member',
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      region TEXT NOT NULL, revoked_at TEXT, expires_at TEXT NOT NULL,
      impersonator_user_id TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_control (
      id INTEGER PRIMARY KEY, phase TEXT NOT NULL, generation INTEGER NOT NULL,
      required_serving_contract_version INTEGER NOT NULL,
      serving_contract_version INTEGER NOT NULL
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO workstream_authority_control
      (id, phase, generation, required_serving_contract_version, serving_contract_version)
      VALUES (1, 'durable_object_open', 1, 1, 1)`),
    env.DB.prepare(`INSERT OR REPLACE INTO workspaces(id, region) VALUES (?, 'global')`).bind(WORKSPACE_ID),
    ...members.flatMap((userId) => [
      env.DB.prepare(`INSERT OR REPLACE INTO workspace_members
        (workspace_id, user_id, status, role, access_class) VALUES (?, ?, 'active', 'member', 'member')`)
        .bind(WORKSPACE_ID, userId),
      env.DB.prepare(`INSERT OR REPLACE INTO sessions
        (id, user_id, workspace_id, region, revoked_at, expires_at)
        VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
        .bind(`versions-session-${userId}`, userId, WORKSPACE_ID),
    ]),
  ]);
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
}

function thread(title: string, scope: "personal" | "workspace", resourceId: string): ParentEffect {
  return {
    kind: "directory_common",
    title,
    description: "",
    preview: "",
    scope,
    state: "idle",
    systemKind: null,
    lastActivityAt: "2026-10-18T00:00:00.000Z",
    completedAt: null,
    archivedAt: null,
    createdByUserId: OWNER,
    latestAttentionOrdinal: 0,
    unreadTrackingStartOrdinal: 0,
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
    resourceLinks: [{ resourceId, watchEnabled: false, relationshipType: "generated" }],
  };
}

function participant(userId: UserId): ParentEffect {
  return {
    kind: "directory_user",
    userId,
    isParticipant: true,
    participantAddedAt: "2026-10-18T00:00:00.000Z",
    unreadCount: 0,
    youAreMentioned: false,
    unseen: false,
    listable: true,
    seenAttentionOrdinal: 0,
    manualUnreadFromOrdinal: null,
    manualUnreadGeneration: 0,
    latestMentionAttentionOrdinal: 0,
  };
}

async function project(workstreamId: WorkstreamId, effects: readonly ParentEffect[], sourceVersion = 1): Promise<void> {
  await workspace().applyWorkstreamDirectoryEffects({
    workspaceId: WORKSPACE_ID,
    envelopes: effects.map((effect) => ParentEffectEnvelopeSchema.parse({
      kind: "parent_effect",
      contractVersion: 1,
      region: "global",
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: workstreamId,
      generation: 1,
      messageId: nextId("e3"),
      partitionKey: effect.kind === "directory_user" ? `user:${effect.userId}` : "common",
      sourceVersion,
      requiredProjectionVersion: null,
      payloadHash: conversationEffectHash(effect),
      effect,
    })),
  });
}

async function runSql(sql: string, params: Array<string | number | null>): Promise<void> {
  await workspace().executeRuntimeSql({
    workspaceId: WORKSPACE_ID,
    requestId: nextId("e4"),
    statements: [{ sql, params }],
  });
}

async function storeResource(id: string, title: string, metadata: Record<string, unknown> = { size: 10 }): Promise<void> {
  await runSql(
    `INSERT INTO resources
       (id, workspace_id, resource_type, provider, title, mime_type, metadata_json, content_ref, created_at, updated_at)
     VALUES (?, ?, 'generated_file', 'avalon', ?, 'text/markdown', ?, 'v1', '2026-10-18T00:00:00.000Z', '2026-10-18T00:00:00.000Z')`,
    [id, WORKSPACE_ID, title, JSON.stringify(metadata)],
  );
}

/** A new version of a stored resource, as a Terminal republish swaps its content in. */
async function republish(
  id: string, contentRef: string, size: number, at: string, cause: "published" | "refetched" = "published",
): Promise<void> {
  await runSql(
    `UPDATE resources
        SET revision_author_kind = 'agent', revision_author_run_id = ?, revision_cause = ?,
            content_ref = ?, content_sha256 = ?, mime_type = 'text/html', metadata_json = json_set(metadata_json, '$.size', ?), updated_at = ?
      WHERE id = ?`,
    ["00000000-0000-7000-8000-00000000e3f1", cause, contentRef, contentRef, size, at, id],
  );
}

let ticketSequence = 0;

/** A subscribed workspace socket recording every resource-version event and artifact pin list it is sent. */
async function connect(userId: UserId): Promise<{ heads: ResourceHead[][]; pins: Array<Array<[string, number, boolean]>> }> {
  ticketSequence += 1;
  const response = await workspace().fetch("https://workspace.test/socket", {
    headers: {
      Upgrade: "websocket",
      "x-rally-workspace-id": WORKSPACE_ID,
      "x-rally-placement-affinity": "wnam",
      "x-rally-user-id": userId,
      "x-rally-session-id": `versions-session-${userId}`,
      "x-rally-socket-ticket-id": `00000000-0000-7000-8000-${String(ticketSequence).padStart(12, "0")}`,
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
    },
  });
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`workspace socket rejected: ${response.status} ${await response.text()}`);
  }
  const socket = response.webSocket;
  socket.accept();
  const received = { heads: [] as ResourceHead[][], pins: [] as Array<Array<[string, number, boolean]>> };
  const subscribed = new Promise<void>((resolve) => {
    socket.addEventListener("message", (event) => {
      const data = JSON.parse(String(event.data)) as unknown;
      const versions = WorkspaceResourceVersionsEventSchema.safeParse(data);
      if (versions.success) received.heads.push(versions.data.resources);
      const navigation = WorkspaceNavigationStateEventSchema.safeParse(data);
      if (navigation.success && navigation.data.artifactPins) {
        received.pins.push(navigation.data.artifactPins.map((pin) => [pin.id, pin.currentVersion, pin.unread]));
      }
      if (WorkspaceSocketSyncEventSchema.safeParse(data).success) resolve();
    });
  });
  socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
  await subscribed;
  return received;
}

beforeEach(async () => {
  await reset();
  sequence = 0;
  await establishWorkspace();
  await storeResource(REPORT, "Launch report");
  await storeResource(COMP_TABLE, "Comp table");
  await project(OPEN_THREAD, [thread("Launch", "workspace", REPORT), participant(OWNER)]);
  await project(PRIVATE_THREAD, [thread("Comp bands", "personal", COMP_TABLE), participant(OWNER)]);
});

describe("workspace_resource_versions", () => {
  it("tells everyone who can open the thread that a resource has a new version, with its new head", async () => {
    const owner = await connect(OWNER);
    const member = await connect(MEMBER);

    await republish(REPORT, "v2", 42, "2026-10-18T01:00:00.000Z");

    const head = {
      resourceId: REPORT,
      version: 2,
      title: "Launch report",
      mimeType: "text/html",
      updatedAt: "2026-10-18T01:00:00.000Z",
      contentAvailable: true,
      sizeBytes: 42,
    };
    await vi.waitFor(() => {
      expect(owner.heads).toEqual([[head]]);
      expect(member.heads).toEqual([[head]]);
    });
  });

  it("names a resource in a private thread only to the people who may open it", async () => {
    const owner = await connect(OWNER);
    const member = await connect(MEMBER);

    await republish(COMP_TABLE, "v2", 7, "2026-10-18T01:00:00.000Z");
    // The open thread's version reaches both sockets, which bounds the wait
    // for the member's silence about the private one.
    await republish(REPORT, "v2", 42, "2026-10-18T01:00:01.000Z");

    await vi.waitFor(() => {
      expect(owner.heads.flat().map((head) => head.resourceId)).toEqual([COMP_TABLE, REPORT]);
      expect(member.heads.flat().map((head) => head.resourceId)).toEqual([REPORT]);
    });
  });

  it("announces a version of any cause, a rename included, and stays quiet for a resource's first version", async () => {
    const member = await connect(MEMBER);

    // A link can name a resource before its row arrives, so the first version
    // is written while a thread the member opens already links it.
    await project(OPEN_THREAD, [{ ...thread("Launch", "workspace", REPORT), resourceLinks: [
      { resourceId: REPORT, watchEnabled: false, relationshipType: "generated" },
      { resourceId: LATE, watchEnabled: false, relationshipType: "generated" },
    ] } as ParentEffect], 2);
    await storeResource(LATE, "Late");
    await expect(workspace().renameResource({
      workspaceId: WORKSPACE_ID,
      resourceId: REPORT,
      title: "Launch report, final",
      renamedByUserId: OWNER,
      at: "2026-10-18T02:00:00.000Z",
    })).resolves.toMatchObject({ outcome: "renamed" });

    await vi.waitFor(() => expect(member.heads).toHaveLength(1));
    expect(member.heads).toEqual([[expect.objectContaining({
      resourceId: REPORT, version: 2, title: "Launch report, final",
    })]]);
  });

  it("tells a pinner of a republish but not of a refetch, from the same ledger that moves every preview", async () => {
    await expect(workspace().changeArtifactPin({
      workspaceId: WORKSPACE_ID, userId: MEMBER, itemId: REPORT, threadId: OPEN_THREAD, pinned: true,
    })).resolves.toMatchObject({ ok: true });
    const member = await connect(MEMBER);

    // A pin counts only versions written after it was made.
    const later = (seconds: number) => new Date(Date.now() + seconds * 1_000).toISOString();
    await republish(REPORT, "v2", 42, later(1), "refetched");
    await republish(REPORT, "v3", 43, later(2));

    await vi.waitFor(() => {
      expect(member.heads.flat().map((head) => head.version)).toEqual([2, 3]);
      expect(member.pins).toEqual([[[REPORT, 3, true]]]);
    });
  });

  it("tells a reader of a Channel a merge shared a resource with, though they cannot open its thread", async () => {
    const reserved = await workspace().reserveSpace({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      space: { name: "Pricing", iconKey: "briefcase", colorKey: "blue", scope: "workspace" },
    });
    if (!reserved.ok) throw new Error(`reserveSpace refused: ${reserved.code}`);
    // What a merge writes for each embed it shares.
    await runInDurableObject(workspace(), (_instance, state) => {
      linkSpaceResources(state.storage.sql, reserved.space.id, [COMP_TABLE]);
    });
    const member = await connect(MEMBER);

    await republish(COMP_TABLE, "v2", 7, "2026-10-18T01:00:00.000Z");

    await vi.waitFor(() => expect(member.heads.flat().map((head) => head.resourceId)).toEqual([COMP_TABLE]));
  });

  it("leaves out an unlisted resource, which no conversation advertises", async () => {
    await project(OPEN_THREAD, [{ ...thread("Launch", "workspace", REPORT), resourceLinks: [
      { resourceId: REPORT, watchEnabled: false, relationshipType: "generated" },
      { resourceId: LATE, watchEnabled: false, relationshipType: "generated" },
    ] } as ParentEffect], 2);
    await storeResource(LATE, "Recovery backup", { size: 10, listing: "unlisted" });
    const member = await connect(MEMBER);

    await republish(LATE, "v2", 7, "2026-10-18T01:00:00.000Z");
    await republish(REPORT, "v2", 42, "2026-10-18T01:00:01.000Z");

    await vi.waitFor(() => expect(member.heads.flat().map((head) => head.resourceId)).toContain(REPORT));
    expect(member.heads.flat().map((head) => head.resourceId)).toEqual([REPORT]);
  });
});
