/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Sidekicks attached to a Canvas, on the real Organization object.
 *
 * A Sidekick a Canvas's Chat makes is attached to that Canvas as it is made;
 * everyone the Canvas admits may change or archive it without being someone
 * it is shared with; a run publishes into any Canvas attached to its Sidekick
 * and into no other; and archiving the Canvas archives the Sidekicks it made
 * and leaves one that was only attached.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asAutomationId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { workspaceDOName } from "../src/durable-objects/names";
import { SCOPE_SHARE_TABLES } from "./helpers/scope-share-tables";

let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000cb000");
const CREATOR = asUserId("00000000-0000-7000-8000-0000000cb001");
/** On the Canvas's participant list; not someone any Sidekick is shared with. */
const PARTICIPANT = asUserId("00000000-0000-7000-8000-0000000cb002");
/** In the Organization, in no Canvas. */
const OUTSIDER = asUserId("00000000-0000-7000-8000-0000000cb003");
let CANVAS_ID = asWorkstreamId("00000000-0000-7000-8000-0000000cb100");
let OTHER_CANVAS_ID = asWorkstreamId("00000000-0000-7000-8000-0000000cb101");
let MADE_HERE = asAutomationId("00000000-0000-7000-8000-0000000cb200");
let MADE_ELSEWHERE = asAutomationId("00000000-0000-7000-8000-0000000cb201");

const member = (userId: string) => ({ userId: asUserId(userId), actorRole: "member" as const });

function workspace(): DurableObjectStub<WorkspaceDO> {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName(env.AVALON_REGION, WORKSPACE_ID)));
}

/** In the object rather than over RPC, so a refusal is the thrown error and not an unhandled remote rejection. */
async function refusal(run: (instance: WorkspaceDO) => Promise<unknown>): Promise<string | null> {
  return runInDurableObject(workspace(), async (instance: WorkspaceDO) => {
    try {
      await run(instance);
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? String(error);
    }
  });
}

function lifecycle(sidekickId: string): Promise<string | undefined> {
  return runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ lifecycle: string }>(
    "SELECT lifecycle FROM automation_directory WHERE automation_id = ?", sidekickId).toArray()[0]?.lifecycle);
}

beforeEach(async () => {
  await reset();
  WORKSPACE_ID = asWorkspaceId(crypto.randomUUID());
  CANVAS_ID = asWorkstreamId(crypto.randomUUID());
  OTHER_CANVAS_ID = asWorkstreamId(crypto.randomUUID());
  MADE_HERE = asAutomationId(crypto.randomUUID());
  MADE_ELSEWHERE = asAutomationId(crypto.randomUUID());
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, abandoned_at TEXT, region TEXT DEFAULT 'global', placement_affinity TEXT DEFAULT 'wnam', analytics_workspace_id TEXT)"),
    env.DB.prepare("INSERT INTO workspaces (id, name) VALUES (?, 'Canvas workspace')").bind(WORKSPACE_ID),
    env.DB.prepare(`CREATE TABLE workspace_members (workspace_id TEXT,user_id TEXT,access_class TEXT,
      role TEXT,status TEXT,incarnation TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      revision INTEGER NOT NULL DEFAULT 1, joined_at TEXT, last_seen_at TEXT, PRIMARY KEY(workspace_id,user_id))`),
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id,user_id,access_class,role,status) VALUES
      (?1,?2,'member','member','active'), (?1,?3,'member','member','active'), (?1,?4,'member','member','active')`)
      .bind(WORKSPACE_ID, CREATOR, PARTICIPANT, OUTSIDER),
    env.DB.prepare("CREATE TABLE users (id TEXT PRIMARY KEY, analytics_person_id TEXT, name TEXT, email TEXT)"),
    env.DB.prepare("INSERT INTO users (id, name) VALUES (?, 'Casey Creator')").bind(CREATOR),
    ...SCOPE_SHARE_TABLES.map((sql) => env.DB.prepare(sql)),
  ]);
  await workspace().canvasCreate({
    workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, title: "Inbox", createdByUserId: CREATOR, authorityGeneration: 1,
  });
  await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(CREATOR),
    update: { visibility: "participants", userIds: [PARTICIPANT] } });
  await workspace().canvasCreate({
    workspaceId: WORKSPACE_ID, canvasId: OTHER_CANVAS_ID, title: "Roadmap", createdByUserId: CREATOR, authorityGeneration: 1,
  });
  // One the Canvas's Chat made, and one made on the Sidekicks page.
  await workspace().sidekickCreate({ workspaceId: WORKSPACE_ID, automationId: MADE_HERE, authorUserId: CREATOR,
    scope: "personal", authorityGeneration: 1, homeCanvasId: CANVAS_ID });
  await workspace().sidekickCreate({ workspaceId: WORKSPACE_ID, automationId: MADE_ELSEWHERE, authorUserId: CREATOR,
    scope: "personal", authorityGeneration: 1 });
});

describe("a Sidekick a Canvas's Chat made", () => {
  it("is attached to that Canvas as it is made, and the Canvas names it to everyone in it", async () => {
    const detail = await workspace().canvasDetail({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(PARTICIPANT) });
    expect(detail.sidekicks).toEqual([{ id: MADE_HERE, name: "New Sidekick", status: "draft", madeHere: true }]);
    // The other Canvas made nothing and holds nothing.
    expect((await workspace().canvasDetail({ workspaceId: WORKSPACE_ID, canvasId: OTHER_CANVAS_ID, actor: member(CREATOR) })).sidekicks)
      .toEqual([]);
    // The Canvas list carries them too, for the home card's Sidekick facepile.
    const listed = await workspace().canvasListFor({ workspaceId: WORKSPACE_ID, userId: PARTICIPANT, accessClass: "member" });
    expect(listed.map((row) => [row.title, row.sidekicks])).toEqual([["Inbox", [{ id: MADE_HERE, name: "New Sidekick" }]]]);
    expect(await workspace().sidekickReadDetail({ workspaceId: WORKSPACE_ID, automationId: MADE_HERE,
      actor: { ...member(CREATOR), participantOfOwningWorkstream: false } })).toMatchObject({ madeInCanvasId: CANVAS_ID });
  });

  it("is not made in a Canvas its author cannot open", async () => {
    const stranger = asAutomationId(crypto.randomUUID());
    expect(await refusal((instance) => instance.sidekickCreate({ workspaceId: WORKSPACE_ID, automationId: stranger,
      authorUserId: OUTSIDER, scope: "personal", authorityGeneration: 1, homeCanvasId: CANVAS_ID }))).toBe("canvas_not_found");
    expect(await lifecycle(stranger)).toBeUndefined();
  });

  it("is managed by everyone in the Canvas, who still cannot open it, and by nobody outside the Canvas", async () => {
    const manages = (sidekickId: string, userId: string) => workspace().sidekickAllowsManager({
      workspaceId: WORKSPACE_ID, automationId: sidekickId, actor: { ...member(userId), participantOfOwningWorkstream: false } });
    expect(await manages(MADE_HERE, PARTICIPANT)).toBe(true);
    expect(await manages(MADE_HERE, OUTSIDER)).toBe(false);
    // One made elsewhere is its author's alone, whoever is in the Canvas.
    expect(await manages(MADE_ELSEWHERE, PARTICIPANT)).toBe(false);
    // Managing is not opening: its conversation and runs stay with the people it is shared with.
    expect(await refusal((instance) => instance.sidekickReadDetail({ workspaceId: WORKSPACE_ID, automationId: MADE_HERE,
      actor: { ...member(PARTICIPANT), participantOfOwningWorkstream: false } }))).toBe("sidekick_not_found");
    expect(await workspace().hostedConversationAuthorizationFacts({ workspaceId: WORKSPACE_ID, parentId: MADE_HERE,
      userId: PARTICIPANT, substreamIds: [] })).toMatchObject({ kind: "automation", author: false, shared: false, executor: false });
  });

  it("stops being managed by someone the Canvas no longer admits", async () => {
    await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(CREATOR),
      update: { visibility: "creator", userIds: [] } });
    expect(await workspace().sidekickAllowsManager({ workspaceId: WORKSPACE_ID, automationId: MADE_HERE,
      actor: { ...member(PARTICIPANT), participantOfOwningWorkstream: false } })).toBe(false);
  });

  it("is archived by a participant, and with its Canvas, while one only attached there is left running", async () => {
    await workspace().attachSidekickConversation({ workspaceId: WORKSPACE_ID, automationId: MADE_ELSEWHERE,
      userId: CREATOR, reference: CANVAS_ID });
    const third = asAutomationId(crypto.randomUUID());
    await workspace().sidekickCreate({ workspaceId: WORKSPACE_ID, automationId: third, authorUserId: CREATOR,
      scope: "personal", authorityGeneration: 1, homeCanvasId: CANVAS_ID });

    await workspace().sidekickRemove({ workspaceId: WORKSPACE_ID, automationId: third,
      actor: { ...member(PARTICIPANT), participantOfOwningWorkstream: false } });
    expect(await lifecycle(third)).toBe("deleted");
    expect(await refusal((instance) => instance.sidekickRemove({ workspaceId: WORKSPACE_ID, automationId: MADE_ELSEWHERE,
      actor: { ...member(PARTICIPANT), participantOfOwningWorkstream: false } }))).toBe("sidekick_forbidden");

    await workspace().canvasArchive({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(CREATOR) });
    expect(await lifecycle(MADE_HERE)).toBe("deleted");
    expect(await lifecycle(MADE_ELSEWHERE)).toBe("draft");
  });
});

describe("where a Sidekick's run may publish", () => {
  const publishInto = (sidekickId: string, canvasId: string) => refusal((instance) => instance.canvasForSidekickRun({
    workspaceId: WORKSPACE_ID, sidekickId, runId: crypto.randomUUID(), canvasId }));

  it("is any Canvas attached to the Sidekick, a person's own Canvas among them, and no other", async () => {
    expect(await publishInto(MADE_HERE, CANVAS_ID)).toBeNull();
    expect(await publishInto(MADE_HERE, OTHER_CANVAS_ID)).toBe("canvas_not_attached_to_sidekick");
    expect(await publishInto(MADE_ELSEWHERE, CANVAS_ID)).toBe("canvas_not_attached_to_sidekick");
    await workspace().attachSidekickConversation({ workspaceId: WORKSPACE_ID, automationId: MADE_ELSEWHERE,
      userId: CREATOR, reference: CANVAS_ID });
    expect(await publishInto(MADE_ELSEWHERE, CANVAS_ID)).toBeNull();
  });

  it("includes the Canvas an earlier run of it made", async () => {
    const runCanvas = asWorkstreamId(crypto.randomUUID());
    await workspace().canvasCreate({ workspaceId: WORKSPACE_ID, canvasId: runCanvas, title: "Digest", createdByUserId: CREATOR,
      authorityGeneration: 1, writer: { sidekickId: MADE_ELSEWHERE, runId: crypto.randomUUID() } });
    expect(await publishInto(MADE_ELSEWHERE, runCanvas)).toBeNull();
    expect(await publishInto(MADE_HERE, runCanvas)).toBe("canvas_not_attached_to_sidekick");
  });

  it("tells a run about the Canvases it was attached to, and only those its person can open", async () => {
    const told = (userId: string) => workspace().sidekickCanvasContext({ workspaceId: WORKSPACE_ID, sidekickId: MADE_HERE, userId });
    expect(await told(CREATOR)).toEqual([{ canvasId: CANVAS_ID, title: "Inbox", artifacts: [] }]);
    expect(await told(OUTSIDER)).toEqual([]);
    // A Canvas each of its own runs made is not repeated to every later run.
    await workspace().canvasCreate({ workspaceId: WORKSPACE_ID, canvasId: asWorkstreamId(crypto.randomUUID()), title: "Run output",
      createdByUserId: CREATOR, authorityGeneration: 1, writer: { sidekickId: MADE_HERE, runId: crypto.randomUUID() } });
    expect((await told(CREATOR)).map((canvas) => canvas.title)).toEqual(["Inbox"]);
  });
});
