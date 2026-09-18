import { admitConnectorAudience, reconcileConnectorWorkstreamCreator } from "../src/services/connector-workstream-audience";
import { ScopeGrantStorage } from "../src/durable-objects/scope-grant-storage";
import { bootstrapWorkstreamRuntimeEnvironment, provisionWorkstreamObject } from "../src/services/workstream-runtime-database";
import { previewSessionImport } from "../src/services/session-import";
import { prepareSessionImport } from "../src/services/session-import-files";
import { withWorkspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
import type { SessionImportPreview } from "@rally/contracts";
import { useOpenRouterDouble } from "./helpers/openrouter-double";
import { useSelectedModel } from "./helpers/selected-model";
/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A work stream is listed the moment it is created.
 *
 * The person who created it is about to open it, and the Worker's visibility
 * checks read the workspace directory, so creation cannot leave the row to the
 * child's first effect and the two Queue hops behind it. `reserveChild` on the
 * parent writes a provisional row into WorkspaceDO synchronously, the one
 * parent-to-workspace RPC the design keeps. This drives the real creation
 * service against real objects and real D1; the test Worker has no Queue
 * consumer, so a row that reaches the workspace can only have come that way.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import type { AuthContext, Env } from "../src/env";
import { conversationObjectName, workspaceDOName, workstreamDOName } from "../src/durable-objects/names";
import { WorkstreamObjectClient } from "../src/services/workstream-object-client";
import { WorkstreamObjectCreationService } from "../src/services/workstream-object-creation-service";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

useSelectedModel();
const provider = useOpenRouterDouble((call) => ({ say: call.body.response_format ? JSON.stringify({ title: "Garden irrigation", icon: "lightbulb" }) : "Continuing the imported conversation." }));

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000bb0");
const USER_ID = asUserId("00000000-0000-7000-8000-000000000bb1");
const SESSION_ID = "00000000-0000-7000-8000-000000000bb2";

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

beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB, {
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    sessionId: SESSION_ID,
  });
  // The regional rows the creation service writes around the object calls:
  // its create receipt, the anchor and route it keys authority on, and the
  // email address it reserves. Column lists follow the checked-in migrations
  // (packages/db/migrations); the foreign keys are left out because nothing
  // here turns on them.
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

/**
 * The test Worker carries no email address key and no session signing key to
 * derive one from; the address allocator needs one, and it is configuration,
 * not behaviour under test.
 */
function creationEnv(): Env {
  return new Proxy(env, {
    get: (current, property, receiver) => property === "WORKSTREAM_EMAIL_ADDRESS_KEY"
      ? "workerd-test-email-address-key-0123456789"
      : property === "OPENROUTER_CLASSIFIER_MODEL" ? "double/naming"
      : Reflect.get(current, property, receiver),
  });
}

describe("creating a work stream", () => {
  it.each([
    { accessClass: "member", creatorAssignment: false },
    { accessClass: "guest", creatorAssignment: false },
    { accessClass: "member", creatorAssignment: true },
    { accessClass: "guest", creatorAssignment: true },
  ])("receipts connector admission for $accessClass (creator=$creatorAssignment) without reviving old access", async ({ accessClass, creatorAssignment }) => {
    const recipient = asUserId(crypto.randomUUID());
    await env.DB.batch([
      env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,status,role,access_class,revision) VALUES (?,?,'active','member',?,1)")
        .bind(WORKSPACE_ID,recipient,accessClass),
      env.DB.prepare("INSERT INTO users(id,email,name,avatar_url,timezone,created_at) VALUES (?,'recipient@example.test','Recipient',NULL,'UTC','2026-09-17T00:00:00.000Z')")
        .bind(recipient),
    ]);
    const created = await new WorkstreamObjectCreationService(creationEnv(), AUTH).createPrepared({
      title: "Connector admission", clientMessageId: "connector-admission", participantUserIds: [],
    }, { messages: [{ role: "user", text: "A prepared start" }] });
    const parentId = asWorkstreamId(created.workstream.id);
    const parent = env.WORKSTREAM_DOS.getByName(workstreamDOName("global", WORKSPACE_ID, parentId));
    const target = { kind: "conversation" as const, workspaceId: WORKSPACE_ID, parentId, substreamId: asSubstreamId("0") };
    expect(await parent.createScopeInvitations({ workspaceId: WORKSPACE_ID, parentId, actorUserId: USER_ID,
      operationId: crypto.randomUUID(), emails: ["recipient@example.test"], expiresAt: null, targets: [target] }))
      .toMatchObject({ status: "created" });
    const input = { workspaceId: WORKSPACE_ID, parentId, eventId: "connector-event-1", userIds: [recipient], addedByUserId: recipient };
    const admit = (eventId: string) => creatorAssignment
      ? reconcileConnectorWorkstreamCreator(creationEnv(), { workspaceId: WORKSPACE_ID, workstreamId: parentId,
        assignmentId: eventId, userId: recipient, previousAssignedUserId: USER_ID, mayCorrectVerifiedCreator: true })
      : admitConnectorAudience(creationEnv(), {
        workspaceId: WORKSPACE_ID, workstreamId: parentId, eventId, userIds: [recipient], addedByUserId: recipient,
      });
    if (creatorAssignment) {
      await runInDurableObject(parent, (_instance,state) => {
        state.storage.sql.exec(`CREATE TRIGGER fail_connector_admission BEFORE INSERT ON connector_participant_admissions
          BEGIN SELECT RAISE(ABORT, 'connector admission unavailable'); END`);
      });
      await expect(admit(input.eventId)).rejects.toThrow("connector admission unavailable");
      const source = env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", WORKSPACE_ID, parentId));
      await runInDurableObject(source, (_instance,state) => {
        expect(state.storage.sql.exec("SELECT created_by_user_id FROM workstream").one()).toEqual({ created_by_user_id: recipient });
        expect(state.storage.sql.exec("SELECT 1 FROM participants WHERE user_id=? AND status='active'",recipient).toArray()).toEqual([]);
      });
      await runInDurableObject(parent, (_instance,state) => { state.storage.sql.exec("DROP TRIGGER fail_connector_admission"); });
    }
    await admit(input.eventId);
    expect(await parent.readScopeAccess({ userId: recipient, target })).toMatchObject({ allowed: accessClass === "member" });
    expect(await parent.readScopeAccess({ userId: recipient, target: { kind: "workstream", workspaceId: WORKSPACE_ID, parentId } }))
      .toMatchObject({ allowed: false });
    if (accessClass === "member") {
      const revision = await runInDurableObject(parent, (_instance,state) =>
        new ScopeGrantStorage(state.storage,target).read(recipient,target)!.revision);
      expect(await parent.mutateScopeGrant({ operationId: crypto.randomUUID(), target, userId: recipient,
        actorUserId: USER_ID, active: false, expectedRevision: revision })).toMatchObject({ status: "committed" });
    } else {
      await env.DB.prepare("UPDATE workspace_members SET access_class='member',revision=2 WHERE user_id=?").bind(recipient).run();
    }
    await admit(input.eventId);
    expect(await parent.readScopeAccess({ userId: recipient, target })).toMatchObject({ allowed: false });
    if (!creatorAssignment) {
      await expect((async () => await parent.admitConnectorParticipants({ ...input, userIds: [USER_ID] }))()).rejects.toThrow("connector_participant_admission_conflict");
    }
    await admit("connector-event-2");
    expect(await parent.readScopeAccess({ userId: recipient, target })).toMatchObject({ allowed: true, writable: true });
    const main = env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", WORKSPACE_ID, parentId));
    await runInDurableObject(main, (_instance,state) => {
      expect(state.storage.sql.exec("SELECT status FROM participants WHERE user_id=?",recipient).one()).toEqual({ status: "active" });
      expect(state.storage.sql.exec("SELECT created_by_user_id FROM workstream").one())
        .toEqual({ created_by_user_id: creatorAssignment ? recipient : USER_ID });
    });
  });

  it.each([
    { systemKind: "digest", owned: true },
    { systemKind: null, owned: true },
    { systemKind: null, owned: false },
  ])("keeps system creation on the local participant writer ($systemKind, owned=$owned)", async ({ systemKind, owned }) => {
    const workstreamId = asWorkstreamId(crypto.randomUUID());
    await bootstrapWorkstreamRuntimeEnvironment(creationEnv(), WORKSPACE_ID, workstreamId, "workstream");
    const input = { workspaceId: WORKSPACE_ID, workstreamId, title: "System workstream", objective: "",
      scope: owned ? "personal" : "workspace", createdByUserId: owned ? USER_ID : null,
      participantUserIds: owned ? [USER_ID] : [], harnessStatus: "idle",
      emailAddress: null, emailRouteStatus: null, systemKind, modelOverride: null, now: Date.now() };
    await provisionWorkstreamObject(creationEnv(), input);
    await provisionWorkstreamObject(creationEnv(), input);
    const main = env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", WORKSPACE_ID, workstreamId));
    await runInDurableObject(main, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT 1 FROM participant_authority_transfer").toArray()).toEqual([]);
      expect(state.storage.sql.exec("SELECT user_id FROM participants WHERE status='active'").toArray())
        .toEqual(owned ? [{ user_id: USER_ID }] : []);
    });
    expect((await new WorkstreamObjectClient(creationEnv(), AUTH, workstreamId).boot()).workstream.title).toBe("System workstream");
  });

  it("keeps creation local and transfers participants only on first sharing", async () => {
    const service = new WorkstreamObjectCreationService(creationEnv(), AUTH);
    const input = { title: "Shared from birth", clientMessageId: "initial-grant-owner", participantUserIds: [] };
    const history = { messages: [{ role: "user" as const, text: "A prepared start" }] };
    const created = await service.createPrepared(input, history);
    const parent = env.WORKSTREAM_DOS.getByName(workstreamDOName("global", WORKSPACE_ID, asWorkstreamId(created.workstream.id)));
    await runInDurableObject(parent, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT 1 FROM main_participant_migration").toArray()).toEqual([]);
    });
    expect((await service.createPrepared(input, history)).workstream.id).toBe(created.workstream.id);
    expect(await parent.createScopeInvitations({ workspaceId: WORKSPACE_ID, parentId: created.workstream.id,
      actorUserId: USER_ID, operationId: crypto.randomUUID(), emails: ["guest@example.test"], expiresAt: null,
      targets: [{ kind: "conversation", workspaceId: WORKSPACE_ID, parentId: created.workstream.id, substreamId: asSubstreamId("0") }] }))
      .toMatchObject({ status: "created" });
    const authority = await runInDurableObject(parent, (_instance, state) => ({
      migration: state.storage.sql.exec("SELECT transfer_id,phase FROM main_participant_migration").one(),
      grants: state.storage.sql.exec("SELECT user_id,scope_kind,json_extract(grant_json,'$.revision') AS revision,json_extract(grant_json,'$.active') AS active FROM scope_grants").toArray(),
    }));
    expect(authority.migration).toMatchObject({ phase: "complete" });
    expect(authority.grants).toEqual([{ user_id: USER_ID, scope_kind: "workstream", revision: 1, active: 1 }]);
    const main = env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", WORKSPACE_ID, created.workstream.id));
    await runInDurableObject(main, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT phase FROM participant_authority_transfer").one()).toEqual({ phase: "projection" });
    });
    expect(await parent.readScopeAccess({ userId: USER_ID, target: { kind: "workstream", workspaceId: WORKSPACE_ID,
      parentId: created.workstream.id } })).toMatchObject({ allowed: true, writable: true });
    expect((await service.createPrepared(input, history)).workstream.id).toBe(created.workstream.id);
    await runInDurableObject(parent, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT transfer_id,phase FROM main_participant_migration").one()).toEqual(authority.migration);
      expect(state.storage.sql.exec("SELECT user_id,scope_kind,json_extract(grant_json,'$.revision') AS revision,json_extract(grant_json,'$.active') AS active FROM scope_grants").toArray()).toEqual(authority.grants);
    });
  });

  it("names prepared history through the standard background naming path without starting a run", async () => {
    const pending: Promise<unknown>[] = [];
    const service = new WorkstreamObjectCreationService(creationEnv(), AUTH, (task) => { pending.push(task); });
    const created = await service.createPrepared({ objective: "Source conversation", clientMessageId: "import-naming", participantUserIds: [] }, {
      messages: [{ role: "user", text: "How should I water my garden?" }, { role: "assistant", text: "Use drip irrigation for the tomatoes." }],
    });
    expect(created.workstream.titleStatus).toBe("naming");
    expect(created.harnessRunId).toBeNull();
    await Promise.all(pending);
    const naming = provider.calls.find((call) => call.body.response_format);
    expect(JSON.stringify(naming?.messages)).toContain("How should I water my garden?");
    expect(JSON.stringify(naming?.messages)).toContain("Use drip irrigation for the tomatoes.");
    const boot = await new WorkstreamObjectClient(creationEnv(), AUTH, created.workstream.id).boot();
    expect(boot.workstream.title).toBe("Garden irrigation");
    expect(boot.workstream.titleStatus).toBe("automatic");
    expect(boot.transcript.ranges.flatMap((range) => range.turns)).toHaveLength(2);
  });

  it("materializes Firecrawl source as idle imported human and assistant turns", async () => {
    const importEnv = withWorkspaceRuntimeDatabase(creationEnv(), WORKSPACE_ID);
    const url = "https://example.com/research-note";
    const preview = await previewSessionImport({ kind: "link", url }, { FIRECRAWL_API_KEY: "test-key" }, async () => Response.json({
      success: true, data: { metadata: { url, statusCode: 200 }, rawHtml: JSON.stringify({ title: "Generated garden", linear_conversation: [
        { message: { author: { role: "user" }, content: { content_type: "text", parts: ["Draw my garden"] } } },
        { message: { author: { role: "assistant" }, content: { content_type: "model_editable_context", model_set_context: "Internal context" } } },
        { message: { author: { role: "tool" }, channel: "final", metadata: { image_gen_title: "Garden.png" }, content: { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer", asset_pointer: "sediment://garden", mime_type: "image/png" }] } } },
      ] }) },
    }));
    const prepared = await prepareSessionImport(importEnv, AUTH, preview, "firecrawl-import");
    const created = await new WorkstreamObjectCreationService(importEnv, AUTH).createPrepared({ title: preview.title, clientMessageId: "firecrawl-import", participantUserIds: [] }, prepared);
    const boot = await new WorkstreamObjectClient(importEnv, AUTH, created.workstream.id).boot();
    const turns = boot.transcript.ranges.flatMap((range) => range.turns);
    expect(turns.map((turn) => turn.actor)).toEqual(["human", "assistant"]);
    expect(JSON.stringify(turns)).toContain("Draw my garden");
    expect(JSON.stringify(turns)).toContain("Unavailable artifact: Garden.png");
    expect(JSON.stringify(turns)).not.toContain("Internal context");
    expect(JSON.stringify(turns)).toContain("imported_session");
    expect(created.harnessRunId).toBeNull();
  });

  it("imports user files and assistant artifacts through upload storage and attaches each to its source turn", async () => {
    const importEnv = withWorkspaceRuntimeDatabase(creationEnv(), WORKSPACE_ID);
    const preview: SessionImportPreview = { title: "Imported files", source: { provider: "claude", url: null }, content: { messages: [
      { role: "user", text: "", files: [{ name: "requirements.txt", mimeType: "text/plain", kind: "attachment", source: { kind: "inline", encoding: "utf8", data: "Keep it simple." } }] },
      { role: "assistant", text: "The artifact", files: [
        { name: "report.html", mimeType: "text/html", kind: "artifact", source: { kind: "inline", encoding: "utf8", data: "<h1>Report</h1>" } },
        { name: "broken.png", mimeType: "image/png", kind: "artifact", source: { kind: "inline", encoding: "base64", data: "%%%" } },
        { name: "missing.png", mimeType: "image/png", kind: "artifact", source: { kind: "unavailable", reference: "file-1", reason: "Login required" } },
      ] },
    ] } };
    const conversation = await prepareSessionImport(importEnv, AUTH, preview, "import-files");
    expect(await prepareSessionImport(importEnv, AUTH, preview, "import-files")).toEqual(conversation);
    await expect(new WorkstreamObjectCreationService(importEnv, AUTH).createPrepared({
      title: preview.title, clientMessageId: "import-files-invalid", participantUserIds: [],
    }, { messages: [conversation.messages[0]!, { ...conversation.messages[1]!, attachmentIds: ["00000000-0000-7000-8000-00000000ffff"] }] })).rejects.toThrow("unavailable");
    expect(await runInDurableObject(workspace(), (_instance, ctx) => ctx.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM pending_attachment_reservations`).one().count)).toBe(0);
    const created = await new WorkstreamObjectCreationService(importEnv, AUTH).createPrepared({
      title: preview.title, clientMessageId: "import-files", participantUserIds: [],
    }, conversation);
    expect(created.workstream.objective).toBe(preview.title);
    const boot = await new WorkstreamObjectClient(importEnv, AUTH, created.workstream.id).boot();
    const turns = boot.transcript.ranges.flatMap((range) => range.turns);
    expect(JSON.stringify(turns[0])).toContain("requirements.txt");
    expect(JSON.stringify(turns[1])).toContain("report.html");
    expect(JSON.stringify(turns[1])).toContain("Login required");
    expect(JSON.stringify(turns[1])).toContain("invalid encoded file bytes");
    const resources = await runInDurableObject(workspace(), (_instance, ctx) => ctx.storage.sql.exec<{ content_ref: string; provider: string }>(`SELECT content_ref, provider FROM resources ORDER BY title`).toArray());
    expect(resources).toHaveLength(2);
    expect(resources.every((resource) => resource.provider === "avalon_upload")).toBe(true);
    const stored = [];
    for (const resource of resources) stored.push(await (await env.PAYLOADS.get(resource.content_ref))!.text());
    expect(stored).toEqual(expect.arrayContaining(["Keep it simple.", "<h1>Report</h1>"]));
    expect((await prepareSessionImport(importEnv, AUTH, preview, "import-files")).messages).toEqual(conversation.messages);
    expect(await new WorkstreamObjectCreationService(importEnv, AUTH).createPrepared({
      title: preview.title, clientMessageId: "import-files", participantUserIds: [],
    }, conversation)).toMatchObject({ turnId: created.turnId, harnessRunId: null });
    const client = new WorkstreamObjectClient(importEnv, AUTH, created.workstream.id);
    const followup = await client.createMessage({ text: "Use the imported files", clientMessageId: "files-followup", mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] });
    const agent = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName("global", WORKSPACE_ID, created.workstream.id)));
    await runDurableObjectAlarm(agent);
    await expect.poll(() => provider.calls.some((call) => JSON.stringify(call.messages).includes("Use the imported files")), { timeout: 20_000 }).toBe(true);
    const request = provider.calls.find((call) => JSON.stringify(call.messages).includes("Use the imported files"))!;
    expect(request.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("requirements.txt"))).toBe(true);
    expect(request.messages.some((message) => message.role === "assistant" && JSON.stringify(message.content).includes("report.html"))).toBe(true);
    await expect.poll(() => runInDurableObject(agent, (_instance, ctx) => ctx.storage.sql.exec<{ status: string }>(`SELECT status FROM runs WHERE trigger_part_id = ?`, followup.turn.turnId).toArray()[0]?.status), { timeout: 20_000 }).toBe("completed");
  });

  it("stores prepared history atomically without admitting a run and replays the receipt", async () => {
    const service = new WorkstreamObjectCreationService(creationEnv(), AUTH);
    const request = { title: "Imported conversation", openingMessage: "", clientMessageId: "import-1", participantUserIds: [], attachmentIds: [] };
    const initialContent = {
      messages: [{ role: "user" as const, text: "Original question", structuredContent: { kind: "imported_session", importedByUserId: USER_ID, importedByName: "Adam", source: { provider: "claude", url: null } } }, { role: "assistant" as const, text: "Original answer" }],
    };
    const created = await service.create(request, { initialization: { kind: "history", conversation: initialContent } });
    expect(created.harnessRunId).toBeNull();
    const client = new WorkstreamObjectClient(creationEnv(), AUTH, created.workstream.id);
    const boot = await client.boot();
    expect(boot.transcript.ranges.flatMap((range) => range.turns).map((turn) => ({ actor: turn.actor, blocks: turn.blocks.map((block) => block.type === "text" ? block.text : block.type) })))
      .toEqual([{ actor: "human", blocks: ["Original question"] }, { actor: "assistant", blocks: ["Original answer"] }]);
    const firstBlock = boot.transcript.ranges.flatMap((range) => range.turns)[0]?.blocks[0];
    expect(firstBlock?.type === "text" ? firstBlock.structuredContent : null).toMatchObject({ kind: "imported_session", importedByUserId: USER_ID });
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName("global", WORKSPACE_ID, created.workstream.id)));
    const state = await runInDurableObject(stub, (_instance, ctx) => ({
      runs: ctx.storage.sql.exec(`SELECT run_id FROM runs`).toArray(),
      root: ctx.storage.sql.exec(`SELECT exact_state, next_attention_ordinal FROM workstream`).one(),
    }));
    expect(state.runs).toEqual([]);
    expect(state.root).toMatchObject({ exact_state: "idle", next_attention_ordinal: 3 });
    expect(await service.create(request, { initialization: { kind: "history", conversation: initialContent } })).toMatchObject({ turnId: created.turnId, harnessRunId: null, workstream: { id: created.workstream.id } });
    await expect(service.create(request, { initialization: { kind: "history", conversation: { ...initialContent, messages: [{ role: "user", text: "Changed" }] } } })).rejects.toThrow("already used");
    expect((await client.boot()).transcript.ranges.flatMap((range) => range.turns)).toHaveLength(2);
    const continuation = await client.createMessage({
      text: "Continue from the original answer", clientMessageId: "import-followup-1",
      mentions: [], confirmedParticipantUserIds: [], attachmentIds: [],
    });
    await runDurableObjectAlarm(stub);
    await expect.poll(() => provider.calls.some((call) => JSON.stringify(call.messages).includes("Continue from the original answer")), { timeout: 20_000 }).toBe(true);
    const call = provider.calls.find((call) => JSON.stringify(call.messages).includes("Continue from the original answer"))!;
    expect(call.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "Original question" }),
      expect.objectContaining({ role: "assistant", content: "Original answer" }),
    ]));
    await expect.poll(() => runInDurableObject(stub, (_instance, ctx) =>
      ctx.storage.sql.exec<{ status: string }>(`SELECT status FROM runs WHERE trigger_part_id = ?`, continuation.turn.turnId).toArray()[0]?.status), { timeout: 20_000 }).toBe("completed");


  });

  it("puts a provisional row in the workspace directory before the child has said anything", async () => {
    const service = new WorkstreamObjectCreationService(creationEnv(), AUTH);
    const created = await service.create({
      title: "Creation fence",
      objective: "Be listed before the first effect lands",
      openingMessage: "Start here",
      clientMessageId: "creation-fence-1",
      participantUserIds: [],
      attachmentIds: [],
      descriptionSource: "authored",
    });
    const workstreamId = created.workstream.id;

    // Version 1 of the parent's projection: the child's first aggregate lands
    // as version 2 and replaces it. (The column CHECKs `waterline > 0`, so the
    // provisional row is 1, not 0.)
    const directory = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{
      workstream_id: string;
      title: string;
      waterline: number;
      authority_generation: number;
      created_by_user_id: string | null;
    }>(
      `SELECT workstream_id, title, waterline, authority_generation, created_by_user_id
         FROM workspace_workstream_directory WHERE workstream_id = ?`,
      workstreamId,
    ).toArray());
    expect(directory).toEqual([{
      workstream_id: workstreamId,
      title: "Creation fence",
      waterline: 1,
      authority_generation: 1,
      created_by_user_id: USER_ID,
    }]);
    const viewer = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{
      is_participant: number;
      waterline: number;
    }>(
      `SELECT is_participant, waterline FROM workspace_workstream_viewers
        WHERE workstream_id = ? AND user_id = ?`,
      workstreamId,
      USER_ID,
    ).toArray());
    expect(viewer).toEqual([{ is_participant: 1, waterline: 1 }]);

    // The same call registered the main conversation with its parent.
    const parent = env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
      workstreamDOName("global", WORKSPACE_ID, asWorkstreamId(workstreamId)),
    ));
    await expect(parent.listChildren({ workspaceId: WORKSPACE_ID, parentId: workstreamId }))
      .resolves.toMatchObject({ children: [{ substreamId: "0", kind: "main" }] });
  });

  it("keeps the provisional visibility fence when recovery wins the deferred-delivery race", async () => {
    const workstreamId = asWorkstreamId("00000000-0000-7000-8000-000000000bb9");
    const now = "2026-09-17T20:00:00.000Z";
    await env.DB.prepare(
      `INSERT INTO workstream_authority_routes
         (workspace_id, workstream_id, generation, object_name, state, stage_index,
          source_cursor, source_fence_sequence, source_hash, target_hash,
          row_counts_json, imported_at, verified_at, activated_at, updated_at)
       VALUES (?, ?, 1, ?, 'verified', 0, 0, 0, 'created_in_do', 'created_in_do',
               '{}', ?, ?, NULL, ?)`,
    ).bind(WORKSPACE_ID, workstreamId, `global:${WORKSPACE_ID}:${workstreamId}`, now, now, now).run();
    const parent = env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
      workstreamDOName("global", WORKSPACE_ID, workstreamId),
    ));
    await parent.reserveChild({
      workspaceId: WORKSPACE_ID,
      parentId: workstreamId,
      substreamId: asSubstreamId("0"),
      kind: "main",
      createdByUserId: USER_ID,
      authorityGeneration: 1,
      deferDirectoryDelivery: true,
      directory: {
        title: "Recovered creation fence",
        description: "Alarm delivery remains direct",
        scope: "personal",
        systemKind: null,
        emailAddress: null,
        titleStatus: "settled",
        createdAt: now,
      },
    });

    await expect.poll(async () => {
      await runDurableObjectAlarm(parent);
      return runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{
        title: string;
        waterline: number;
      }>(
        `SELECT title, waterline FROM workspace_workstream_directory WHERE workstream_id = ?`,
        workstreamId,
      ).toArray());
    }).toEqual([{ title: "Recovered creation fence", waterline: 1 }]);
  });
});
