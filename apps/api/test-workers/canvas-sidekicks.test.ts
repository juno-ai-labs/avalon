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

let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000005d5000");
const CREATOR = asUserId("00000000-0000-7000-8000-0000005d5001");
/** On the Canvas's participant list; not someone any Sidekick is shared with. */
const PARTICIPANT = asUserId("00000000-0000-7000-8000-0000005d5002");
/** A guest of the Organization, on the Canvas's participant list. */
const GUEST = asUserId("00000000-0000-7000-8000-0000005d5004");
/** In the Organization, in no Canvas. */
const OUTSIDER = asUserId("00000000-0000-7000-8000-0000005d5003");
let CANVAS_ID = asWorkstreamId("00000000-0000-7000-8000-0000005d5100");
let OTHER_CANVAS_ID = asWorkstreamId("00000000-0000-7000-8000-0000005d5101");
let MADE_HERE = asAutomationId("00000000-0000-7000-8000-0000005d5200");
let MADE_ELSEWHERE = asAutomationId("00000000-0000-7000-8000-0000005d5201");

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
      (?1,?2,'member','member','active'), (?1,?3,'member','member','active'), (?1,?4,'member','member','active'),
      (?1,?5,'guest',NULL,'active')`)
      .bind(WORKSPACE_ID, CREATOR, PARTICIPANT, OUTSIDER, GUEST),
    env.DB.prepare("CREATE TABLE users (id TEXT PRIMARY KEY, analytics_person_id TEXT, name TEXT, email TEXT)"),
    env.DB.prepare("INSERT INTO users (id, name) VALUES (?, 'Casey Creator')").bind(CREATOR),
    ...SCOPE_SHARE_TABLES.map((sql) => env.DB.prepare(sql)),
  ]);
  // About who may open a private Canvas: new Canvases here are private, not Organization-wide.
  await workspace().saveCanvasSharingDefaults({ workspaceId: WORKSPACE_ID, defaults: { editors: "creator" } });
  await workspace().canvasCreate({
    workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, title: "Inbox", createdByUserId: CREATOR, authorityGeneration: 1,
  });
  await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(CREATOR),
    update: { visibility: "participants", userIds: [PARTICIPANT, GUEST] } });
  await workspace().canvasCreate({
    workspaceId: WORKSPACE_ID, canvasId: OTHER_CANVAS_ID, title: "Roadmap", createdByUserId: CREATOR, authorityGeneration: 1,
  });
  // One the Canvas's Chat made, and one made on the Sidekicks page.
  await workspace().sidekickCreate({ workspaceId: WORKSPACE_ID, automationId: MADE_HERE, authorUserId: CREATOR,
    scope: "personal", authorityGeneration: 1, madeInCanvasId: CANVAS_ID });
  await workspace().sidekickCreate({ workspaceId: WORKSPACE_ID, automationId: MADE_ELSEWHERE, authorUserId: CREATOR,
    scope: "personal", authorityGeneration: 1 });
});


describe("a Sidekick a Canvas's Chat made", () => {
  it("is attached to that Canvas as it is made, and the Canvas names it to everyone in it", async () => {
    const detail = await workspace().canvasDetail({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(PARTICIPANT) });
    // The participant sees it and cannot open it; its creator can.
    expect(detail.sidekicks).toEqual([{ id: MADE_HERE, name: "New Sidekick", status: "draft", madeHere: true, triggerKinds: [], canOpen: false }]);
    expect((await workspace().canvasDetail({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(CREATOR) })).sidekicks)
      .toEqual([{ id: MADE_HERE, name: "New Sidekick", status: "draft", madeHere: true, triggerKinds: [], canOpen: true }]);
    // The other Canvas made nothing and holds nothing.
    expect((await workspace().canvasDetail({ workspaceId: WORKSPACE_ID, canvasId: OTHER_CANVAS_ID, actor: member(CREATOR) })).sidekicks)
      .toEqual([]);
    // The Canvas list carries them too, for the home card's Sidekick facepile.
    const listed = await workspace().canvasListFor({ workspaceId: WORKSPACE_ID, userId: PARTICIPANT, accessClass: "member" });
    expect(listed.map((row) => [row.title, row.sidekicks]))
      .toEqual([["Inbox", [{ id: MADE_HERE, name: "New Sidekick", status: "draft", madeHere: true, triggerKinds: [], canOpen: false }]]]);
    expect(await workspace().sidekickReadDetail({ workspaceId: WORKSPACE_ID, automationId: MADE_HERE,
      actor: { ...member(CREATOR), participantOfOwningWorkstream: false } })).toMatchObject({ madeInCanvasId: CANVAS_ID });
    // And the Sidekick's own row names the Canvas, for its dashboard card's link.
    const library = await workspace().listSidekickDirectoryForAuthorizedMember({ workspaceId: WORKSPACE_ID, userId: CREATOR,
      accessClass: "member", role: "member" });
    expect(library.items.map((item) => [item.id, item.attachedCanvases])).toEqual(expect.arrayContaining([
      [MADE_HERE, [{ id: CANVAS_ID, title: "Inbox", artifactKind: null, appearance: { icon: null, color: null } }]], [MADE_ELSEWHERE, []],
    ]));
  });

  it("keeps attached trigger kinds current without refreshing for instruction-only edits", async () => {
    const addressed = { workspaceId: WORKSPACE_ID, automationId: MADE_HERE };
    const actor = { ...member(CREATOR), participantOfOwningWorkstream: false };
    const draft = {
      definitionVersion: 2 as const, name: "Inbox filler", description: "Files new email", overview: "Keeps the inbox Canvas current",
      instructions: "Add a row for each new email.", requiredCapabilities: [], expectedOutputs: [], defaultBehavior: {},
      recommendedPlugins: [], memoryTables: [], customTools: [], suggestedScope: "personal" as const, followUpQuestion: null, elicitation: null, ready: true,
    };
    const waterline = () => runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ waterline: number }>(
      "SELECT waterline FROM workspace_sidebar_list_state WHERE list = 'canvases'").one().waterline);
    const attached = async () => (await workspace().canvasListFor({ workspaceId: WORKSPACE_ID, userId: PARTICIPANT, accessClass: "member" }))[0]!.sidekicks![0]!;
    await workspace().sidekickSaveDefinition({ ...addressed, actor, evaluatorRules: null, submittedByRunId: null,
      draft: { ...draft, ready: false, triggers: [{ type: "manual" }] } });
    const beforeDraft = await waterline();
    await workspace().sidekickSaveDefinition({ ...addressed, actor, evaluatorRules: null, submittedByRunId: null,
      draft: { ...draft, ready: false, triggers: [{ type: "interval", intervalSeconds: 3600, summary: "Every hour" }] } });
    expect.soft(await attached()).toMatchObject({ triggerKinds: ["schedule"], status: "draft" });
    expect.soft(await waterline()).toBeGreaterThan(beforeDraft);
    await workspace().sidekickSaveDefinition({ ...addressed, actor, evaluatorRules: null, submittedByRunId: null,
      draft: { ...draft, triggers: [{ type: "manual" }] } });
    expect.soft(await attached()).toMatchObject({ triggerKinds: ["manual"], canOpen: false });
    const before = await waterline();
    await workspace().sidekickSaveDefinition({ ...addressed, actor, evaluatorRules: null, submittedByRunId: null,
      draft: { ...draft, triggers: [{ type: "interval", intervalSeconds: 3600, summary: "Every hour" }] } });
    expect.soft(await attached()).toMatchObject({ triggerKinds: ["schedule"], status: "active", canOpen: false });
    expect.soft(await waterline()).toBeGreaterThan(before);
    const detail = await workspace().canvasDetail({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(PARTICIPANT) });
    expect.soft(detail.sidekicks?.[0]?.triggerKinds).toEqual(["schedule"]);
    const beforeInstructions = await waterline();
    await workspace().sidekickSaveDefinition({ ...addressed, actor, evaluatorRules: null, submittedByRunId: null,
      draft: { ...draft, instructions: "Add a row for each new email, including its subject.",
        triggers: [{ type: "interval", intervalSeconds: 3600, summary: "Every hour" }] } });
    expect.soft(await attached()).toMatchObject({ triggerKinds: ["schedule"], status: "active" });
    expect.soft(await waterline()).toBe(beforeInstructions);
  });

  it("carries the actual Canvas mark beyond the sidebar page and refreshes it after appearance and artifact changes", async () => {
    const actor = member(CREATOR);
    await workspace().canvasUpdate({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor,
      appearance: { icon: "flag", color: "orange" } });
    // Fill the actual sidebar page with newer Canvases through the public creation path.
    for (let index = 0; index < 250; index++) {
      await workspace().canvasCreate({ workspaceId: WORKSPACE_ID, canvasId: asWorkstreamId(crypto.randomUUID()),
        title: `Newer ${index}`, createdByUserId: CREATOR, authorityGeneration: 1 });
    }
    const listed = await workspace().canvasListFor({ workspaceId: WORKSPACE_ID, userId: CREATOR, accessClass: "member" });
    expect(listed).toHaveLength(250);
    expect(listed.some((row) => row.id === CANVAS_ID)).toBe(false);
    const attached = async () => (await workspace().listSidekickDirectoryForAuthorizedMember({ workspaceId: WORKSPACE_ID,
      userId: CREATOR, accessClass: "member", role: "member" })).items.find((item) => item.id === MADE_HERE)!.attachedCanvases;
    expect(await attached()).toEqual([{ id: CANVAS_ID, title: "Inbox", artifactKind: null, appearance: { icon: "flag", color: "orange" } }]);
    const waterline = () => runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ waterline: number }>(
      "SELECT waterline FROM workspace_sidebar_list_state WHERE list = 'automations'").one().waterline);
    const beforeAppearance = await waterline();
    await workspace().canvasUpdate({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor,
      appearance: { icon: null, color: "blue" } });
    expect.soft(await waterline()).toBeGreaterThan(beforeAppearance);
    expect(await attached()).toEqual([{ id: CANVAS_ID, title: "Inbox", artifactKind: null, appearance: { icon: null, color: "blue" } }]);

    const resourceId = crypto.randomUUID();
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, metadata_json, attachment_status, created_at, updated_at)
        VALUES (?, ?, 'generated_site', 'avalon_generated', 'Dashboard', '{}', 'attached', ?, ?)`,
      resourceId, WORKSPACE_ID, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    });
    const beforeArtifact = await waterline();
    await workspace().canvasNoteArtifact({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, resourceId, editor: { kind: "rally", id: null } });
    expect.soft(await waterline()).toBeGreaterThan(beforeArtifact);
    expect(await attached()).toEqual([{ id: CANVAS_ID, title: "Inbox", artifactKind: "site", appearance: { icon: null, color: "blue" } }]);
  });

  it("is not made in a Canvas its author cannot open", async () => {
    const stranger = asAutomationId(crypto.randomUUID());
    expect(await refusal((instance) => instance.sidekickCreate({ workspaceId: WORKSPACE_ID, automationId: stranger,
      authorUserId: OUTSIDER, scope: "personal", authorityGeneration: 1, madeInCanvasId: CANVAS_ID }))).toBe("canvas_not_found");
    expect(await lifecycle(stranger)).toBeUndefined();
  });

  it("is not made under an id that names a Canvas", async () => {
    // A Sidekick's row is asked for before a Canvas's, so the id would take the Canvas's conversation over.
    for (const taken of [CANVAS_ID, OTHER_CANVAS_ID]) {
      expect(await refusal((instance) => instance.sidekickCreate({ workspaceId: WORKSPACE_ID, automationId: asAutomationId(taken),
        authorUserId: CREATOR, scope: "personal", authorityGeneration: 1, madeInCanvasId: CANVAS_ID }))).toBe("sidekick_id_unavailable");
    }
    expect((await workspace().canvasDetail({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(CREATOR) })).title).toBe("Inbox");
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

  it("lets a participant change what it does, and archive it", async () => {
    const participant = { ...member(PARTICIPANT), participantOfOwningWorkstream: false };
    const addressed = { workspaceId: WORKSPACE_ID, automationId: MADE_HERE };
    await workspace().sidekickSaveDefinition({ ...addressed, actor: participant, evaluatorRules: null, submittedByRunId: null, draft: {
      definitionVersion: 2, name: "Inbox filler", description: "Files new email", overview: "Keeps the inbox Canvas current",
      instructions: "Add a row for each new email.", triggers: [], requiredCapabilities: [], expectedOutputs: [], defaultBehavior: {},
      recommendedPlugins: [], memoryTables: [], customTools: [], suggestedScope: "personal", followUpQuestion: null, elicitation: null, ready: true,
    } });
    expect(await lifecycle(MADE_HERE)).toBe("active");
    await workspace().sidekickRemove({ ...addressed, actor: participant });
    expect(await lifecycle(MADE_HERE)).toBe("deleted");
  });

  it("is steered by a guest of the Canvas as by a member", async () => {
    const guest = { userId: GUEST, actorRole: null, participantOfOwningWorkstream: false };
    expect(await workspace().sidekickAllowsManager({ workspaceId: WORKSPACE_ID, automationId: MADE_HERE, actor: guest })).toBe(true);
    await workspace().sidekickRemove({ workspaceId: WORKSPACE_ID, automationId: MADE_HERE, actor: guest });
    expect(await lifecycle(MADE_HERE)).toBe("deleted");
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
      scope: "personal", authorityGeneration: 1, madeInCanvasId: CANVAS_ID });

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

/** A run of `sidekickId` as its row records it: one a schedule started, or one `askedBy` asked for and that acts as a delegate. */
async function seedRun(sidekickId: string, askedBy: string | null = null): Promise<string> {
  const runId = crypto.randomUUID();
  const trigger = askedBy === null
    ? { kind: "schedule", scheduleId: crypto.randomUUID(), scheduleKind: "interval", plannedFor: 1 }
    : { kind: "manual", requestedByUserId: askedBy };
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(`INSERT INTO sidekick_runs(sidekick_id, run_id, occurrence_key, trigger_json, definition_revision,
        harness_run_id, state, run_as_user_id, coordinator_user_id, requester_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, 'running', ?, ?, NULL, 1, 1)`,
    sidekickId, runId, `run:${runId}`, JSON.stringify(trigger), `${runId}-harness`, askedBy, askedBy);
  });
  return runId;
}

describe("where a Sidekick's run may publish", () => {
  /** A run a schedule started, said to act as `userId`. */
  const publishInto = async (sidekickId: string, canvasId: string, userId: string = CREATOR) => {
    const runId = await seedRun(sidekickId);
    return refusal((instance) => instance.canvasForSidekickRun({ workspaceId: WORKSPACE_ID, sidekickId, runId, canvasId, userId }));
  };

  it("is any Canvas attached to the Sidekick, a person's own Canvas among them, and no other", async () => {
    expect(await publishInto(MADE_HERE, CANVAS_ID)).toBeNull();
    expect(await publishInto(MADE_HERE, OTHER_CANVAS_ID)).toBe("canvas_not_attached_to_sidekick");
    expect(await publishInto(MADE_ELSEWHERE, CANVAS_ID)).toBe("canvas_not_attached_to_sidekick");
    await workspace().attachSidekickConversation({ workspaceId: WORKSPACE_ID, automationId: MADE_ELSEWHERE,
      userId: CREATOR, reference: CANVAS_ID });
    expect(await publishInto(MADE_ELSEWHERE, CANVAS_ID)).toBeNull();
  });

  it("goes on as the Sidekick itself when a person can no longer open the Canvas, and stops only a run somebody asked for under their own access", async () => {
    expect(await publishInto(MADE_HERE, CANVAS_ID, PARTICIPANT)).toBeNull();
    // A participant who lends the Sidekick nothing asks it for a run: that run acts under their own access.
    const addressed = { workspaceId: WORKSPACE_ID, automationId: MADE_HERE };
    await workspace().sidekickSaveDefinition({ ...addressed, actor: { ...member(CREATOR), participantOfOwningWorkstream: false },
      evaluatorRules: null, submittedByRunId: null, draft: {
        definitionVersion: 2, name: "Inbox filler", description: "Files new email", overview: "Keeps the inbox Canvas current",
        instructions: "Add a row for each new email.", triggers: [{ type: "manual" }], requiredCapabilities: [], expectedOutputs: [],
        defaultBehavior: {}, recommendedPlugins: [], memoryTables: [], customTools: [], suggestedScope: "personal",
        followUpQuestion: null, elicitation: null, ready: true,
      } });
    const routed = await workspace().sidekickAdmitConversationMessage({ ...addressed, actor: member(PARTICIPANT),
      messageId: crypto.randomUUID(), intent: null, authorName: "Participant", text: "Add today's mail." });
    expect(routed).toMatchObject({ route: "run" });
    const asked = (routed as { runId: string }).runId;
    const publishAsked = () => refusal((instance) => instance.canvasForSidekickRun({
      workspaceId: WORKSPACE_ID, sidekickId: MADE_HERE, runId: asked, canvasId: CANVAS_ID }));
    expect(await publishAsked()).toBeNull();

    await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, actor: member(CREATOR),
      update: { visibility: "creator", userIds: [] } });
    // The run that person asked for is held to what they can open now.
    expect(await publishAsked()).toBe("canvas_access_denied");
    // A run nobody asked for reaches the Canvas by the attachment alone: neither a former
    // participant nor someone never in the Canvas takes that away, whoever it is said to act as.
    expect(await publishInto(MADE_HERE, CANVAS_ID, PARTICIPANT)).toBeNull();
    expect(await publishInto(MADE_HERE, CANVAS_ID, OUTSIDER)).toBeNull();
    expect(await publishInto(MADE_HERE, CANVAS_ID, CREATOR)).toBeNull();
  });

  it("holds a run a delegate asked for to what that delegate can open, and never takes an id with no run for the Sidekick itself", async () => {
    const publish = (runId: string, userId: string | null) => refusal((instance) => instance.canvasForSidekickRun({
      workspaceId: WORKSPACE_ID, sidekickId: MADE_HERE, runId, canvasId: CANVAS_ID, userId }));
    // The outsider lends the Sidekick their accounts and asks it for a run. The run acts as them, a
    // delegate, and is still their ask: it does not reach a Canvas they cannot open.
    const askedByOutsider = await seedRun(MADE_HERE, OUTSIDER);
    expect(await publish(askedByOutsider, OUTSIDER)).toBe("canvas_access_denied");
    expect(await publish(await seedRun(MADE_HERE, CREATOR), CREATOR)).toBeNull();
    // A background agent's conversation has an id and no run row: it is held to the person its loop
    // acts as, and reaches nothing with nobody.
    expect(await publish(crypto.randomUUID(), OUTSIDER)).toBe("canvas_access_denied");
    expect(await publish(crypto.randomUUID(), null)).toBe("canvas_access_denied");
    expect(await publish(crypto.randomUUID(), CREATOR)).toBeNull();
    const told = (runId: string, userId: string | null) => workspace().sidekickCanvasContext({
      workspaceId: WORKSPACE_ID, sidekickId: MADE_HERE, userId, runId });
    expect(await told(askedByOutsider, OUTSIDER)).toEqual([]);
    expect(await told(crypto.randomUUID(), null)).toEqual([]);
  });

  it("moves both lists when a Sidekick is attached to a Canvas, since each card names the other", async () => {
    const waterlines = () => runInDurableObject(workspace(), (_instance, state) => Object.fromEntries(state.storage.sql.exec<{ list: string; waterline: number }>(
      "SELECT list, waterline FROM workspace_sidebar_list_state WHERE list IN ('automations', 'canvases')").toArray().map((row) => [row.list, row.waterline])));
    const before = await waterlines();
    await workspace().attachSidekickConversation({ workspaceId: WORKSPACE_ID, automationId: MADE_ELSEWHERE,
      userId: CREATOR, reference: OTHER_CANVAS_ID });
    const after = await waterlines();
    expect([after.automations! > before.automations!, after.canvases! > before.canvases!]).toEqual([true, true]);
    // A repeat attaches nothing and moves neither.
    await workspace().attachSidekickConversation({ workspaceId: WORKSPACE_ID, automationId: MADE_ELSEWHERE,
      userId: CREATOR, reference: OTHER_CANVAS_ID });
    expect(await waterlines()).toEqual(after);
  });

  it("opens a Canvas a run makes to the Organization's default, like one a person makes", async () => {
    await workspace().saveCanvasSharingDefaults({ workspaceId: WORKSPACE_ID, defaults: { editors: "workspace" } });
    const runCanvas = asWorkstreamId(crypto.randomUUID());
    await workspace().canvasCreate({ workspaceId: WORKSPACE_ID, canvasId: runCanvas, title: "Digest", createdByUserId: CREATOR,
      authorityGeneration: 1, writer: { sidekickId: MADE_ELSEWHERE, runId: crypto.randomUUID() } });
    const detail = await workspace().canvasDetail({ workspaceId: WORKSPACE_ID, canvasId: runCanvas, actor: member(CREATOR) });
    expect(detail.visibility).toBe("workspace");
  });

  it("includes the Canvas an earlier run of it made", async () => {
    const runCanvas = asWorkstreamId(crypto.randomUUID());
    await workspace().canvasCreate({ workspaceId: WORKSPACE_ID, canvasId: runCanvas, title: "Digest", createdByUserId: CREATOR,
      authorityGeneration: 1, writer: { sidekickId: MADE_ELSEWHERE, runId: crypto.randomUUID() } });
    expect(await publishInto(MADE_ELSEWHERE, runCanvas)).toBeNull();
    expect(await publishInto(MADE_HERE, runCanvas)).toBe("canvas_not_attached_to_sidekick");
  });

  it("tells a run about every Canvas its Sidekick was attached to, and the wizard only about those its person can open", async () => {
    const told = (userId: string) => workspace().sidekickCanvasContext({ workspaceId: WORKSPACE_ID, sidekickId: MADE_HERE, userId });
    expect(await told(CREATOR)).toEqual([{ canvasId: CANVAS_ID, title: "Inbox", artifacts: [] }]);
    expect(await told(OUTSIDER)).toEqual([]);
    // A run a schedule started is told the Sidekick's attachments whoever it acts as, nobody included.
    for (const userId of [OUTSIDER, null]) {
      expect(await workspace().sidekickCanvasContext({ workspaceId: WORKSPACE_ID, sidekickId: MADE_HERE, userId, runId: await seedRun(MADE_HERE) }))
        .toEqual([{ canvasId: CANVAS_ID, title: "Inbox", artifacts: [] }]);
    }
    // A Canvas each of its own runs made is not repeated to every later run.
    await workspace().canvasCreate({ workspaceId: WORKSPACE_ID, canvasId: asWorkstreamId(crypto.randomUUID()), title: "Run output",
      createdByUserId: CREATOR, authorityGeneration: 1, writer: { sidekickId: MADE_HERE, runId: crypto.randomUUID() } });
    expect((await told(CREATOR)).map((canvas) => canvas.title)).toEqual(["Inbox"]);
  });
});
