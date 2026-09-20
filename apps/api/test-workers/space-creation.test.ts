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
import { SlackWorkspaceWorkstreamService } from "../src/services/slack-workspace-workstream-service";
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

describe("a settled placement", () => {
  it("leaves no intent-resume wake behind it", async () => {
    // Close the cutover first, the way the path that opens a new Organization
    // does. A `pending` one is a derived alarm candidate due at the epoch —
    // that is how the fleet migration starts with nobody signed in — so
    // without this the assertions below would be measuring the cutover.
    await workspace().finalizeSpaceBootstrap({ workspaceId: WORKSPACE_ID });

    // A Channel and a Space it is not in yet, so the pair of calls below is
    // the same pair every creation makes for its General placement, driven on
    // its own rather than inside a creation whose other steps re-derive the
    // alarm for their own reasons and hide what this one left.
    const created = await createChannel("settled-placement");
    const reserved = await workspace().reserveSpace({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      space: { name: "Hiring", iconKey: "briefcase", colorKey: "blue", scope: "workspace" },
    });
    if (!reserved.ok) throw new Error(`reserveSpace refused: ${reserved.code}`);
    const spaceId = asSpaceId(reserved.space.id);
    const workstreamId = asWorkstreamId(created.workstream.id);
    await runInDurableObject(workspace(), async (_instance, state) => state.storage.deleteAlarm());

    const plan = await workspace().prepareSpaceMembership({
      workspaceId: WORKSPACE_ID, userId: USER_ID, spaceId, workstreamId,
    });
    if (!plan.ok) throw new Error(`prepareSpaceMembership refused: ${plan.code}`);
    const operationId = `${spaceId}:${workstreamId}:${plan.membershipGeneration}`;

    // The premise: staging the intent arms the object at exactly the instant
    // written on the row, because the resume is what that wake is for.
    const staged = await runInDurableObject(workspace(), async (_instance, state) => ({
      armed: await state.storage.getAlarm(),
      intent: state.storage.sql.exec<{ state: string; not_before: number }>(
        "SELECT state, not_before FROM space_intents WHERE operation_id = ?", operationId,
      ).one(),
    }));
    expect(staged.intent.state).toBe("pending");
    expect(staged.armed).toBe(staged.intent.not_before);

    const settled = await workspace().finalizeSpaceMembership({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      spaceId,
      workstreamId,
      spaceRevision: plan.space.revision,
      membershipGeneration: plan.membershipGeneration,
    });
    if (!settled.ok) throw new Error(`finalizeSpaceMembership refused: ${settled.code}`);

    // And settling has to take it back. `armNextAlarm` is an exact re-derive
    // rather than a lowering, so only running it again drops a wake whose
    // reason has gone; skipping it when this settlement staged no default of
    // its own left every placement with a wake that finds nothing due.
    const after = await runInDurableObject(workspace(), async (_instance, state) => ({
      armed: await state.storage.getAlarm(),
      intent: state.storage.sql.exec<{ state: string }>(
        "SELECT state FROM space_intents WHERE operation_id = ?", operationId,
      ).one(),
    }));
    expect(after.intent.state).toBe("settled");
    expect(after.armed).not.toBe(staged.intent.not_before);
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

describe("a Channel the Slack ingress opens", () => {
  it("is placed in General without reopening the Organization's cutover", async () => {
    // An Organization that has been through the cutover, which is every
    // Organization by the time a Slack message reaches one. The first creation
    // is what opens General, so the Slack path below finds it rather than
    // making it.
    await createChannel("opens-general");
    await workspace().finalizeSpaceBootstrap({ workspaceId: WORKSPACE_ID });
    const before = await workspace().spaceBootstrapStatus({ workspaceId: WORKSPACE_ID });
    expect(before.phase).toBe("complete");

    const created = await new SlackWorkspaceWorkstreamService(creationEnv(), WORKSPACE_ID).create({
      actor: {
        provider: "slack",
        providerAccountId: "T123",
        providerUserId: "U456",
        displayName: "Taylor",
        avatarUrl: null,
      },
      title: "Investigate the alert",
      objective: "Investigate the alert",
      text: "Investigate the alert",
      clientMessageId: "slack:opening",
      creatorUserId: USER_ID,
      slackOrigin: {
        teamId: "T123",
        channelId: "C123",
        channelName: "general",
        threadTs: "123.456",
        invocationType: "app_mention",
        channelType: "public",
        matchedAvalonUserId: USER_ID,
        nearbyMessagesStatus: "available",
        nearbyMessages: [],
        attachments: [],
      },
    });

    // The placement itself, on the Organization's side. This is the assertion
    // the old order could not satisfy: the Channel's own authority had no
    // identity yet when `applySpaceAccessSource` reached it, so the placement
    // was refused and the membership never became active.
    expect(await workspace().channelSpaces({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      workstreamId: asWorkstreamId(created.workstream.id),
    })).toEqual({ spaceIds: [before.generalSpaceId] });

    // And nothing reopened. A refused placement sends the whole Organization
    // back to the walk, which takes `spacesReady` away from every member's
    // sidebar until it finishes — the cost that makes this an ordering bug
    // rather than a slow path.
    expect(await workspace().spaceBootstrapStatus({ workspaceId: WORKSPACE_ID }))
      .toEqual({ ...before, phase: "complete", ready: true });
  });
});
