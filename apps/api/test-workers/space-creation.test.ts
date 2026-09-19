/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Every Channel is born in a Space, and none is published before it is.
 *
 * Both halves need the runtime. The first is three objects agreeing —
 * WorkspaceDO stages and settles the membership, the Channel's own authority
 * records which Space reaches it, and the conversation takes the audience that
 * implies — and each of those is a real transaction with a real fence.
 *
 * The second is an ordering property, and it needs a real alarm to be worth
 * anything. Reserving a Channel's main conversation arms the parent's recovery
 * alarm, and that alarm delivers the deferred provisional directory row itself
 * if it wins the race with the coordinator — so "the failed creation did not
 * flush" proves nothing, and what has to be true is that the membership settles
 * before a row can exist by either path.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asSpaceId, asUserId, asWorkspaceId, asWorkstreamId, type SpaceId } from "@rally/contracts";

import type { AuthContext, Env } from "../src/env";
import { workspaceDOName, workstreamDOName } from "../src/durable-objects/names";
import { WorkstreamObjectCreationService } from "../src/services/workstream-object-creation-service";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

/** Its own workspace id: object storage is reset per case, object names are not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000cc0");
const USER_ID = asUserId("00000000-0000-7000-8000-000000000cc1");
const SESSION_ID = "00000000-0000-7000-8000-000000000cc2";

const AUTH: AuthContext = {
  sessionId: SESSION_ID,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  region: "global",
  role: "member",
};

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
}

function channelAuthority(workstreamId: string) {
  return env.WORKSTREAM_DOS.getByName(
    workstreamDOName("global", WORKSPACE_ID, asWorkstreamId(workstreamId)),
  );
}

/** The address allocator needs a key; it is configuration, not behaviour. */
function creationEnv(): Env {
  return new Proxy(env, {
    get: (current, property, receiver) => property === "WORKSTREAM_EMAIL_ADDRESS_KEY"
      ? "workerd-test-email-address-key-0123456789"
      : Reflect.get(current, property, receiver),
  });
}

async function createChannel(clientMessageId: string, spaceIds: SpaceId[] = []) {
  return new WorkstreamObjectCreationService(creationEnv(), AUTH).createPrepared({
    title: "Hiring plan",
    clientMessageId,
    participantUserIds: [],
    spaceIds,
  }, { messages: [{ role: "user", text: "A prepared start" }] });
}

async function visibleChannelIds(): Promise<string[]> {
  const page = await workspace().listWorkstreams({
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    limit: 50,
    includeSystem: false,
  });
  return page.items.map((item) => item.id);
}

beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB, {
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    sessionId: SESSION_ID,
  });
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE workstream_create_receipts (
      workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id)
    )`),
    env.DB.prepare(`CREATE TABLE workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0
    )`),
    env.DB.prepare(`CREATE TABLE workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT, verified_at TEXT,
      activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL,
      UNIQUE (workspace_id, object_name), UNIQUE (workstream_id, generation)
    )`),
    env.DB.prepare(`CREATE TABLE workstream_email_routes (
      email_address TEXT PRIMARY KEY COLLATE NOCASE, address_source TEXT NOT NULL,
      region TEXT NOT NULL, workspace_id TEXT NOT NULL, workstream_id TEXT,
      automation_subscription_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (region, workspace_id, workstream_id)
    )`),
  ]);
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
}, 30_000);

describe("a Channel created without a Space", () => {
  it("lands in General with an active membership, a recorded source, and the audience that implies", async () => {
    const created = await createChannel("no-space");
    const workstreamId = asWorkstreamId(created.workstream.id);

    // General was made by the creation itself: nothing else had asked for it.
    const general = await workspace().spaceBootstrapStatus({ workspaceId: WORKSPACE_ID });
    expect(general.generalSpaceId).not.toBeNull();

    // The Organization's side: an *active* membership, which is what makes the
    // placement visible at all.
    expect(await workspace().channelSpaces({
      workspaceId: WORKSPACE_ID, userId: USER_ID, workstreamId,
    })).toEqual({ spaceIds: [general.generalSpaceId] });

    // The Channel's own side: General is recorded as a source that reaches it,
    // so a later retraction knows what it supplied. Read with the Channel as
    // the creation left it, which is the observation the authority derives the
    // direct source from.
    const sources = await channelAuthority(workstreamId).readAccessSources({
      workspaceId: WORKSPACE_ID,
      parentId: workstreamId,
      channel: { readers: { scope: "workspace" }, participantUserIds: [USER_ID] },
    });
    expect(sources.spaces.map((source) => source.spaceId)).toEqual([general.generalSpaceId]);
    // The direct source keeps what the caller asked for — a Channel somebody
    // started is personal on its own account — while the effective audience is
    // the union, which General makes Organization-wide.
    expect(sources.direct.scope).toBe("personal");
    expect(created.workstream.scope).toBe("workspace");

    // And the row a client reads carries the placement, so the sidebar can
    // draw the Channel under General on the first paint rather than after a
    // reload.
    const page = await workspace().listWorkstreams({
      workspaceId: WORKSPACE_ID, userId: USER_ID, limit: 50, includeSystem: false,
    });
    expect(page.items.find((item) => item.id === workstreamId)?.spaceIds)
      .toEqual([general.generalSpaceId]);
  });

  it("re-uses the one General across creations rather than making a second", async () => {
    const first = await createChannel("first");
    const second = await createChannel("second");
    const status = await workspace().spaceBootstrapStatus({ workspaceId: WORKSPACE_ID });
    for (const created of [first, second]) {
      expect(await workspace().channelSpaces({
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        workstreamId: asWorkstreamId(created.workstream.id),
      })).toEqual({ spaceIds: [status.generalSpaceId] });
    }
  });
});

describe("a creation whose membership cannot settle", () => {
  it("publishes no directory row and leaves no placement behind", async () => {
    // One placement first, so General exists and the failure below is about
    // the settlement rather than about the Space.
    await createChannel("settles");
    const before = await visibleChannelIds();

    // The way this breaks in production: the settlement's write is refused.
    // A trigger is how a refusal is made to happen at exactly that statement
    // rather than by stubbing the call that issues it.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        `CREATE TRIGGER fail_membership_settlement BEFORE UPDATE ON space_channel_memberships
           WHEN NEW.state = 'active'
           BEGIN SELECT RAISE(ABORT, 'space membership settlement unavailable'); END`,
      );
    });

    await expect(createChannel("cannot-settle")).rejects.toThrow(/settlement unavailable/u);

    // Nothing new is listable. The directory flush runs *after* the
    // memberships settle, so a Channel whose placement never became active is
    // a Channel no client is told about.
    expect(await visibleChannelIds()).toEqual(before);

    await runInDurableObject(workspace(), (_instance, state) => {
      // The staged row was cancelled rather than left `joining`, which is what
      // keeps the alarm from republishing an intent for a Channel nobody can
      // see.
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS rows FROM space_channel_memberships WHERE state = 'joining'",
      ).one()).toEqual({ rows: 0 });
      state.storage.sql.exec("DROP TRIGGER fail_membership_settlement");
    });
  });
});

describe("a Channel created inside a Space", () => {
  it("takes that Space's audience rather than General's", async () => {
    const reserved = await workspace().reserveSpace({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      space: { name: "Private", iconKey: "briefcase", colorKey: "blue", scope: "personal" },
    });
    if (!reserved.ok) throw new Error(`reserveSpace refused: ${reserved.code}`);
    const spaceId = asSpaceId(reserved.space.id);

    const created = await createChannel("named-space", [spaceId]);

    // Its own Space and nothing else: General is the fallback for a creation
    // that named none, never an additional membership.
    expect(await workspace().channelSpaces({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      workstreamId: asWorkstreamId(created.workstream.id),
    })).toEqual({ spaceIds: [spaceId] });
    expect(created.workstream.scope).toBe("personal");
  });
});
