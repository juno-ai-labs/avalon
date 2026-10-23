/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Seating a member who joins: a participant of General, and the owner of a
 * Personal Channel scoped `individual` that nobody else is shown. On real
 * workerd, because it is the object's own SQLite (the widened scope check,
 * the one-per-member index), its D1 membership read and the snapshot a socket
 * is answered with that decide it. See docs/spaces.md#the-personal-channel.
 */
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  asSpaceId,
  asUserId,
  asWorkspaceId,
  WorkspaceSocketSyncEventSchema,
  type SpaceId,
  type SpaceSummary,
  type UserId,
  type WorkspaceSidebar,
} from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import { SPACE_CHANNEL_PAGE_SIZE } from "../src/durable-objects/workspace-space-storage";
import { withSpaceStorage } from "./helpers/space-membership";
import { acceptInvitationForUser } from "../src/services/workspace-service";
import { WorkspaceRelationshipChangeMessageSchema } from "../src/services/workspace-relationship-delivery";
import { applyWorkspaceRelationshipChange } from "../src/queues/access-revocation-consumer";

/** Its own workspace id: object names are shared across files, storage is not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000fe100");
const OWNER = asUserId("00000000-0000-7000-8000-0000000fe101");
const MEMBER = asUserId("00000000-0000-7000-8000-0000000fe102");
const GUEST = asUserId("00000000-0000-7000-8000-0000000fe103");
const GENERAL = asSpaceId("00000000-0000-7000-8000-0000000fe110");
const OWNER_PERSONAL = asSpaceId("00000000-0000-7000-8000-0000000fe111");
const MEMBER_PERSONAL = asSpaceId("00000000-0000-7000-8000-0000000fe112");

function workspace() {
  return env.WORKSPACE_DOS.getByName(workspaceDOName("global", WORKSPACE_ID));
}

async function establishWorkspace(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT, abandoned_at TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (
      incarnation TEXT DEFAULT 'existing-member', revision INTEGER NOT NULL DEFAULT 1,
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT, access_class TEXT NOT NULL DEFAULT 'member',
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
    // What `claimParentAnchor` writes and reads when the backfill anchors a
    // Personal Channel, as the D1 migrations declare them.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_create_receipts (
      workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT,
      verified_at TEXT, activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL
    )`),
    ...([[OWNER, "owner", "member"], [MEMBER, "member", "member"], [GUEST, null, "guest"]] as const).flatMap(
      ([userId, role, accessClass]) => [
        env.DB.prepare(`INSERT OR REPLACE INTO workspace_members
          (workspace_id, user_id, status, role, access_class) VALUES (?, ?, 'active', ?, ?)`)
          .bind(WORKSPACE_ID, userId, role, accessClass),
        env.DB.prepare(`INSERT OR REPLACE INTO sessions
          (id, user_id, workspace_id, region, revoked_at, expires_at)
          VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
          .bind(`personal-session-${userId}`, userId, WORKSPACE_ID),
      ],
    ),
  ]);
  // A new Organization, as `createOwnedWorkspace` opens one: General and the
  // creator's Personal Channel in the one object call.
  const opened = await workspace().initializeWorkspace(WORKSPACE_ID, "wnam", {
    creatorUserId: OWNER, spaceId: GENERAL, personalSpaceId: OWNER_PERSONAL, authorityGeneration: 1,
  });
  if (!opened.spacesReady) throw new Error("the new Organization's Spaces did not open");
}

let ticketSequence = 0;

/**
 * The Space directory a socket is answered with, as a desktop reads it.
 * `readsIndividual` is the header the edge sets from the socket ticket.
 */
async function activeSpaces(userId: string, readsIndividual = true): Promise<SpaceSummary[]> {
  ticketSequence += 1;
  const response = await workspace().fetch("https://workspace.test/socket", {
    headers: {
      Upgrade: "websocket",
      "x-rally-workspace-id": WORKSPACE_ID,
      "x-rally-placement-affinity": "wnam",
      "x-rally-user-id": userId,
      "x-rally-session-id": `personal-session-${userId}`,
      "x-rally-socket-ticket-id": `00000000-0000-7000-8000-${ticketSequence.toString(16).padStart(12, "0")}`,
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      ...(readsIndividual ? { "x-rally-socket-reads-individual-spaces": "1" } : {}),
    },
  });
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`workspace socket rejected: ${response.status} ${await response.text()}`);
  }
  const socket = response.webSocket;
  socket.accept();
  const first = new Promise<MessageEvent>((resolve) => socket.addEventListener("message", resolve, { once: true }));
  socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
  const sidebar: WorkspaceSidebar | undefined = WorkspaceSocketSyncEventSchema.parse(JSON.parse(String((await first).data))).sidebar;
  socket.close();
  if (!sidebar?.spaces) throw new Error("workspace sidebar answered without Space directories");
  return sidebar.spaces.active.items;
}

function participants(space: SpaceSummary | undefined): string[] {
  return (space?.participants ?? []).map((participant) => participant.userId).sort();
}

beforeEach(async () => {
  await reset();
  ticketSequence = 0;
  await establishWorkspace();
});

describe("a new Organization", () => {
  it("gives its creator General and a Personal Channel only they are shown", async () => {
    const spaces = await activeSpaces(OWNER);
    expect(spaces.map((space) => [space.name, space.scope, space.systemRole]).sort()).toEqual([
      ["General", "workspace", "general"],
      ["Your Personal Channel", "individual", null],
    ]);
    expect(participants(spaces.find((space) => space.id === OWNER_PERSONAL))).toEqual([OWNER]);
    expect((await activeSpaces(MEMBER)).map((space) => space.id)).toEqual([GENERAL]);
  });
});

describe("seatOrganizationMember", () => {
  it("dispatches an accepted invitation immediately and retries its pending delivery on replay", async () => {
    const probe = env.QUEUE_PROBE;
    const received = env.QUEUE_PROBE_TEST;
    if (!probe || !received) throw new Error("queue probe bindings missing");
    const invitationId = "00000000-0000-7000-8000-0000000fe130";
    await env.DB.batch([
      env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?").bind(WORKSPACE_ID, MEMBER),
      env.DB.prepare("ALTER TABLE workspace_members ADD COLUMN joined_at TEXT"),
      env.DB.prepare("ALTER TABLE workspaces ADD COLUMN name TEXT"),
      env.DB.prepare("UPDATE workspaces SET name = 'Invitation test' WHERE id = ?").bind(WORKSPACE_ID),
      env.DB.prepare("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT)"),
      env.DB.prepare("INSERT INTO users VALUES (?, 'Owner', 'owner@example.test'), (?, 'Member', 'member@example.test')")
        .bind(OWNER, MEMBER),
      env.DB.prepare(`CREATE TABLE workspace_invitations (
        id TEXT PRIMARY KEY, workspace_id TEXT, email TEXT, invited_by_user_id TEXT,
        role TEXT, expires_at TEXT, accepted_at TEXT, accepted_by_user_id TEXT,
        revoked_at TEXT, created_at TEXT)`),
      env.DB.prepare(`INSERT INTO workspace_invitations
        (id, workspace_id, email, invited_by_user_id, role, expires_at, created_at)
        VALUES (?, ?, 'member@example.test', ?, 'member', '2099-01-01T00:00:00.000Z', '2026-10-22T00:00:00.000Z')`)
        .bind(invitationId, WORKSPACE_ID, OWNER),
      env.DB.prepare(`CREATE TABLE workspace_relationship_deliveries (
        sequence INTEGER PRIMARY KEY, workspace_id TEXT, user_id TEXT, incarnation TEXT,
        revision INTEGER, change_kind TEXT, access_class TEXT, role TEXT, status TEXT,
        dispatched_at TEXT, processed_at TEXT)`),
      env.DB.prepare(`CREATE TRIGGER membership_delivery AFTER INSERT ON workspace_members BEGIN
        INSERT INTO workspace_relationship_deliveries
          (workspace_id, user_id, incarnation, revision, change_kind, access_class, role, status)
        VALUES (NEW.workspace_id, NEW.user_id, NEW.incarnation, NEW.revision, 'upsert',
          NEW.access_class, NEW.role, NEW.status);
      END`),
    ]);
    const apiEnv = { ...env, ACCESS_REVOCATION_QUEUE: probe };
    const user = { id: MEMBER, email: "member@example.test" };
    await expect(acceptInvitationForUser(apiEnv, invitationId, user)).resolves.toBe(WORKSPACE_ID);
    expect(await env.DB.prepare("SELECT dispatched_at FROM workspace_relationship_deliveries WHERE user_id = ?")
      .bind(MEMBER).first()).toEqual({ dispatched_at: expect.any(String) });

    const messages = async () => (await received.received()).flatMap((body) => {
      const parsed = WorkspaceRelationshipChangeMessageSchema.safeParse(body);
      return parsed.success && parsed.data.relationship.workspaceId === WORKSPACE_ID ? [parsed.data] : [];
    });
    await expect.poll(messages, { timeout: 15_000 }).toHaveLength(1);
    const [message] = await messages();
    expect(message).toMatchObject({ kind: "workspace_relationship_changed", removed: false,
      relationship: { userId: MEMBER, accessClass: "member", role: "member", status: "active" } });
    await applyWorkspaceRelationshipChange(apiEnv, message!);
    expect((await activeSpaces(MEMBER)).map((space) => [space.name, participants(space).includes(MEMBER)]).sort())
      .toEqual([["General", true], ["Your Personal Channel", true]]);

    // Queue acceptance with a lost dispatch marker must be recoverable by an
    // acceptance retry, without waiting for the scheduled sweep.
    await env.DB.prepare("UPDATE workspace_relationship_deliveries SET dispatched_at = NULL WHERE user_id = ?")
      .bind(MEMBER).run();
    await acceptInvitationForUser(apiEnv, invitationId, user);
    await expect.poll(messages, { timeout: 15_000 }).toHaveLength(2);
    await applyWorkspaceRelationshipChange(apiEnv, (await messages())[1]!);
    expect((await activeSpaces(MEMBER)).filter((space) => space.scope === "individual").map((space) => space.name))
      .toEqual(["Your Personal Channel"]);
  });

  it("asks for an anchor, then seats the member in General and creates their Personal Channel once", async () => {
    const request = { workspaceId: WORKSPACE_ID, userId: MEMBER, personalSpaceId: MEMBER_PERSONAL };
    await expect(workspace().seatOrganizationMember(request))
      .resolves.toEqual({ seated: true, personalSpace: "absent" });
    await expect(workspace().seatOrganizationMember({ ...request, authorityGeneration: 1 }))
      .resolves.toEqual({ seated: true, personalSpace: "present" });
    // A redelivery under another id finds the one they have.
    await expect(workspace().seatOrganizationMember({
      ...request, personalSpaceId: asSpaceId("00000000-0000-7000-8000-0000000fe113"), authorityGeneration: 1,
    })).resolves.toEqual({ seated: true, personalSpace: "present" });

    const memberSpaces = await activeSpaces(MEMBER);
    expect(participants(memberSpaces.find((space) => space.id === GENERAL))).toEqual([OWNER, MEMBER].sort());
    expect(memberSpaces.filter((space) => space.scope === "individual").map((space) => [space.id, participants(space)]))
      .toEqual([[MEMBER_PERSONAL, [MEMBER]]]);
    // Nobody else is shown it, an Organization owner included.
    expect((await activeSpaces(OWNER)).map((space) => space.id)).not.toContain(MEMBER_PERSONAL);
  });

  it("gives a guest neither", async () => {
    await expect(workspace().seatOrganizationMember({
      workspaceId: WORKSPACE_ID, userId: GUEST, personalSpaceId: MEMBER_PERSONAL, authorityGeneration: 1,
    })).resolves.toEqual({ seated: false, reason: "not_member" });
    await runInDurableObject(workspace(), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT space_id FROM space_viewers WHERE user_id = ?", GUEST).toArray()).toEqual([]);
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM spaces WHERE scope = 'individual'").one())
        .toEqual({ count: 1 });
    });
  });

  it("seats a member who joined while the Organization's Spaces were not open once they open", async () => {
    await workspace().reopenSpaceBootstrap({ workspaceId: WORKSPACE_ID });
    // As the relationship delivery does: record the member, then seat them.
    await workspace().applyMemberStatus({
      workspaceId: WORKSPACE_ID, sequence: 1, removed: false,
      relationship: {
        workspaceId: WORKSPACE_ID, userId: MEMBER, accessClass: "member", role: "member",
        status: "active", incarnation: "existing-member", revision: 1,
      },
    });
    await expect(workspace().seatOrganizationMember({
      workspaceId: WORKSPACE_ID, userId: MEMBER, personalSpaceId: MEMBER_PERSONAL,
    })).resolves.toEqual({ seated: false, reason: "spaces_not_open" });
    // The cutover closes; the seating pass it queues reaches the member.
    await expect(workspace().finalizeSpaceBootstrap({ workspaceId: WORKSPACE_ID }))
      .resolves.toMatchObject({ outcome: "complete" });
    await expect.poll(async () => withSpaceStorage(workspace(), (storage) => storage.personalSpaceId(MEMBER)), {
      timeout: 15_000,
    }).not.toBeNull();
    expect(participants((await activeSpaces(MEMBER)).find((space) => space.id === GENERAL))).toEqual([OWNER, MEMBER].sort());
  });

  it("seats a member who left and came back in General and their Personal Channel again", async () => {
    const request = { workspaceId: WORKSPACE_ID, userId: MEMBER, personalSpaceId: MEMBER_PERSONAL, authorityGeneration: 1 };
    await workspace().seatOrganizationMember(request);
    const relationship = {
      workspaceId: WORKSPACE_ID, userId: MEMBER, accessClass: "member" as const, role: "member" as const,
      status: "active" as const, incarnation: "existing-member", revision: 1,
    };
    await workspace().applyMemberStatus({ workspaceId: WORKSPACE_ID, sequence: 1, removed: true, relationship });
    await workspace().applyMemberStatus({
      workspaceId: WORKSPACE_ID, sequence: 2, removed: false, relationship: { ...relationship, incarnation: "rejoined" },
    });
    await workspace().seatOrganizationMember(request);
    const spaces = await activeSpaces(MEMBER);
    expect(spaces.map((space) => [space.id, participants(space).includes(MEMBER)]).sort())
      .toEqual([[GENERAL, true], [MEMBER_PERSONAL, true]].sort());
  });
});

describe("linkTitle", () => {
  it("names General but never a Personal Channel", async () => {
    await expect(workspace().linkTitle({ workspaceId: WORKSPACE_ID, target: { kind: "space", spaceId: GENERAL } }))
      .resolves.toEqual({ title: "General" });
    await expect(workspace().linkTitle({ workspaceId: WORKSPACE_ID, target: { kind: "space", spaceId: OWNER_PERSONAL } }))
      .resolves.toEqual({ title: null });
  });
});

describe("reading General", () => {
  it("answers General and writes nothing", async () => {
    const bootstrap = () => runInDurableObject(workspace(), (_instance, state) => (
      state.storage.sql.exec("SELECT * FROM space_bootstrap").toArray()
    ));
    const before = await bootstrap();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(workspace().readGeneralSpace({ workspaceId: WORKSPACE_ID, userId: MEMBER }))
      .resolves.toMatchObject({ ok: true, space: { id: GENERAL, systemRole: "general" } });
    expect(await bootstrap()).toEqual(before);
  });
});

describe("a Personal Channel", () => {
  it("refuses a change of audience and an archive", async () => {
    await expect(workspace().noteSpaceAudience({
      workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: OWNER_PERSONAL,
      audience: { scope: "personal", participantUserIds: [OWNER, MEMBER] },
    })).resolves.toMatchObject({ ok: false, code: "space_protected" });
    await expect(workspace().archiveSpace({ workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: OWNER_PERSONAL }))
      .resolves.toMatchObject({ ok: false, code: "space_protected" });
    expect(participants((await activeSpaces(OWNER)).find((space) => space.id === OWNER_PERSONAL))).toEqual([OWNER]);
  });

  it("is listed to nobody but its owner, even one given a participant row", async () => {
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO space_viewers
        (space_id, user_id, is_participant, authority_generation, source_version, payload_hash)
        VALUES (?, ?, 1, 1, 0, '')`, OWNER_PERSONAL, MEMBER);
    });
    expect((await activeSpaces(MEMBER)).map((space) => space.id)).toEqual([GENERAL]);
    expect((await activeSpaces(OWNER)).map((space) => space.id)).toContain(OWNER_PERSONAL);
  });

  it("is not listed to its owner while they are a guest", async () => {
    const listed = (accessClass: "member" | "guest") => withSpaceStorage(workspace(), (storage) => (
      storage.list(WORKSPACE_ID, { userId: OWNER, accessClass }).items.map((space) => space.id)
    ));
    expect(await listed("member")).toContain(OWNER_PERSONAL);
    expect(await listed("guest")).not.toContain(OWNER_PERSONAL);
  });

  it("reaches a desktop that predates the scope as private", async () => {
    const spaces = await activeSpaces(OWNER, false);
    expect(spaces.find((space) => space.id === OWNER_PERSONAL)?.scope).toBe("personal");
  });
});

/** One Channel's feed as `userId` reads it. */
async function feedItems(spaceId: SpaceId, userId: UserId) {
  const result = await workspace().listChannelFeed({ workspaceId: WORKSPACE_ID, userId, spaceId, cursor: null });
  if (!result.ok) throw new Error(`listChannelFeed refused: ${result.code}`);
  return result.page.items;
}

describe("Channel messages", () => {
  it("open General for every member and a Personal Channel for its owner, posted once", async () => {
    const welcome = (items: Awaited<ReturnType<typeof feedItems>>) => items.flatMap((item) => (
      item.kind === "message" ? [[item.message.author.kind, item.message.body]] : []
    ));
    expect(welcome(await feedItems(GENERAL, MEMBER))).toEqual([["rally",
      "Welcome to Rally, we’ve created a channel for you to get started with. Channels are places to organize similar "
      + "work. When you type a task or a project below we start a Thread to actually work with the Rally AI agent."]]);
    expect(welcome(await feedItems(OWNER_PERSONAL, OWNER))).toEqual([["rally",
      "Welcome to Rally! This is your personal Channel to try Rally out and do private work. Type a task or project "
      + "below and we’ll start a thread where you’ll work with the Rally AI agent."]]);
    // Seating again, and the backfill's pass, find it there.
    await workspace().seatOrganizationMember({
      workspaceId: WORKSPACE_ID, userId: OWNER, personalSpaceId: OWNER_PERSONAL, authorityGeneration: 1,
    });
    await runInDurableObject(workspace(), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT space_id FROM space_messages").toArray().map((row) => row.space_id).sort())
        .toEqual([GENERAL, OWNER_PERSONAL].sort());
    });
  });

  it("post each starting position once, so a Channel keeps the words it opened with", async () => {
    // General opened with one message at position 0; this list rewords it and
    // adds a second.
    const drafts = [{ author: { kind: "rally" as const }, body: "Reworded" }, { author: { kind: "rally" as const }, body: "Second" }];
    await withSpaceStorage(workspace(), (storage) => {
      storage.postStartingMessages(GENERAL, drafts);
      storage.postStartingMessages(GENERAL, drafts);
    });
    const bodies = (await feedItems(GENERAL, OWNER)).flatMap((item) => (item.kind === "message" ? [item.message.body] : []));
    expect(bodies.map((body) => body.slice(0, 16)).sort()).toEqual(["Second", "Welcome to Rally"]);
  });

  it("are posted by a member or by Rally, once per key and every time without one", async () => {
    await withSpaceStorage(workspace(), (storage) => {
      const posted = storage.postMessages(GENERAL, [
        { author: { kind: "member", userId: MEMBER }, body: "Morning **all**", key: "standup" },
        { author: { kind: "rally" }, body: "Noted" },
      ], Date.now());
      // The same key is the same message; no key is a new one.
      expect(storage.postMessages(GENERAL, [
        { author: { kind: "member", userId: MEMBER }, body: "Morning **all**", key: "standup" },
      ], Date.now())).toEqual([posted[0]]);
      expect(storage.postMessages(GENERAL, [{ author: { kind: "rally" }, body: "Noted" }], Date.now())).not.toEqual([posted[1]]);
    });
    const messages = (await feedItems(GENERAL, OWNER)).flatMap((item) => (item.kind === "message" ? [item.message] : []));
    expect(messages.map((message) => [message.author, message.body]).slice(0, 3)).toEqual(expect.arrayContaining([
      [{ kind: "member", userId: MEMBER }, "Morning **all**"],
      [{ kind: "rally" }, "Noted"],
    ]));
    expect(messages.filter((message) => message.body === "Noted")).toHaveLength(2);
    expect(messages.filter((message) => message.body === "Morning **all**")).toHaveLength(1);
  });

  it("sit below the threads placed after them, and a page that ends on a thread resumes on a message", async () => {
    // A full page of Organization-wide threads placed after General was made.
    await runInDurableObject(workspace(), (_instance, state) => {
      const madeAt = state.storage.sql.exec<{ created_at: number }>(
        "SELECT created_at FROM spaces WHERE space_id = ?", GENERAL,
      ).one().created_at;
      for (let index = 1; index <= SPACE_CHANNEL_PAGE_SIZE; index += 1) {
        const threadId = `00000000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;
        state.storage.sql.exec(`INSERT INTO channels (
          workstream_id, authority_generation, waterline, source_event_id, payload_hash,
          title, description, preview, scope, exact_state, origin_type, title_status,
          latest_attention_ordinal, unread_tracking_start_ordinal, last_activity_at,
          source_created_at, source_updated_at, projected_at
        ) VALUES (?, 1, 1, ?, 'hash', 'Shared', '', '', 'workspace', 'idle', 'ad_hoc', 'settled', 0, 0, ?, ?, ?, ?)`,
        threadId, `event-${index}`, madeAt + index, madeAt + index, madeAt + index, madeAt + index);
        state.storage.sql.exec(`INSERT INTO space_channel_memberships (space_id, workstream_id, state, generation, joined_at, updated_at)
          VALUES (?, ?, 'active', 1, ?, ?)`, GENERAL, threadId, madeAt + index, madeAt + index);
      }
    });
    // The storage page: what the feed orders and pages, before any thread is
    // resolved into a row.
    const page = (cursor: string | null) => withSpaceStorage(workspace(), (storage) => {
      const read = storage.feedPage({ userId: MEMBER, accessClass: "member" }, GENERAL, cursor);
      if (read === false || read === "invalid_cursor") throw new Error(String(read));
      return read;
    });
    const first = await page(null);
    expect(first.items.map((item) => item.kind)).toEqual(Array(SPACE_CHANNEL_PAGE_SIZE).fill("thread"));
    expect(first.nextCursor).not.toBeNull();
    const second = await page(first.nextCursor);
    expect(second.items.map((item) => item.kind)).toEqual(["message"]);
    expect(second.nextCursor).toBeNull();
  });

  // At time `tie` a thread and a message share a timestamp; the thread's id
  // sorts first. Newer messages push the page edge between the two, or just
  // past both, so the next page resumes on a message or on a thread.
  it.each([
    ["between a thread and a message at the same time", 1],
    ["on a message, resuming on a thread", 2],
  ])("walk every row once when a page ends %s", async (_name, short) => {
    const tiedThread = "00000000-0000-7000-8000-000000000001";
    const olderThread = "00000000-0000-7000-8000-000000000002";
    const madeAt = await runInDurableObject(workspace(), (_instance, state) => {
      const created = state.storage.sql.exec<{ created_at: number }>(
        "SELECT created_at FROM spaces WHERE space_id = ?", GENERAL,
      ).one().created_at;
      for (const [threadId, at] of [[tiedThread, created + 1_000], [olderThread, created + 500]] as const) {
        state.storage.sql.exec(`INSERT INTO channels (
          workstream_id, authority_generation, waterline, source_event_id, payload_hash,
          title, description, preview, scope, exact_state, origin_type, title_status,
          latest_attention_ordinal, unread_tracking_start_ordinal, last_activity_at,
          source_created_at, source_updated_at, projected_at
        ) VALUES (?, 1, 1, ?, 'hash', 'Shared', '', '', 'workspace', 'idle', 'ad_hoc', 'settled', 0, 0, ?, ?, ?, ?)`,
        threadId, `event-${threadId}`, at, at, at, at);
        state.storage.sql.exec(`INSERT INTO space_channel_memberships (space_id, workstream_id, state, generation, joined_at, updated_at)
          VALUES (?, ?, 'active', 1, ?, ?)`, GENERAL, threadId, at, at);
      }
      return created;
    });
    const tie = madeAt + 1_000;
    const posted = await withSpaceStorage(workspace(), (storage) => {
      const tied = storage.postMessages(GENERAL, [{ author: { kind: "rally" }, body: "tied" }], tie)[0]!;
      const newer = Array.from({ length: SPACE_CHANNEL_PAGE_SIZE - short }, (_, index) => (
        storage.postMessages(GENERAL, [{ author: { kind: "rally" }, body: `newer ${index}` }], tie + 1 + index)[0]!
      ));
      return { tied, newer };
    });
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const read = await withSpaceStorage(workspace(), (storage) => (
        storage.feedPage({ userId: MEMBER, accessClass: "member" }, GENERAL, cursor)
      ));
      if (read === false || read === "invalid_cursor") throw new Error(String(read));
      ids.push(...read.items.map((item) => (item.kind === "thread" ? item.workstreamId : item.message.id)));
      cursor = read.nextCursor;
    } while (cursor !== null);
    const welcome = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ message_id: string }>(
      "SELECT message_id FROM space_messages WHERE space_id = ? AND message_key IS NOT NULL", GENERAL,
    ).one().message_id);
    expect(ids).toEqual([
      ...[...posted.newer].reverse(),
      tiedThread, posted.tied, olderThread, welcome,
    ]);
  });
});

describe("migration 103", () => {
  it("seats every existing member in General and gives each a Personal Channel, and no guest either", async () => {
    // An Organization from before Personal Channels: its creator's was made
    // above, and nobody else has one or sits in General.
    const backfill = WORKSPACE_DO_SCHEMA_MIGRATIONS.find((migration) => migration.version === 103);
    await runInDurableObject(workspace(), async (_instance, state) => {
      // ...and whose General was made before Channel messages.
      state.storage.sql.exec("DELETE FROM space_messages WHERE space_id = ?", GENERAL);
      for (const statement of backfill?.statements ?? []) state.storage.sql.exec(statement);
      await state.storage.setAlarm(Date.now());
    });
    // The alarm is the delivery; poll what it settles rather than forcing it.
    await expect.poll(async () => withSpaceStorage(workspace(), (storage) => storage.personalSpaceId(MEMBER)), {
      timeout: 15_000,
    }).not.toBeNull();
    // The pass ends with General's welcome, dated when General was made.
    await expect.poll(async () => (await feedItems(GENERAL, MEMBER)).map((item) => item.kind), { timeout: 15_000 })
      .toEqual(["message"]);
    const memberSpaces = await activeSpaces(MEMBER);
    expect(participants(memberSpaces.find((space) => space.id === GENERAL))).toEqual([OWNER, MEMBER].sort());
    expect(memberSpaces.filter((space) => space.scope === "individual").map(participants)).toEqual([[MEMBER]]);
    await runInDurableObject(workspace(), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT created_by_user_id FROM spaces WHERE scope = 'individual'")
        .toArray().map((row) => row.created_by_user_id).sort()).toEqual([OWNER, MEMBER].sort());
      expect(state.storage.sql.exec("SELECT space_id FROM space_viewers WHERE user_id = ?", GUEST).toArray()).toEqual([]);
    });
    // The member's anchor was written by the pass; the creator's predates it.
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM workstreams").first<{ count: number }>())?.count).toBe(1);
  });
});

describe("migration 102", () => {
  it("rebuilds a populated Organization's Spaces at 101, keeping every row and the colour trigger", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("personal-channel-v101");
    await stub.ping();
    const space = "00000000-0000-7000-8000-0000000fe120";
    const thread = "00000000-0000-7000-8000-0000000fe121";
    await runInDurableObject(stub, (_instance, state) => {
      const before = WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 101);
      expect(before.at(-1)?.version).toBe(101);
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: before, component: "workspace_do", workerVersionId: "before-personal", now: 1,
      });
      state.storage.sql.exec(`INSERT INTO spaces
        (space_id, title, scope, appearance_json, created_by_user_id, system_role, authority_generation,
         source_version, payload_hash, revision, created_at, updated_at, latest_attention_ordinal,
         unread_tracking_start_ordinal)
        VALUES (?, 'General', 'workspace', '{"icon":"building-2","color":"blue"}', ?, 'general', 1, 1, 'h', 3, 5, 6, 2, 1)`,
      space, OWNER);
      state.storage.sql.exec(`INSERT INTO space_channel_memberships (space_id, workstream_id, state, generation, joined_at, updated_at)
        VALUES (?, ?, 'active', 1, 5, 5)`, space, thread);
      // A per-Channel pin: its table holds an ON DELETE CASCADE key to
      // `spaces`, so a rebuild that drops `spaces` without holding it loses it.
      state.storage.sql.exec(`INSERT INTO channels (
        workstream_id, authority_generation, waterline, source_event_id, payload_hash,
        title, description, preview, scope, exact_state, origin_type, title_status,
        latest_attention_ordinal, unread_tracking_start_ordinal, last_activity_at,
        source_created_at, source_updated_at, projected_at
      ) VALUES (?, 1, 1, 'event-pin', 'hash', 'Pinned', '', '', 'workspace', 'idle', 'ad_hoc', 'settled', 0, 0, 5, 5, 5, 5)`,
      thread);
      state.storage.sql.exec(`INSERT INTO workspace_workstream_pins (user_id, space_id, workstream_id, position, created_at, updated_at)
        VALUES (?, ?, ?, 0, 5, 5)`, OWNER, space, thread);
    });

    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS, component: "workspace_do",
        workerVersionId: "with-personal", now: 2,
      });
      const sql = state.storage.sql;
      expect(sql.exec(`SELECT space_id, title, scope, created_by_user_id, system_role, revision, created_at, updated_at,
          latest_attention_ordinal, unread_tracking_start_ordinal FROM spaces`).toArray()).toEqual([{
        space_id: space, title: "General", scope: "workspace", created_by_user_id: OWNER, system_role: "general",
        revision: 3, created_at: 5, updated_at: 6, latest_attention_ordinal: 2, unread_tracking_start_ordinal: 1,
      }]);
      const individual = (spaceId: string): void => {
        sql.exec(`INSERT INTO spaces
          (space_id, title, scope, created_by_user_id, authority_generation, source_version, payload_hash, revision, created_at, updated_at)
          VALUES (?, 'Mine', 'individual', ?, 1, 0, '', 1, 7, 7)`, spaceId, OWNER);
      };
      individual("00000000-0000-7000-8000-0000000fe122");
      // One per member, and General stays one.
      expect(() => individual("00000000-0000-7000-8000-0000000fe123")).toThrow(/UNIQUE/u);
      expect(() => sql.exec(`INSERT INTO spaces
        (space_id, title, scope, system_role, authority_generation, source_version, payload_hash, revision, created_at, updated_at)
        VALUES ('second-general', 'General', 'workspace', 'general', 1, 0, '', 1, 8, 8)`)).toThrow(/UNIQUE/u);
      // The trigger the drop took with it is back: a recolour marks the thread.
      // The placement above already marked it, so start from none.
      sql.exec("DELETE FROM channel_color_sync");
      sql.exec(`UPDATE spaces SET appearance_json = '{"icon":"building-2","color":"red"}' WHERE space_id = ?`, space);
      expect(sql.exec("SELECT workstream_id FROM channel_color_sync WHERE workstream_id = ?", thread).toArray())
        .toEqual([{ workstream_id: thread }]);
      expect(sql.exec("SELECT user_id, space_id, workstream_id, position FROM workspace_workstream_pins").toArray())
        .toEqual([{ user_id: OWNER, space_id: space, workstream_id: thread, position: 0 }]);
      expect(sql.exec(`SELECT COUNT(*) AS count FROM sqlite_master
        WHERE name IN ('spaces_hold', 'workspace_workstream_pins_hold')`).one()).toEqual({ count: 0 });
      expect(sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
    });
  });
});
