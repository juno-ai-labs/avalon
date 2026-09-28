/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Every Channel is born in a Space, and none is published before it is.
 *
 * Both halves need the runtime. The first is two objects agreeing: WorkspaceDO
 * writes the membership, the Channel's parent and directory row, and the
 * Channel's record of which Space reaches it in one transaction, and the
 * conversation opens with the audience that implies.
 *
 * The second is atomicity, and it needs real storage to be worth anything: a
 * refused membership write has to take the parent and its directory row with
 * it, and a failure after the commit has to leave a placement a retry
 * finishes on.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asSpaceId, asUserId, asWorkspaceId, asWorkstreamId, type SpaceId } from "@rally/contracts";

import type { AuthContext, Env } from "../src/env";
import { workspaceDOName } from "../src/durable-objects/names";
import { SlackWorkspaceWorkstreamService } from "../src/services/slack-workspace-workstream-service";
import { WorkstreamObjectCreationService } from "../src/services/workstream-object-creation-service";
import { countingNamespace } from "./helpers/counting-namespace";
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

/** The address allocator needs a key; it is configuration, not behaviour. */
function creationEnv(calls?: string[]): Env {
  return new Proxy(env, {
    get: (current, property, receiver) => property === "WORKSTREAM_EMAIL_ADDRESS_KEY"
      ? "workerd-test-email-address-key-0123456789"
      : property === "WORKSPACE_DOS" && calls
        ? countingNamespace(calls)
        : Reflect.get(current, property, receiver),
  });
}

async function createChannel(clientMessageId: string, spaceIds: SpaceId[] = [], calls?: string[]) {
  return new WorkstreamObjectCreationService(creationEnv(calls), AUTH).createPrepared({
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
    const sources = await workspace().readAccessSources({
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

describe("a creation's Organization-side birth", () => {
  it("is one WorkspaceDO call from the coordinator", async () => {
    // General first, so the creation measured below finds it rather than
    // making it: making General is the one case that takes a second call.
    await createChannel("opens-general");

    const calls: string[] = [];
    await createChannel("counted", [], calls);

    // The staged sequence this replaced was `ensureGeneralSpace`,
    // `prepareSpaceMembership`, `finalizeSpaceMembership`, `reserveChild`,
    // `applySpaceAccessSource` and `flushProvisionalDirectory`: six calls into
    // the same object for one Space.
    expect(calls).toEqual(["reserveChannelInSpaces"]);
  });

  it("writes an active membership with no staging row and no intent to finish it", async () => {
    // Close the cutover first, the way the path that opens a new Organization
    // does. A `pending` one is a derived alarm candidate due at the epoch, and
    // this case reads the alarm.
    await createChannel("opens-general");
    await workspace().finalizeSpaceBootstrap({ workspaceId: WORKSPACE_ID });

    const created = await createChannel("no-intent");
    const workstreamId = created.workstream.id;
    const left = await runInDurableObject(workspace(), async (_instance, state) => ({
      memberships: state.storage.sql.exec<{ state: string; generation: number }>(
        "SELECT state, generation FROM space_channel_memberships WHERE workstream_id = ?", workstreamId,
      ).toArray(),
      intents: state.storage.sql.exec(
        "SELECT operation_id FROM space_intents WHERE workstream_id = ?", workstreamId,
      ).toArray(),
      due: state.storage.sql.exec<{ due: number | null }>(
        "SELECT MIN(not_before) AS due FROM space_intents WHERE state IN ('pending', 'applied')",
      ).one().due,
    }));
    // Nothing for a crash to land between: the row is born active, and no
    // `add` intent was staged, so no resume wake is ever armed for it.
    expect(left.memberships).toEqual([{ state: "active", generation: 1 }]);
    expect(left.intents).toEqual([]);
    expect(left.due).toBeNull();
  });
});

describe("a creation whose Space source cannot be recorded", () => {
  it("publishes no directory row and leaves no placement or parent behind", async () => {
    // One placement first, so General exists and the failure below is about
    // the placement rather than about the Space.
    await createChannel("settles");
    const before = await visibleChannelIds();

    // The way this breaks in production: the last write of the birth, the
    // Channel's record of which Space reaches it, is refused after the
    // membership, the parent row and the directory row were already written.
    // A trigger is how a refusal is made to happen at exactly that statement
    // rather than by stubbing the call that issues it.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        `CREATE TRIGGER fail_source_write BEFORE INSERT ON parent_space_sources
           BEGIN SELECT RAISE(ABORT, 'space source write unavailable'); END`,
      );
    });

    const failure = await createChannel("cannot-place").then(() => null, (error: unknown) => error);
    expect(String(failure)).toMatch(/source write unavailable/u);

    // Nothing new is listable, and nothing is half-written: the membership,
    // the parent's row, the directory row and the source are one transaction,
    // so the refused source took the rest with it.
    expect(await visibleChannelIds()).toEqual(before);
    await runInDurableObject(workspace(), (_instance, state) => {
      const listed = new Set(before);
      const parents = state.storage.sql.exec<{ parent_id: string }>(
        "SELECT parent_id FROM parent_metadata WHERE parent_kind = 'workstream'",
      ).toArray().map((row) => row.parent_id);
      expect(parents.filter((id) => !listed.has(id))).toEqual([]);
      const placed = state.storage.sql.exec<{ workstream_id: string }>(
        "SELECT workstream_id FROM space_channel_memberships",
      ).toArray().map((row) => row.workstream_id);
      expect(placed.filter((id) => !listed.has(id))).toEqual([]);
      state.storage.sql.exec("DROP TRIGGER fail_source_write");
    });
  });
});

describe("a creation that fails after the Organization committed", () => {
  it("keeps the placement, and a retry under the same key finishes on it", async () => {
    await createChannel("opens-general");
    const general = await workspace().spaceBootstrapStatus({ workspaceId: WORKSPACE_ID });

    // The step straight after the reservation fails: the regional route
    // cannot be written. Dropping its table is how D1 refuses that batch.
    await env.DB.prepare("ALTER TABLE workstream_authority_routes RENAME TO routes_offline").run();
    const failure = await createChannel("fails-after-commit").then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    await env.DB.prepare("ALTER TABLE routes_offline RENAME TO workstream_authority_routes").run();

    // The residue the creation prefers: an active placement, the Channel's
    // record of which Space reaches it, and its row in the directory. Nothing
    // was cancelled, because a Channel whose conversation may never open is a
    // better state than one whose placement was taken back under a retry.
    const receipt = await env.DB.prepare(
      "SELECT workstream_id FROM workstream_create_receipts WHERE client_message_id = 'fails-after-commit'",
    ).first<{ workstream_id: string }>();
    const workstreamId = asWorkstreamId(receipt?.workstream_id ?? "");
    expect(await workspace().channelSpaces({ workspaceId: WORKSPACE_ID, userId: USER_ID, workstreamId }))
      .toEqual({ spaceIds: [general.generalSpaceId] });
    const sources = await workspace().readAccessSources({
      workspaceId: WORKSPACE_ID,
      parentId: workstreamId,
      channel: { readers: { scope: "workspace" }, participantUserIds: [USER_ID] },
    });
    expect(sources.spaces.map((source) => source.spaceId)).toEqual([general.generalSpaceId]);

    // The retry reuses the id and settles on the same placement rather than
    // staging a second one.
    const retried = await createChannel("fails-after-commit");
    expect(retried.workstream.id).toBe(workstreamId);
    const memberships = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{
      state: string; generation: number;
    }>("SELECT state, generation FROM space_channel_memberships WHERE workstream_id = ?", workstreamId).toArray());
    expect(memberships).toEqual([{ state: "active", generation: 1 }]);
    expect(await visibleChannelIds()).toContain(workstreamId);
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

  it("inherits the Space's defaults in the same call that places it", async () => {
    const reserved = await workspace().reserveSpace({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      space: { name: "Private", iconKey: "briefcase", colorKey: "blue", scope: "personal" },
    });
    if (!reserved.ok) throw new Error(`reserveSpace refused: ${reserved.code}`);
    const spaceId = asSpaceId(reserved.space.id);
    const sidekickId = "00000000-0000-7000-8000-000000000cc9";
    const added = await workspace().addSpaceDefault({
      workspaceId: WORKSPACE_ID, userId: USER_ID, spaceId, kind: "sidekick", targetId: sidekickId,
    });
    if (!added.ok) throw new Error(`addSpaceDefault refused: ${added.code}`);

    const created = await createChannel("inherits-defaults", [spaceId]);

    // A delivery target for the new member, at the generation its membership
    // was born at: the staging is part of the placement, not a later step.
    const targets = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
      `SELECT kind, target_id, membership_generation FROM space_default_targets
        WHERE space_id = ? AND workstream_id = ?`,
      spaceId,
      created.workstream.id,
    ).toArray());
    expect(targets).toEqual([{ kind: "sidekick", target_id: sidekickId, membership_generation: 1 }]);
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
