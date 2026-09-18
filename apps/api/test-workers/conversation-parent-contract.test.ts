import { pushSearchAuthorization } from '../src/services/search-authorization';
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { WorkstreamDirectoryService } from '../src/services/workstream-directory-service';
import { createResourceObjectPort } from '../src/runtime/resource-port';
import { ResourceService } from '../src/services/resource-service';
import type { WorkstreamDO } from '../src/durable-objects/workstream-do';
import { WorkstreamIdentityStorage } from '../src/durable-objects/workstream-identity-storage';
import { WorkspaceDO } from '../src/durable-objects/workspace-do';
import { SubstreamAgent } from '../src/durable-objects/substream-agent';
import { WorkstreamResourceStorage } from '../src/durable-objects/workstream-resource-storage';
import { createAccessContext } from '../src/services/authorization-service';
import { projectAuthorization } from '../src/services/authorization-projection-service';
import { searchDocumentId } from '../src/services/text-search';

/**
 * The conversation-parent contract, answered by both parents.
 *
 * A `SubstreamAgent` does not decide who may read it or whether it may still
 * be written; its parent does. `WorkstreamDO` answers from the room's scope
 * and participants, `AutomationDO` from the automation's author and scope and,
 * for a room's automation, from the room's participants through WorkspaceDO.
 * Both report an archive rather than folding it into the answer: an archived
 * parent's conversations stay readable and refuse every write, so a child
 * never outlives its parent's archive.
 *
 * The last test drives that rule end to end: the real socket ticket carries
 * the parent's archive into the admission, and the conversation object refuses
 * `create_message` on a socket admitted that way, even though its own row is
 * not archived (the automation's conversation is, by design, never archived
 * on its own; its room was).
 */

import { env } from "cloudflare:workers";
import { holdLoopExecuting } from "./helpers/substream-fixture";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { asAutomationId, asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId, type UserId } from "@rally/contracts";

import { AutomationDO } from "../src/durable-objects/automation-do";
import {
  automationDOName,
  conversationObjectName,
  substreamLoopId,
  workspaceDOName,
  workstreamDOName,
} from "../src/durable-objects/names";
import type { AuthContext, Env } from "../src/env";
import { createAutomation } from "../src/services/automation-service";
import { searchContentHash } from '../src/services/text-search';
import { searchWorkspacePage, searchWorkspace } from '../src/services/workspace-search-service';
import { seedParticipantMessage } from './helpers/substream-fixture';
import { ConversationService } from "../src/services/conversation-service";
import { WorkstreamService } from "../src/services/workstream-service";
import { SubstreamCreationService } from "../src/services/substream-creation-service";
import { SocketService, verifySocketTicket } from "../src/services/socket-service";
import {
  bootstrapConversationChildRuntime,
  bootstrapWorkstreamRuntimeEnvironment,
  provisionWorkstreamObject,
} from "../src/services/workstream-runtime-database";
import { consumeEffectBodies, pendingChildEffects, deliverChildEffects, deliverEffectsToWorkspace, deliverParentEffects } from "./helpers/conversation-effects";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { post, seedWorkspaceControlPlane } from "./helpers/substream-fixture";

/** Its own workspace: object names are shared across files, storage is not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000ad30");
const AUTHOR_ID = asUserId("00000000-0000-7000-8000-00000000ad31");
const MEMBER_ID = asUserId("00000000-0000-7000-8000-00000000ad32");
const PARTICIPANT_ID = asUserId("00000000-0000-7000-8000-00000000ad33");
const SESSION_ID = "00000000-0000-7000-8000-00000000ad34";
const PERSONAL_ROOM_ID = asWorkstreamId("00000000-0000-7000-8000-00000000ad35");
const WORKSPACE_ROOM_ID = asWorkstreamId("00000000-0000-7000-8000-00000000ad36");
const NOW = "2026-08-29T10:00:00.000Z";
const TEST_ENV: Env = env;
// Not a credential: the test Worker declares no signing key, and a ticket has
// to be signed by the same key the upgrade verifies it with.
const SIGNING_KEY = "conversation-parent-contract-test-signing-key";
const SOCKET_FRAME_TIMEOUT_MS = 5_000;

const AUTH: AuthContext = {
  sessionId: SESSION_ID,
  userId: AUTHOR_ID,
  workspaceId: WORKSPACE_ID,
  region: "global",
  role: "member",
};

/** The Worker's environment with the one variable the socket path signs with. */
const socketEnv: Env = new Proxy(env, {
  get: (target, property, receiver) => (
    property === "SESSION_SIGNING_KEY" ? SIGNING_KEY : Reflect.get(target, property, receiver) as unknown
  ),
});

useHeldEffectQueue();

let ordinal = 0;

function nextAutomationId() {
  ordinal += 1;
  return asAutomationId(`00000000-0000-7000-8000-${String(ordinal).padStart(4, "0")}0000ad3f`);
}

function workspaceStub() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
}

function roomParent(roomId: string) {
  return env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
    workstreamDOName("global", WORKSPACE_ID, asWorkstreamId(roomId)),
  ));
}

function conversation(parentId: string, substreamId = "0") {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName("global", WORKSPACE_ID, parentId, asSubstreamId(substreamId)),
  ));
}

function automationStub(automationId: string): DurableObjectStub<AutomationDO> {
  return env.AUTOMATION_DOS.get(env.AUTOMATION_DOS.idFromName(
    automationDOName("global", WORKSPACE_ID, asAutomationId(automationId)),
  ));
}

async function seedRegionalDatabase(): Promise<void> {
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: AUTHOR_ID, sessionId: SESSION_ID });
  await env.DB.batch([
    ...[[MEMBER_ID, "member3@example.com"], [PARTICIPANT_ID, "participant@example.com"]].flatMap(([userId, email]) => [
      env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
        VALUES (?, ?, 'active', 'member', ?)`).bind(WORKSPACE_ID, userId, NOW),
      env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
        VALUES (?, ?, 'Person', NULL, 'UTC', ?)`).bind(userId, email, NOW),
    ]),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT,
      verified_at TEXT, activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL
    )`),
  ]);
}

/**
 * A room made the way creation makes one: the parent reserves the main
 * conversation and puts the provisional directory row in the workspace, the
 * route is written, the conversation object is opened and told what the room
 * is and who is in it, and its first projection reaches the parent and the
 * workspace so every participant is in the workspace's viewer set.
 */
async function seedRoom(roomId: string, scope: "personal" | "workspace", participants: readonly string[]): Promise<void> {
  await roomParent(roomId).reserveChild({
    workspaceId: WORKSPACE_ID,
    parentId: roomId,
    substreamId: asSubstreamId("0"),
    kind: "main",
    createdByUserId: AUTHOR_ID,
    authorityGeneration: 1,
    directory: {
      title: scope === "personal" ? "Private room" : "Open room",
      description: "",
      scope,
      systemKind: null,
      emailAddress: null,
      titleStatus: "settled",
      createdAt: NOW,
    },
  });
  await bootstrapWorkstreamRuntimeEnvironment(TEST_ENV, WORKSPACE_ID, roomId, "workstream");
  await provisionWorkstreamObject(TEST_ENV, {
    workspaceId: WORKSPACE_ID,
    workstreamId: roomId,
    title: scope === "personal" ? "Private room" : "Open room",
    objective: "",
    scope,
    createdByUserId: AUTHOR_ID,
    participantUserIds: [...participants],
    harnessStatus: "idle",
    titleStatus: "settled",
    emailAddress: null,
    emailRouteStatus: null,
    systemKind: null,
    modelOverride: null,
    now: Date.now(),
  });
  await deliverEffectsToWorkspace(TEST_ENV, conversation(roomId));
}

/** Archived through the room's own surface, then both legs so every parent hears it. */
async function archiveRoom(roomId: string): Promise<void> {
  const archived = await post(conversation(roomId), "/internal/product", {
    operation: "update",
    auth: AUTH,
    input: { archived: true },
  });
  expect(archived.status).toBe(200);
  await deliverEffectsToWorkspace(TEST_ENV, conversation(roomId));
}

async function seedAutomation(scope: "personal" | "workspace" | "workstream", owningWorkstreamId: string | null): Promise<string> {
  const automationId = nextAutomationId();
  const created = await createAutomation(TEST_ENV, {
    workspaceId: WORKSPACE_ID,
    authorUserId: AUTHOR_ID,
    scope,
    owningWorkstreamId,
    automationId,
  });
  expect(created.created).toBe(true);
  await deliverParentEffects(TEST_ENV, automationStub(automationId));
  return automationId;
}

/** Delay/observe delivery on the caller side; every fact still comes from the real DO. */
function observeParentReads(observe: () => Promise<void>): Env {
  return { ...TEST_ENV, WORKSTREAM_DOS: new Proxy(TEST_ENV.WORKSTREAM_DOS, {
    get(namespace, key) {
      if (key === 'get') return (...args: Parameters<typeof namespace.get>) => {
        const stub = namespace.get(...args);
        return new Proxy(stub, { get(target, method) {
          if (method === 'readAuthorizationFacts') return async (input: Parameters<WorkstreamDO['readAuthorizationFacts']>[0]) => {
            const facts = await target.readAuthorizationFacts(input);
            await observe();
            return facts;
          };
          const value = Reflect.get(target, method, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      };
      const value = Reflect.get(namespace, key, namespace);
      return typeof value === 'function' ? value.bind(namespace) : value;
    },
  }) };
}

/**
 * A ready private child of `roomId`, made the way creation makes one.
 *
 * Condensed from the long publication test above, which walks every state in
 * between; the tests using this care about what a ready substream then does,
 * not about how it got ready.
 */
async function seedPrivateChild(roomId: string, title: string, operationId: string): Promise<string> {
  const parent = roomParent(roomId);
  const recipe = {
    policy: { revision: "test-empty-v1", strategy: { id: "empty", version: 1 }, config: {} },
    capture: "none" as const,
    parts: [],
  };
  const reserved = await parent.beginPrivateChildPreparation({
    workspaceId: WORKSPACE_ID, parentId: roomId, operationId, creatorUserId: AUTHOR_ID, title,
    sourceSubstreamId: "0" as const, sourceThroughTurnId: null, recipe,
    membershipInitializer: { plugin: { id: "creator-only", version: 1 }, config: {}, memberUserIds: [AUTHOR_ID] },
  });
  const hash = "0".repeat(64);
  await parent.savePreparedPrivateChildContext({
    workspaceId: WORKSPACE_ID, parentId: roomId, operationId,
    preparedContext: {
      schemaVersion: 1, recipe, recipeHash: hash, capture: null, captureHash: null,
      parts: [], contentHash: hash,
    },
  });
  await parent.claimPrivateChildConfirmation({
    workspaceId: WORKSPACE_ID, parentId: roomId, operationId, actorUserId: AUTHOR_ID,
  });
  await bootstrapConversationChildRuntime(TEST_ENV, WORKSPACE_ID, "workstream", roomId, reserved.substreamId);
  await provisionWorkstreamObject(TEST_ENV, {
    workspaceId: WORKSPACE_ID, workstreamId: roomId, substreamId: reserved.substreamId,
    title, objective: "", scope: "personal", createdByUserId: AUTHOR_ID,
    participantUserIds: [AUTHOR_ID], harnessStatus: "idle", titleStatus: "settled", emailAddress: null,
    emailRouteStatus: null, systemKind: null, modelOverride: null, now: Date.now(),
  });
  await conversation(roomId, reserved.substreamId).installPreparedSubstreamContext({
    workspaceId: WORKSPACE_ID, workstreamId: roomId, substreamId: reserved.substreamId, operationId,
  });
  await parent.setPrivateChildTerminalStatus({
    workspaceId: WORKSPACE_ID, parentId: roomId, operationId, status: "ready", errorCode: null,
  });
  await deliverChildEffects(TEST_ENV, conversation(roomId, reserved.substreamId));
  return reserved.substreamId;
}

function viewer(parentId: string, userId: UserId) {
  return { workspaceId: WORKSPACE_ID, parentId, userId };
}

function nextFrameOfType(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${type} frame within ${SOCKET_FRAME_TIMEOUT_MS}ms`)), SOCKET_FRAME_TIMEOUT_MS);
    const onMessage = (event: MessageEvent) => {
      try {
        const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (frame.type !== type) return;
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        resolve(frame);
      } catch {
        // Heartbeats and non-JSON frames are not what this waits for.
      }
    };
    socket.addEventListener("message", onMessage);
  });
}

const originalFetch = globalThis.fetch;
const externalFetch = vi.fn<typeof fetch>();
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

beforeEach(async () => {
  vi.stubGlobal('fetch', externalFetch.mockReset().mockImplementation(originalFetch));
  await reset();
  await seedRegionalDatabase();
  await workspaceStub().initializeWorkspace(WORKSPACE_ID, "wnam");
});

describe("conversation parent contract", () => {
  it('persists workspace Sidekick recommendations idempotently and rejects other scopes', async () => {
    await seedRoom(WORKSPACE_ROOM_ID, 'workspace', [AUTHOR_ID]);
    // Upgrade a populated v12 parent, retaining its roster and identity.
    await runInDurableObject(roomParent(WORKSPACE_ROOM_ID), (_instance, state) => {
      state.storage.sql.exec('DROP TABLE workstream_sidekick_attachments');
      state.storage.sql.exec('DELETE FROM _sql_schema_migrations WHERE version = 13');
    });
    await evictDurableObject(roomParent(WORKSPACE_ROOM_ID));
    const shared = await seedAutomation('workspace', null);
    const personal = await seedAutomation('personal', null);
    const service = new WorkstreamService(TEST_ENV, AUTH);
    await expect(service.sidekickAttachments(shared)).rejects.toMatchObject({
      status: 422, code: 'sidekick_attachment_parent_kind_unsupported',
    });
    await expect(service.sidekickAttachments(shared, personal)).rejects.toMatchObject({
      status: 422, code: 'sidekick_attachment_parent_kind_unsupported',
    });
    const recommendationSyncCount = () => runInDurableObject(workspaceStub(), (_instance, state) =>
      state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM workspace_sync_events WHERE topics_json = '[\"automations\"]'").one().n);
    const beforeAttachSync = await recommendationSyncCount();
    await service.setSidekickRecommendation(WORKSPACE_ROOM_ID, shared, true);
    expect(await recommendationSyncCount()).toBe(beforeAttachSync + 1);
    await service.setSidekickRecommendation(WORKSPACE_ROOM_ID, shared, true);
    expect((await service.recommendedSidekicks(WORKSPACE_ROOM_ID)).items.map((item) => item.id)).toEqual([shared]);
    await expect(service.setSidekickRecommendation(WORKSPACE_ROOM_ID, personal, true)).rejects.toMatchObject({ code: 'sidekick_attachment_scope_invalid' });
    const viewer = new WorkstreamService(TEST_ENV, { ...AUTH, userId: MEMBER_ID });
    await expect(viewer.setSidekickRecommendation(WORKSPACE_ROOM_ID, shared, false)).rejects.toMatchObject({ status: 403, code: 'sidekick_attachment_forbidden' });
    expect((await service.recommendedSidekicks(WORKSPACE_ROOM_ID)).items.map((item) => item.id)).toEqual([shared]);
    await runInDurableObject(roomParent(WORKSPACE_ROOM_ID), async (instance) => {
      await expect(instance.setSidekickRecommendation({ workspaceId: WORKSPACE_ID, parentId: WORKSPACE_ROOM_ID,
        userId: MEMBER_ID, sidekickId: shared, attached: true })).rejects.toThrow('sidekick_attachment_participant_required');
    });
    const beforeDetachSync = await recommendationSyncCount();
    await service.setSidekickRecommendation(WORKSPACE_ROOM_ID, shared, false);
    expect(await recommendationSyncCount()).toBe(beforeDetachSync + 1);
    await service.setSidekickRecommendation(WORKSPACE_ROOM_ID, shared, false);
    expect((await service.recommendedSidekicks(WORKSPACE_ROOM_ID)).items).toEqual([]);
  });
  it('checks workspace membership when refreshing authority from a previously authenticated context', async () => {
    await seedRoom(WORKSPACE_ROOM_ID, 'workspace', [AUTHOR_ID]);
    await env.DB.prepare("UPDATE workspace_members SET status = 'removed' WHERE workspace_id = ? AND user_id = ?")
      .bind(WORKSPACE_ID, AUTHOR_ID).run();
    expect(await createAccessContext(TEST_ENV, AUTH).check({ kind: 'conversation', workspaceId: WORKSPACE_ID,
      parentId: WORKSPACE_ROOM_ID, substreamId: asSubstreamId('0') }))
      .toMatchObject({ status: 'denied', reason: 'workspace_membership_required' });
  });

  it('reads canonical roster evidence before membership projections are delivered', async () => {
    await seedRoom(PERSONAL_ROOM_ID, 'personal', [AUTHOR_ID, MEMBER_ID]);
    await runInDurableObject(conversation(PERSONAL_ROOM_ID), (_instance, state) => {
      state.storage.sql.exec("UPDATE participants SET status = 'removed', removed_at = ? WHERE user_id = ?", Date.now(), MEMBER_ID);
    });
    // The parent still has the previous projection. Fresh authorization must use the child roster.
    expect(await roomParent(PERSONAL_ROOM_ID).authorizeViewer(viewer(PERSONAL_ROOM_ID, MEMBER_ID)))
      .toMatchObject({ authorized: true });
    const access = createAccessContext(TEST_ENV, { ...AUTH, userId: MEMBER_ID });
    const address = { kind: 'conversation' as const, workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID, substreamId: asSubstreamId('0') };
    expect(await access.check(address)).toMatchObject({ status: 'denied', reason: 'not_participant' });
    expect(await createAccessContext(TEST_ENV, AUTH).check(address)).toMatchObject({ status: 'allowed' });
    expect(await access.check({ ...address, substreamId: asSubstreamId('00000000-0000-7000-8000-00000000ad99') }))
      .toMatchObject({ status: 'not_found' });
  });

  it("returns every searchable scope beyond the bounded directory lookup size", async () => {
    await seedRoom(WORKSPACE_ROOM_ID, "workspace", [AUTHOR_ID]);
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      const row = state.storage.sql.exec<Record<string, string | number | null>>(
        "SELECT * FROM workspace_workstream_directory WHERE workstream_id = ?", WORKSPACE_ROOM_ID).one();
      const columns = Object.keys(row);
      for (let i = 0; i < 100; i++) {
        const copy: Record<string, string | number | null> = { ...row, workstream_id: `00000000-0000-7000-8000-${String(i + 1000).padStart(12, '0')}`,
          source_event_id: `search-scope-${i}` };
        state.storage.sql.exec(`INSERT INTO workspace_workstream_directory (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
          ...columns.map((column) => copy[column]!));
      }
    });
    const scopes = await new WorkstreamDirectoryService(TEST_ENV, AUTH).searchableIds();
    expect(scopes).toHaveLength(101);
    expect(scopes).toContain(WORKSPACE_ROOM_ID);
    expect(scopes).toContain('00000000-0000-7000-8000-000000001099');
  });

  it("renders admitted results from the index and never reads a conversation object for content", async () => {
    await seedRoom(PERSONAL_ROOM_ID, "personal", [AUTHOR_ID]);
    await seedRoom(WORKSPACE_ROOM_ID, "workspace", [AUTHOR_ID]);
    const urls = ['https://example.com/one', 'https://example.com/two'];
    const linkIds = await Promise.all(urls.map((url) => searchDocumentId('conversation_links', `${PERSONAL_ROOM_ID}/0/search-turn`, url)));
    // The objects hold none of this text: every rendered field comes back with the candidate.
    const display = { substream_id: '0', archived: false, occurred_at: Date.parse('2026-09-05T00:00:00Z'),
      transcript_sequence: 1, url: null, mime_type: null };
    const message = (id: string, room: string, extra: Record<string, unknown> = {}) => ({ id, source: 'messages', scope_id: room,
      source_id: '0/search-turn', revision: 1, text: `needle from the index ${id}`, title: `Indexed ${id}`, source_label: `Indexed ${id}`,
      ...display, ...extra });
    const rows = [
      message('message-0', PERSONAL_ROOM_ID), message('message-1', WORKSPACE_ROOM_ID),
      ...linkIds.map((id, i) => ({ id, source: 'conversation_links', scope_id: PERSONAL_ROOM_ID, source_id: `0/search-turn/${id}`,
        revision: 1, text: `needle page ${i}`, title: `Page ${i}`, source_label: 'Indexed room', ...display,
        occurred_at: null, transcript_sequence: null, url: urls[i]! })),
      message('message-archived', WORKSPACE_ROOM_ID, { archived: true }),
      // Indexed before the display attributes existed: omitted until its rewrite lands.
      { id: 'message-legacy', source: 'messages', scope_id: WORKSPACE_ROOM_ID, source_id: '0/search-turn', revision: 1, text: 'needle legacy' },
    ];
    const requests: Array<Record<string, unknown>> = [];
    externalFetch.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ rows });
    });
    const contentReads = vi.spyOn(SubstreamAgent.prototype, 'readAdmittedSearchContent');
    const resourceReads = vi.spyOn(WorkspaceDO.prototype, 'resourceSearchRecords');
    const searchEnv = { ...TEST_ENV, TURBO_PUFFER_DEV_API_KEY: 'test-only' };
    const response = await searchWorkspacePage(searchEnv, AUTH, { query: 'needle', category: 'all', pageSize: 7 });
    expect(response.results.map((row) => row.id)).toEqual(['message-0', 'message-1', ...linkIds]);
    expect(response.results[0]).toMatchObject({ title: 'Indexed message-0', excerpt: expect.stringContaining('from the index'),
      occurredAt: '2026-09-05T00:00:00.000Z', location: { kind: 'message', workstreamId: PERSONAL_ROOM_ID, substreamId: '0',
        turnId: 'search-turn', transcriptSequence: 1 } });
    expect(response.results[2]).toMatchObject({ category: 'links', title: 'Page 0', sourceLabel: 'Indexed room',
      location: { kind: 'link', url: urls[0] } });
    expect(contentReads).not.toHaveBeenCalled();
    expect(resourceReads).not.toHaveBeenCalled();
    expect(requests[0]?.include_attributes).toEqual(expect.arrayContaining(['text', 'title', 'archived', 'transcript_sequence']));
    expect(JSON.stringify(requests[0])).not.toContain(JSON.stringify(['scope_id', 'In', [PERSONAL_ROOM_ID, WORKSPACE_ROOM_ID]]));
    // A member outside the personal room is admitted to the open room only, and a
    // pair the projection has never decided is filled after the response, never inside it.
    const memberSession = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`).bind(memberSession, MEMBER_ID, WORKSPACE_ID).run();
    const memberAuth = { ...AUTH, userId: MEMBER_ID, sessionId: memberSession };
    const deferred: Promise<unknown>[] = [];
    const defer = (work: Promise<unknown>) => { deferred.push(work); };
    const first = await searchWorkspacePage(searchEnv, memberAuth, { query: 'needle', category: 'all', pageSize: 7 }, undefined, defer);
    expect(first.results).toEqual([]);
    expect(deferred.length).toBeGreaterThan(0);
    await Promise.all(deferred);
    const filled = await searchWorkspacePage(searchEnv, memberAuth, { query: 'needle', category: 'all', pageSize: 7 }, undefined, defer);
    expect(filled.results.map((row) => row.id)).toEqual(['message-1']);
    // Archiving through the product commits the index's display intent with the change.
    await archiveRoom(WORKSPACE_ROOM_ID);
    await runInDurableObject(conversation(WORKSPACE_ROOM_ID), (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT state FROM durable_outbox WHERE channel = 'search_conversation_v1'`).toArray())
        .toEqual([{ state: 'pending' }]);
    });
  });

  it('keeps inbound email private through the deployed resource reader', async () => {
    const payloadReads = vi.spyOn(env.PAYLOADS, 'get');
    await seedRoom(PERSONAL_ROOM_ID, 'personal', [PARTICIPANT_ID]);
    const resourceId = crypto.randomUUID();
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, metadata_json, attachment_status, created_at, updated_at)
        VALUES (?, ?, 'email', 'resend', 'Private email', '{}', 'attached', ?, ?)`, resourceId, WORKSPACE_ID, NOW, NOW);
    });
    // No lookup may interpret undiscovered attachments as a workspace-wide grant.
    await expect(new ResourceService(TEST_ENV, AUTH).get(resourceId))
      .rejects.toMatchObject({ status: 503, code: 'authorization_unavailable' });
    await runInDurableObject(conversation(PERSONAL_ROOM_ID), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO workstream_resource_links
        (resource_id, attached_by_user_id, watch_enabled, relationship_type, resource_json, attached_at, updated_at)
        VALUES (?, NULL, 0, 'inbound_email', '{}', 1, 1)`, resourceId);
    });
    await createResourceObjectPort(TEST_ENV, WORKSPACE_ID, PERSONAL_ROOM_ID).setWatchEnabled({ resourceId, watchEnabled: 1 });
    await deliverEffectsToWorkspace(TEST_ENV, conversation(PERSONAL_ROOM_ID));
    const projection = { type: 'authorization_projection_v1' as const, region: 'global' as const,
      workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID };
    await projectAuthorization(TEST_ENV, projection);
    await projectAuthorization(TEST_ENV, { ...projection, substreamId: asSubstreamId('0') });
    const outsider = new ResourceService(TEST_ENV, { ...AUTH, userId: MEMBER_ID });
    expect((await outsider.list({ limit: 10 })).items).toEqual([]);
    await expect(outsider.get(resourceId)).rejects.toMatchObject({ status: 404 });
    await expect(outsider.content(resourceId)).rejects.toMatchObject({ status: 404 });
    await expect(outsider.preview(resourceId, new AbortController().signal)).rejects.toMatchObject({ status: 404 });
    expect(payloadReads).not.toHaveBeenCalled();
    const participant = new ResourceService(TEST_ENV, { ...AUTH, userId: PARTICIPANT_ID });
    expect((await participant.list({ limit: 10 })).items).toMatchObject([{ id: resourceId }]);
    await expect(participant.get(resourceId)).resolves.toMatchObject({ id: resourceId, provider: 'resend' });
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      state.storage.sql.exec('UPDATE authorization_inventories SET validated_at = 1');
    });
    await expect(new ResourceService(TEST_ENV, { ...AUTH, userId: MEMBER_ID }).get(resourceId))
      .rejects.toMatchObject({ status: 404 });
    expect(await workspaceStub().authorizationBackfillStatus({ workspaceId: WORKSPACE_ID }))
      .toMatchObject({ complete: true, pendingChildren: 0 });
    expect(await runInDurableObject(workspaceStub(), (_instance, state) =>
      state.storage.sql.exec<{ oldest: number }>('SELECT MIN(validated_at) AS oldest FROM authorization_inventories').one().oldest)).toBe(1);
    // Creating a personal room does not replace its active participant roster.
    await expect(new ResourceService(TEST_ENV, AUTH).get(resourceId)).rejects.toMatchObject({ status: 404 });
  });

  it("starts a new canonical observation when an earlier authorization read is still pending", async () => {
    await seedRoom(PERSONAL_ROOM_ID, "personal", [AUTHOR_ID, PARTICIPANT_ID]);
    let release = () => {};
    let observed = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const observation = new Promise<void>((resolve) => { observed = resolve; });
    let reads = 0;
    const readEnv = observeParentReads(async () => {
      if (++reads === 1) { observed(); await gate; }
    });
    const access = createAccessContext(readEnv, AUTH);
    const address = { kind: 'conversation' as const, workspaceId: WORKSPACE_ID,
      parentId: PERSONAL_ROOM_ID, substreamId: asSubstreamId('0') };
    const first = access.check(address);
    try {
      await observation;
      const removal = await post(conversation(PERSONAL_ROOM_ID), '/internal/product', {
        operation: 'remove_participant', auth: AUTH, userId: AUTHOR_ID,
      });
      expect(removal.status).toBe(200);
      await deliverChildEffects(TEST_ENV, conversation(PERSONAL_ROOM_ID));
      const later = access.check(address);
      // Start the later check before delivering the old observation.
      release();
      expect(await later).toMatchObject({ status: 'denied' });
      expect(reads).toBe(2);
    } finally { release(); await first; }
  });

  it("shares canonical owners within one resource batch and reloads them for the next batch", async () => {
    await seedRoom(PERSONAL_ROOM_ID, "personal", [AUTHOR_ID, PARTICIPANT_ID]);
    const resourceIds = [crypto.randomUUID(), crypto.randomUUID()];
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      for (const id of resourceIds) state.storage.sql.exec(`INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, metadata_json, attachment_status, created_at, updated_at)
        VALUES (?, ?, 'email', 'resend', 'Private email', '{}', 'attached', ?, ?)`, id, WORKSPACE_ID, NOW, NOW);
    });
    await runInDurableObject(conversation(PERSONAL_ROOM_ID), (_instance, state) => {
      for (const id of resourceIds) state.storage.sql.exec(`INSERT INTO workstream_resource_links
        (resource_id, attached_by_user_id, watch_enabled, relationship_type, resource_json, attached_at, updated_at)
        VALUES (?, NULL, 0, 'inbound_email', '{}', 1, 1)`, id);
    });
    const projection = { type: 'authorization_projection_v1' as const, region: 'global' as const,
      workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID };
    await projectAuthorization(TEST_ENV, projection);
    await projectAuthorization(TEST_ENV, { ...projection, substreamId: asSubstreamId('0') });
    let parentReads = 0;
    const readEnv = observeParentReads(async () => { parentReads++; });
    const attachments = vi.spyOn(WorkstreamResourceStorage.prototype, 'readAuthorizationFacts');
    const access = createAccessContext(readEnv, AUTH);
    const addresses = resourceIds.map((resourceId) => ({ kind: 'resource' as const, workspaceId: WORKSPACE_ID, resourceId }));
    expect((await access.checkMany([...addresses, addresses[0]!])).map((decision) => decision.status))
      .toEqual(['allowed', 'allowed', 'allowed']);
    expect(parentReads).toBe(1);
    expect(attachments).toHaveBeenCalledTimes(1);
    expect((await access.checkMany(addresses)).map((decision) => decision.status)).toEqual(['allowed', 'allowed']);
    expect(parentReads).toBe(2);
    expect(attachments).toHaveBeenCalledTimes(2);
  });

  it("stops resource admission at the first valid attachment location", async () => {
    await seedRoom(PERSONAL_ROOM_ID, "personal", [AUTHOR_ID]);
    await seedRoom(WORKSPACE_ROOM_ID, "workspace", [AUTHOR_ID]);
    const id = crypto.randomUUID();
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, metadata_json, attachment_status, created_at, updated_at)
        VALUES (?, ?, 'email', 'resend', 'Shared email', '{}', 'attached', ?, ?)`, id, WORKSPACE_ID, NOW, NOW);
    });
    for (const parentId of [PERSONAL_ROOM_ID, WORKSPACE_ROOM_ID]) {
      await runInDurableObject(conversation(parentId), (_instance, state) => {
        state.storage.sql.exec(`INSERT INTO workstream_resource_links
          (resource_id, attached_by_user_id, watch_enabled, relationship_type, resource_json, attached_at, updated_at)
          VALUES (?, NULL, 0, 'inbound_email', '{}', 1, 1)`, id);
      });
      await projectAuthorization(TEST_ENV, { type: 'authorization_projection_v1', region: 'global',
        workspaceId: WORKSPACE_ID, parentId, substreamId: asSubstreamId('0') });
    }
    let parentReads = 0;
    const attachments = vi.spyOn(WorkstreamResourceStorage.prototype, 'readAuthorizationFacts');
    const access = createAccessContext(observeParentReads(async () => { parentReads++; }), AUTH);
    expect(await access.check({ kind: 'resource', workspaceId: WORKSPACE_ID, resourceId: id })).toMatchObject({ status: 'allowed' });
    expect(parentReads).toBe(1);
    expect(attachments).toHaveBeenCalledTimes(1);
  });

  it("shares automation and inherited identity facts within a resource batch", async () => {
    await seedRoom(PERSONAL_ROOM_ID, "personal", [AUTHOR_ID, PARTICIPANT_ID]);
    const parentId = await seedAutomation("workstream", PERSONAL_ROOM_ID);
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      for (const id of ids) state.storage.sql.exec(`INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, metadata_json, attachment_status, created_at, updated_at)
        VALUES (?, ?, 'email', 'resend', 'Automation email', '{}', 'attached', ?, ?)`, id, WORKSPACE_ID, NOW, NOW);
    });
    await runInDurableObject(conversation(parentId), (_instance, state) => {
      for (const id of ids) state.storage.sql.exec(`INSERT INTO workstream_resource_links
        (resource_id, attached_by_user_id, watch_enabled, relationship_type, resource_json, attached_at, updated_at)
        VALUES (?, NULL, 0, 'inbound_email', '{}', 1, 1)`, id);
    });
    await projectAuthorization(TEST_ENV, { type: 'authorization_projection_v1', region: 'global',
      workspaceId: WORKSPACE_ID, parentId, substreamId: asSubstreamId('0') });
    const automations = vi.spyOn(AutomationDO.prototype, 'readAuthorizationFacts');
    const identities = vi.spyOn(WorkstreamIdentityStorage.prototype, 'readAuthorizationFacts');
    const access = createAccessContext(TEST_ENV, { ...AUTH, userId: PARTICIPANT_ID });
    const addresses = ids.map(resourceId => ({ kind: 'resource' as const, workspaceId: WORKSPACE_ID, resourceId }));
    expect((await access.checkMany(addresses)).map(decision => decision.status)).toEqual(['allowed', 'allowed']);
    expect(automations).toHaveBeenCalledTimes(1);
    expect(identities).toHaveBeenCalledTimes(1);
    expect((await access.checkMany(addresses)).map(decision => decision.status)).toEqual(['allowed', 'allowed']);
    expect(automations).toHaveBeenCalledTimes(2);
    expect(identities).toHaveBeenCalledTimes(2);
  });

  it("trusts projected search admission until the mutation push publishes revocation", async () => {
    await seedRoom(PERSONAL_ROOM_ID, "personal", [AUTHOR_ID, PARTICIPANT_ID]);
    const text = 'needle revocation boundary';
    await runInDurableObject(conversation(PERSONAL_ROOM_ID), async (_instance, state) => {
      await seedParticipantMessage(state, { id: 'hash-turn', sequence: 1, text });
    });
    const generation = await searchContentHash(text);
    const row = { id: 'hash-candidate', source: 'messages', scope_id: PERSONAL_ROOM_ID, source_id: '0/hash-turn', revision: 1, generation,
      text, substream_id: '0', title: 'Private room', source_label: 'Private room', archived: false,
      occurred_at: Date.parse('2026-09-05T00:00:00Z'), transcript_sequence: 1, url: null, mime_type: null };
    externalFetch.mockImplementation(async () => Response.json({ rows: [row] }));
    expect(await searchWorkspace({ ...TEST_ENV, TURBO_PUFFER_DEV_API_KEY: 'test-only' }, AUTH,
      { query: 'needle', category: 'messages' })).toMatchObject([{ id: 'hash-candidate' }]);
    // The revocation commits while the next search's index query is in flight. That
    // request and the one after it still trust the projected decision.
    let revoked = false;
    externalFetch.mockImplementation(async () => {
      if (!revoked) {
        const removal = await post(conversation(PERSONAL_ROOM_ID), '/internal/product', {
          operation: 'remove_participant', auth: AUTH, userId: AUTHOR_ID,
        });
        expect(removal.status).toBe(200);
        await deliverChildEffects(TEST_ENV, conversation(PERSONAL_ROOM_ID));
        revoked = true;
      }
      return Response.json({ rows: [row] });
    });
    expect(await searchWorkspace({ ...TEST_ENV, TURBO_PUFFER_DEV_API_KEY: 'test-only' }, AUTH,
      { query: 'needle', category: 'messages' })).toMatchObject([{ id: 'hash-candidate' }]);
    expect(revoked).toBe(true);
    expect(await searchWorkspace({ ...TEST_ENV, TURBO_PUFFER_DEV_API_KEY: 'test-only' }, AUTH,
      { query: 'needle', category: 'messages' })).toMatchObject([{ id: 'hash-candidate' }]);
    const timingLog = vi.spyOn(console, 'info');
    const mutationAt = Date.now() - 10_000;
    await pushSearchAuthorization({ ...TEST_ENV, LOG_LEVEL: 'info' }, { type: 'search_authorization_push_v1', region: 'global', workspaceId: WORKSPACE_ID,
      target: { kind: 'parent', id: PERSONAL_ROOM_ID }, timing: { mutationAt, enqueuedAt: mutationAt + 2_000 } });
    expect(timingLog).toHaveBeenCalledWith(expect.objectContaining({ event: 'authz_push_timing', outcome: 'completed',
      mutation_at: mutationAt, outbox_ms: 2_000, written_keys: expect.any(Number), store: 'kv' }));
    const timing = timingLog.mock.calls.map(([entry]) => entry).find((entry) => entry.event === 'authz_push_timing');
    expect(timing.mutation_to_write_ack_ms).toBeGreaterThanOrEqual(10_000);
    expect(timing.written_keys).toBeGreaterThan(0);
    timingLog.mockRestore();
    expect(await searchWorkspace({ ...TEST_ENV, TURBO_PUFFER_DEV_API_KEY: 'test-only' }, AUTH,
      { query: 'needle', category: 'messages' })).toEqual([]);
  });

  it("publishes only ready private children to their exact roster and revokes them durably", async () => {
    await seedRoom(PERSONAL_ROOM_ID, "personal", [AUTHOR_ID, PARTICIPANT_ID]);
    const parent = roomParent(PERSONAL_ROOM_ID);
    const recipe = {
      policy: { revision: "test-empty-v1", strategy: { id: "empty", version: 1 }, config: {} },
      capture: "none" as const,
      parts: [],
    };
    const request = {
      workspaceId: WORKSPACE_ID,
      parentId: PERSONAL_ROOM_ID,
      operationId: "private-child-create-1",
      creatorUserId: AUTHOR_ID,
      title: "Private branch",
      sourceSubstreamId: "0" as const,
      sourceThroughTurnId: null,
      recipe,
      membershipInitializer: {
        plugin: { id: "creator-only", version: 1 }, config: {}, memberUserIds: [AUTHOR_ID],
      },
    };
    const reserved = await parent.beginPrivateChildPreparation(request);
    expect((await parent.beginPrivateChildPreparation(request)).substreamId).toBe(reserved.substreamId);
    expect(await parent.authorizeViewer({
      ...viewer(PERSONAL_ROOM_ID, AUTHOR_ID), substreamId: reserved.substreamId,
    })).toEqual({ authorized: false, archived: false, childStatus: "reserved", membershipVersion: 1 });
    expect(await parent.listVisiblePrivateChildren({
      workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID, userId: AUTHOR_ID,
    })).toEqual({ children: [] });

    const hash = "0".repeat(64);
    await parent.savePreparedPrivateChildContext({
      workspaceId: WORKSPACE_ID,
      parentId: PERSONAL_ROOM_ID,
      operationId: request.operationId,
      preparedContext: {
        schemaVersion: 1, recipe, recipeHash: hash, capture: null, captureHash: null, parts: [], contentHash: hash,
      },
    });
    const claimed = await parent.claimPrivateChildConfirmation({
      workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID,
      operationId: request.operationId, actorUserId: AUTHOR_ID,
    });
    expect(claimed.status).toBe("confirming");
    expect((await parent.claimPrivateChildConfirmation({
      workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID,
      operationId: request.operationId, actorUserId: AUTHOR_ID,
    })).substreamId).toBe(claimed.substreamId);
    const cancellationError = await runInDurableObject(parent, async (instance) => {
      try {
        await instance.setPrivateChildTerminalStatus({
          workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID,
          operationId: request.operationId, status: "failed", errorCode: "cancelled",
        });
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(cancellationError).toContain("private_child_confirmation_in_progress");
    const viewerWaterlineBeforeReady = await runInDurableObject(parent, (_instance, state) =>
      state.storage.sql.exec<{ waterline: number }>(
        `SELECT waterline FROM workstream_state_changes WHERE state_key = ? ORDER BY waterline DESC LIMIT 1`,
        `user:${AUTHOR_ID}`,
      ).one().waterline);
    await bootstrapConversationChildRuntime(
      TEST_ENV, WORKSPACE_ID, "workstream", PERSONAL_ROOM_ID, reserved.substreamId,
    );
    await provisionWorkstreamObject(TEST_ENV, {
      workspaceId: WORKSPACE_ID, workstreamId: PERSONAL_ROOM_ID, substreamId: reserved.substreamId,
      title: "Private branch", objective: "", scope: "personal", createdByUserId: AUTHOR_ID,
      participantUserIds: [AUTHOR_ID], harnessStatus: "idle", titleStatus: "settled", emailAddress: null,
      emailRouteStatus: null, systemKind: null, modelOverride: null, now: Date.now(),
    });
    await parent.setPrivateChildTerminalStatus({
      workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID,
      operationId: request.operationId, status: "ready", errorCode: null,
    });
    expect((await parent.claimPrivateChildConfirmation({
      workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID,
      operationId: request.operationId, actorUserId: AUTHOR_ID,
    })).status).toBe("ready");
    // Provider hits deliberately include a private child. The real service,
    // parent authority, child RPC and canonical resource reads decide visibility.
    const searchResourceId = crypto.randomUUID();
    const privateUrl = 'https://example.com/private';
    const privateLinkId = await searchDocumentId('conversation_links', `${PERSONAL_ROOM_ID}/${reserved.substreamId}/search-private-turn`, privateUrl);
    await runInDurableObject(conversation(PERSONAL_ROOM_ID, reserved.substreamId), async (_instance, state) => {
      await seedParticipantMessage(state, { id: 'search-private-turn', sequence: 1, text: `private search phrase ${privateUrl}` });
      state.storage.sql.exec(`INSERT INTO conversation_search_links (id, turn_id, url, label, markdown, captured, deleted, revision)
        VALUES (?, 'search-private-turn', ?, ?, 'private search page', 1, 0, 1)`, privateLinkId, privateUrl, privateUrl);
      state.storage.sql.exec(`INSERT INTO workstream_resource_links
        (resource_id, attached_by_user_id, watch_enabled, relationship_type, resource_json, attached_at, updated_at)
        VALUES (?, NULL, 0, 'attachment', '{}', 1, 1)`, searchResourceId);
    });
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO resources
        (id, workspace_id, resource_type, provider, provider_resource_id, title, mime_type,
         metadata_json, attachment_status, model_content_status, created_at, updated_at)
        VALUES (?, ?, 'file', 'avalon_generated', ?, 'private search artifact', 'text/plain',
          '{}', 'attached', 'ready', ?, ?)`, searchResourceId, WORKSPACE_ID, searchResourceId, NOW, NOW);
    });
    const searchEnv: Env = { ...TEST_ENV, TURBO_PUFFER_DEV_API_KEY: 'test-only' };
    let resourceRevision = await workspaceStub().resourceSearchRevision({ workspaceId: WORKSPACE_ID, resourceId: searchResourceId });
    let source = 'messages';
    let includeVerifiedMessage = false;
    let generation: string | undefined;
    // Every rendered field travels with the candidate; the objects are read for admission only.
    const display = { archived: false, occurred_at: Date.parse('2026-09-05T00:00:00Z'), url: null, mime_type: null };
    const conversationRow = (id: string) => ({ id, source: 'messages', scope_id: PERSONAL_ROOM_ID, substream_id: reserved.substreamId,
      source_id: `${reserved.substreamId}/search-private-turn`, revision: 1, text: `private search phrase ${privateUrl}`,
      title: 'Private room', source_label: 'Private room', transcript_sequence: 1, ...display });
    const candidate = () => {
      if (source === 'messages') return { ...conversationRow('search-candidate'), generation };
      if (source === 'conversation_links') return { ...conversationRow('search-candidate'), generation, source: 'conversation_links',
        source_id: `${reserved.substreamId}/search-private-turn/${privateLinkId}`, text: `${privateUrl}\n${privateUrl}\nprivate search page`,
        title: privateUrl, url: privateUrl, transcript_sequence: null, occurred_at: null };
      return { id: 'search-candidate', source: 'artifacts', generation, scope_id: WORKSPACE_ID, source_id: searchResourceId,
        revision: resourceRevision, text: 'private search artifact', title: 'private search artifact',
        source_label: 'private search artifact', transcript_sequence: null, ...display, mime_type: 'text/plain' };
    };
    externalFetch.mockImplementation(async () => Response.json({ rows: [candidate(),
      ...(includeVerifiedMessage ? [conversationRow('verified-message')] : [])] }));
    try {
      expect(await searchWorkspace(searchEnv, AUTH, { query: 'private search', category: 'messages' }))
        .toMatchObject([{ excerpt: expect.stringContaining('private search phrase') }]);
      expect(await searchWorkspace(searchEnv, { ...AUTH, userId: PARTICIPANT_ID },
        { query: 'private search', category: 'messages' })).toEqual([]);
      // Lexical rows carry no generation hash; one present is not re-validated on the read path.
      generation = await searchContentHash('different private search phrase');
      expect(await searchWorkspace(searchEnv, AUTH, { query: 'private search', category: 'messages' }))
        .toMatchObject([{ excerpt: expect.stringContaining('private search phrase') }]);
      generation = undefined;
      source = 'conversation_links';
      const participantSession = crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
        VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`).bind(participantSession, PARTICIPANT_ID, WORKSPACE_ID).run();
      expect(await searchWorkspace(searchEnv, AUTH, { query: 'private search', category: 'links' }))
        .toMatchObject([{ excerpt: expect.stringContaining('private search page') }]);
      expect(await searchWorkspace(searchEnv, { ...AUTH, userId: PARTICIPANT_ID, sessionId: participantSession },
        { query: 'private search', category: 'links' })).toEqual([]);
      source = 'artifacts';
      // Deployment enables checks without activation; incomplete inventory is retryable, starts
      // discovery, and simply omits the candidate from the page.
      await expect(searchWorkspacePage(searchEnv, AUTH, { query: 'private search', category: 'artifacts' }))
        .resolves.toEqual({ results: [] });
      includeVerifiedMessage = true;
      const mixedPage = await searchWorkspacePage(searchEnv, AUTH, { query: 'private search', category: 'all' });
      expect(mixedPage).toEqual({ results: [expect.objectContaining({ id: 'verified-message' })] });
      includeVerifiedMessage = false;
      const visibleResourceId = crypto.randomUUID();
      await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.sql.exec(`INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, metadata_json, attachment_status, created_at, updated_at)
        VALUES (?, ?, 'document', 'fixture', 'private search visible', '{}', 'attached', ?, ?)`, visibleResourceId, WORKSPACE_ID, NOW, NOW).toArray());
      const resourcePage = await new ResourceService(TEST_ENV, AUTH).list({ query: 'private search', limit: 10 });
      expect(resourcePage).toMatchObject({ complete: false, items: [{ id: visibleResourceId }] });
      const initialProjection = { type: 'authorization_projection_v1' as const, region: 'global' as const,
        workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID };
      await projectAuthorization(TEST_ENV, initialProjection);
      await projectAuthorization(TEST_ENV, { ...initialProjection, substreamId: asSubstreamId('0') });
      const partial = await workspaceStub().authorizationBackfillStatus({ workspaceId: WORKSPACE_ID });
      expect(partial).toMatchObject({ pendingParents: 0, pendingChildren: 1, complete: false });
      await expect(searchWorkspacePage(searchEnv, AUTH, { query: 'private search', category: 'artifacts' }))
        .resolves.toEqual({ results: [] });
      expect(await workspaceStub().authorizationBackfillStatus({ workspaceId: WORKSPACE_ID })).toEqual(partial);
      await projectAuthorization(TEST_ENV, { ...initialProjection, substreamId: reserved.substreamId });
      // The queue publishes completed discovery; the next search never performs that owner walk.
      await pushSearchAuthorization(TEST_ENV, { type: 'search_authorization_push_v1', region: 'global',
        workspaceId: WORKSPACE_ID, target: { kind: 'resource', id: searchResourceId } });
      resourceRevision = await workspaceStub().resourceSearchRevision({ workspaceId: WORKSPACE_ID, resourceId: searchResourceId });
      expect(await searchWorkspace(searchEnv, AUTH, { query: 'private search', category: 'artifacts' }))
        .toMatchObject([{ title: 'private search artifact' }]);
      expect(await searchWorkspace(searchEnv, { ...AUTH, userId: PARTICIPANT_ID },
        { query: 'private search', category: 'artifacts' })).toEqual([]);
      generation = await searchContentHash('different private search artifact');
      expect(await searchWorkspace(searchEnv, AUTH, { query: 'private search', category: 'artifacts' }))
        .toMatchObject([{ title: 'private search artifact' }]);
      // Run the actual reference-only backfill, then verify the exact-path reader.
      await workspaceStub().beginAuthorizationBackfill({ workspaceId: WORKSPACE_ID });
      const projection = { type: 'authorization_projection_v1' as const, region: 'global' as const,
        workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID };
      await projectAuthorization(TEST_ENV, projection);
      for (const substreamId of [asSubstreamId('0'), reserved.substreamId]) {
        await projectAuthorization(TEST_ENV, { ...projection, substreamId });
      }
      generation = undefined;
      source = 'messages';
      expect(await searchWorkspace(searchEnv, AUTH, { query: 'private search', category: 'messages' })).toHaveLength(1);
      source = 'artifacts';
      // Discovery may flush a pending source projection; model the external index catching up.
      resourceRevision = await workspaceStub().resourceSearchRevision({ workspaceId: WORKSPACE_ID, resourceId: searchResourceId });
      expect(await searchWorkspace(searchEnv, AUTH, { query: 'private search', category: 'artifacts' })).toHaveLength(1);
      expect(await searchWorkspace(searchEnv, AUTH, { query: 'private search', category: 'artifacts' })).toHaveLength(1);
      expect(await searchWorkspace(searchEnv, { ...AUTH, userId: PARTICIPANT_ID }, { query: 'private search', category: 'artifacts' })).toEqual([]);
    } finally { vi.unstubAllGlobals(); }

    // The same exact-child grant must survive provider-specific email loading.
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      state.storage.sql.exec("UPDATE resources SET provider = 'resend', resource_type = 'email' WHERE id = ?", searchResourceId);
    });
    await expect(new ResourceService(TEST_ENV, AUTH).get(searchResourceId)).resolves.toMatchObject({ id: searchResourceId });
    const mixed = await createAccessContext(TEST_ENV, AUTH).checkMany([
      { kind: 'resource', workspaceId: WORKSPACE_ID, resourceId: searchResourceId },
      { kind: 'conversation', workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID, substreamId: reserved.substreamId },
    ]);
    expect(mixed.map((decision) => decision.status)).toEqual(['allowed', 'allowed']);

    const viewerWaterlineAfterReady = await runInDurableObject(parent, (_instance, state) =>
      state.storage.sql.exec<{ waterline: number }>(
        `SELECT waterline FROM workstream_state_changes WHERE state_key = ? ORDER BY waterline DESC LIMIT 1`,
        `user:${AUTHOR_ID}`,
      ).one().waterline);
    expect(viewerWaterlineAfterReady).toBe(viewerWaterlineBeforeReady);
    expect(await runInDurableObject(parent, (_instance, state) =>
      state.storage.sql.exec<{ waterline: number }>(
        `SELECT waterline FROM workstream_state_changes WHERE state_key = ? ORDER BY waterline DESC LIMIT 1`,
        `children:${AUTHOR_ID}`,
      ).one().waterline)).toBeGreaterThan(0);
    await deliverChildEffects(TEST_ENV, conversation(PERSONAL_ROOM_ID, reserved.substreamId));
    const parentTitle = await runInDurableObject(parent, (_instance, state) =>
      state.storage.sql.exec<{ title: string }>(`SELECT title FROM workstream_metadata WHERE id = 1`).one().title);
    expect(parentTitle).toBe("Private room");

    expect(await parent.authorizeViewer({
      ...viewer(PERSONAL_ROOM_ID, AUTHOR_ID), substreamId: reserved.substreamId,
    })).toEqual({ authorized: true, archived: false, childStatus: "ready", membershipVersion: 1 });
    expect((await parent.listVisiblePrivateChildren({
      workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID, userId: AUTHOR_ID,
    })).children).toEqual([expect.objectContaining({ substreamId: reserved.substreamId, title: "Private branch" })]);
    expect((await parent.listVisiblePrivateChildren({
      workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID, userId: PARTICIPANT_ID,
    })).children).toEqual([]);
    expect(await parent.authorizeViewer(viewer(PERSONAL_ROOM_ID, PARTICIPANT_ID)))
      .toEqual({ authorized: true, archived: false });

    await parent.addPrivateChildParticipant({
      workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID, substreamId: reserved.substreamId,
      actorUserId: AUTHOR_ID, userId: PARTICIPANT_ID, operationId: "private-child-add-participant",
    });
    expect(await parent.addPrivateChildParticipant({
      workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID, substreamId: reserved.substreamId,
      actorUserId: AUTHOR_ID, userId: PARTICIPANT_ID, operationId: "private-child-add-participant",
    })).toMatchObject({ outcome: "unchanged", membershipVersion: 1 });
    expect(await parent.authorizeViewer({
      ...viewer(PERSONAL_ROOM_ID, PARTICIPANT_ID), substreamId: reserved.substreamId,
    })).toMatchObject({ authorized: true, membershipVersion: 1 });

    const staleAuthorTicket = await new ConversationService(socketEnv, AUTH)
      .socketTicket(PERSONAL_ROOM_ID, reserved.substreamId);
    const preRemovalTicket = await new ConversationService(socketEnv, AUTH)
      .socketTicket(PERSONAL_ROOM_ID, reserved.substreamId);
    expect((await verifySocketTicket(socketEnv, staleAuthorTicket.ticket)).admission)
      .toMatchObject({ membershipVersion: 1 });
    await parent.removePrivateChildParticipant({
      workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID, substreamId: reserved.substreamId,
      actorUserId: PARTICIPANT_ID, userId: AUTHOR_ID, operationId: "private-child-remove-author",
    });
    const staleUpgrade = await new SocketService(socketEnv).upgrade(
      PERSONAL_ROOM_ID, reserved.substreamId, staleAuthorTicket.ticket,
      new Request(`https://api.test/socket/conversations/${PERSONAL_ROOM_ID}/${reserved.substreamId}`, {
        headers: { Upgrade: "websocket", Origin: "app://avalon" },
      }),
    );
    expect(staleUpgrade.status).toBe(403);
    await parent.addPrivateChildParticipant({
      workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID, substreamId: reserved.substreamId,
      actorUserId: PARTICIPANT_ID, userId: AUTHOR_ID, operationId: "private-child-readd-author",
    });
    const readdedUpgrade = await new SocketService(socketEnv).upgrade(
      PERSONAL_ROOM_ID, reserved.substreamId, preRemovalTicket.ticket,
      new Request(`https://api.test/socket/conversations/${PERSONAL_ROOM_ID}/${reserved.substreamId}`, {
        headers: { Upgrade: "websocket", Origin: "app://avalon" },
      }),
    );
    expect(readdedUpgrade.status).toBe(403);

    const removedFromParent = await post(conversation(PERSONAL_ROOM_ID), "/internal/product", {
      operation: "remove_participant", auth: AUTH, userId: PARTICIPANT_ID,
    });
    expect(removedFromParent.status).toBe(200);
    await deliverChildEffects(TEST_ENV, conversation(PERSONAL_ROOM_ID));
    expect(await parent.authorizeViewer({
      ...viewer(PERSONAL_ROOM_ID, PARTICIPANT_ID), substreamId: reserved.substreamId,
    })).toMatchObject({ authorized: false });
    await parent.removePrivateChildParticipant({
      workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID, substreamId: reserved.substreamId,
      actorUserId: AUTHOR_ID, userId: PARTICIPANT_ID, operationId: "private-child-remove-participant",
    });
    expect(await parent.authorizeViewer({
      ...viewer(PERSONAL_ROOM_ID, PARTICIPANT_ID), substreamId: reserved.substreamId,
    })).toMatchObject({ authorized: false });
    expect((await parent.listVisiblePrivateChildren({
      workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID, userId: PARTICIPANT_ID,
    })).children).toEqual([]);

    const mirror = await runInDurableObject(conversation(PERSONAL_ROOM_ID, reserved.substreamId), (_instance, state) =>
      state.storage.sql.exec<{ active: number; version: number }>(
        `SELECT active, version FROM private_child_membership_authority WHERE user_id = ?`, PARTICIPANT_ID,
      ).one());
    expect(mirror).toEqual({ active: 0, version: 2 });
  });

  it("archives a substream out of every member's sidebar, refuses its writes, and restores it whole", async () => {
    await seedRoom(PERSONAL_ROOM_ID, "personal", [AUTHOR_ID, PARTICIPANT_ID, MEMBER_ID]);
    const parent = roomParent(PERSONAL_ROOM_ID);
    const substreamId = await seedPrivateChild(PERSONAL_ROOM_ID, "Private branch", "archive-child");
    await parent.addPrivateChildParticipant({
      workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID, substreamId: asSubstreamId(substreamId),
      actorUserId: AUTHOR_ID, userId: PARTICIPANT_ID, operationId: "archive-child-add",
    });
    const address = {
      workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID, substreamId: asSubstreamId(substreamId),
    };
    const listed = async (userId: UserId): Promise<number> => (await parent.listVisiblePrivateChildren({
      workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID, userId,
    })).children.length;
    expect(await listed(AUTHOR_ID)).toBe(1);
    expect(await listed(PARTICIPANT_ID)).toBe(1);

    // Main access alone cannot archive somebody else's private child.
    const refusal = await runInDurableObject(parent, async (instance) => {
      try { await instance.setPrivateChildArchived({ ...address, actorUserId: MEMBER_ID, archived: true }); }
      catch (error) { return String(error); }
      return null;
    });
    expect(refusal).toContain("private_child_participant_required");
    const child = conversation(PERSONAL_ROOM_ID, substreamId);
    await runInDurableObject(child, (_instance, state) => {
      holdLoopExecuting(state, { loopId: substreamLoopId(PERSONAL_ROOM_ID, asSubstreamId(substreamId)) });
    });
    // Any participant may archive the shared child.
    expect(await parent.setPrivateChildArchived({ ...address, actorUserId: PARTICIPANT_ID, archived: true }))
      .toMatchObject({ outcome: "archived", archivedAt: expect.any(Number) });
    await runInDurableObject(child, (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT archived_at FROM workstream WHERE id = 1`).one())
        .toMatchObject({ archived_at: expect.any(Number) });
      expect(state.storage.sql.exec(`SELECT stop_requested_at, stop_reason FROM substream_loops WHERE id = 1`).one())
        .toMatchObject({ stop_requested_at: expect.any(Number), stop_reason: "workstream_archived" });
    });
    expect(await listed(AUTHOR_ID)).toBe(0);
    expect(await listed(PARTICIPANT_ID)).toBe(0);
    // Still admitted, and now reported archived — which is what refuses the
    // writes and the socket ticket, through the same path a work stream's own
    // archive already takes.
    expect(await parent.authorizeViewer({
      ...viewer(PERSONAL_ROOM_ID, AUTHOR_ID), substreamId: asSubstreamId(substreamId),
    })).toMatchObject({ authorized: true, archived: true });
    await expect(new ConversationService(TEST_ENV, AUTH).writableClient(PERSONAL_ROOM_ID, substreamId))
      .rejects.toMatchObject({ code: "conversation_parent_archived" });
    await expect(new ConversationService(socketEnv, AUTH).socketTicket(PERSONAL_ROOM_ID, substreamId))
      .rejects.toMatchObject({ code: "conversation_not_found" });
    // A roster cannot drift while the substream is out of sight. Called on the
    // instance rather than through the stub so the refusal is caught here
    // instead of surfacing as an unhandled RPC rejection.
    const lateAdd = await runInDurableObject(parent, async (instance) => {
      try {
        await instance.addPrivateChildParticipant({
          ...address, actorUserId: AUTHOR_ID, userId: MEMBER_ID, operationId: "archive-child-late-add",
        });
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(lateAdd).toContain("private_child_archived");
    expect(await parent.setPrivateChildArchived({ ...address, actorUserId: AUTHOR_ID, archived: true }))
      .toMatchObject({ outcome: "unchanged" });

    expect(await parent.setPrivateChildArchived({ ...address, actorUserId: AUTHOR_ID, archived: false }))
      .toMatchObject({ outcome: "restored", archivedAt: null });
    // An older retry must not re-archive a restored child.
    await child.applyPrivateChildLifecycle({ ...address, version: 1, archivedAt: Date.now() });
    await runInDurableObject(child, (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT archived_at FROM workstream WHERE id = 1`).one()).toEqual({ archived_at: null });
    });
    expect(await listed(AUTHOR_ID)).toBe(1);
    expect(await listed(PARTICIPANT_ID)).toBe(1);
    await expect(new ConversationService(TEST_ENV, AUTH).writableClient(PERSONAL_ROOM_ID, substreamId))
      .resolves.toBeDefined();
  });

  it("refuses messages on a child socket opened before the child was archived", async () => {
    await seedRoom(PERSONAL_ROOM_ID, "personal", [AUTHOR_ID]);
    const substreamId = await seedPrivateChild(PERSONAL_ROOM_ID, "Live branch", "archive-open-child");
    const issued = await new ConversationService(socketEnv, AUTH).socketTicket(PERSONAL_ROOM_ID, substreamId);
    const response = await new SocketService(socketEnv).upgrade(PERSONAL_ROOM_ID, substreamId, issued.ticket, new Request(
      `https://api.test/socket/conversations/${PERSONAL_ROOM_ID}/${substreamId}`,
      { headers: { Upgrade: "websocket", Origin: "app://avalon" } },
    ));
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    try {
      await roomParent(PERSONAL_ROOM_ID).setPrivateChildArchived({ workspaceId: WORKSPACE_ID,
        parentId: PERSONAL_ROOM_ID, substreamId: asSubstreamId(substreamId), actorUserId: AUTHOR_ID, archived: true });
      const failed = nextFrameOfType(socket, "client_command_failed");
      socket.send(JSON.stringify({ type: "create_message", operationId: "00000000-0000-7000-8000-00000000ad3f",
        payload: { clientMessageId: "archived-child-write", text: "Still there?" } }));
      expect(await failed).toMatchObject({ command: "create_message", clientMessageId: "archived-child-write",
        error: { status: 409, code: "substream_archived" } });
    } finally {
      socket.close(1000, "done");
    }
  });

  it("says what to do when somebody is not in the work stream the substream belongs to", async () => {
    // The refusal a real add hits first, and the reason it is worth naming:
    // unmapped, the parent's error reached the dialog as an anonymous 500, so
    // the only way to learn that a substream member must already be in the
    // work stream was to read the Worker's log.
    await seedRoom(PERSONAL_ROOM_ID, "personal", [AUTHOR_ID, PARTICIPANT_ID]);
    const substreamId = await seedPrivateChild(PERSONAL_ROOM_ID, "Private branch", "refusal-child");
    await expect(new SubstreamCreationService(TEST_ENV, AUTH).changeParticipant(
      PERSONAL_ROOM_ID, substreamId,
      { userId: MEMBER_ID, operationId: "refusal-child-add" }, true,
    )).rejects.toMatchObject({
      status: 409,
      code: "substream_member_needs_workstream_access",
      message: "Add this person to the work stream before adding them to a substream.",
    });
  });

  it("renames a substream through the conversation that owns its title", async () => {
    await seedRoom(PERSONAL_ROOM_ID, "personal", [AUTHOR_ID, PARTICIPANT_ID]);
    const parent = roomParent(PERSONAL_ROOM_ID);
    const substreamId = await seedPrivateChild(PERSONAL_ROOM_ID, "Private branch", "rename-child");
    const client = await new ConversationService(TEST_ENV, AUTH).writableClient(PERSONAL_ROOM_ID, substreamId);
    await client.update({ title: "Intermediate branch" });
    await client.update({ title: "Renamed branch" });
    // Queue delivery can arrive out of order. An older title must not replace
    // the latest child title, even when its receipt is new to the parent.
    const effects = await pendingChildEffects(conversation(PERSONAL_ROOM_ID, substreamId));
    for (const envelope of effects.sort((left, right) => right.sourceVersion - left.sourceVersion)) {
      expect(await consumeEffectBodies(TEST_ENV, [envelope])).toMatchObject({ retried: 0 });
    }
    expect((await parent.listVisiblePrivateChildren({
      workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID, userId: AUTHOR_ID,
    })).children).toEqual([expect.objectContaining({ substreamId, title: "Renamed branch" })]);
    // And the parent's own title is untouched by its child's rename.
    expect(await runInDurableObject(parent, (_instance, state) =>
      state.storage.sql.exec<{ title: string }>(`SELECT title FROM workstream_metadata WHERE id = 1`).one().title,
    )).toBe("Private room");
  });

  it("WorkstreamDO admits the creator of a personal room before the child's first effect arrives", async () => {
    // What creation looks like from the desktop's side: `POST /workstreams`
    // returns and the client opens the room at once. The parent has reserved
    // the main conversation and nothing else; the child's `directory_user`
    // effect, the only writer of the per-user projection, is still on the
    // Queue. The creator must be readable in that window, and nobody else.
    await roomParent(PERSONAL_ROOM_ID).reserveChild({
      workspaceId: WORKSPACE_ID,
      parentId: PERSONAL_ROOM_ID,
      substreamId: asSubstreamId("0"),
      kind: "main",
      createdByUserId: AUTHOR_ID,
      authorityGeneration: 1,
      directory: {
        title: "Private room",
        description: "",
        scope: "personal",
        systemKind: null,
        emailAddress: null,
        titleStatus: "settled",
        createdAt: NOW,
      },
    });

    expect(await roomParent(PERSONAL_ROOM_ID).authorizeViewer(viewer(PERSONAL_ROOM_ID, AUTHOR_ID)))
      .toEqual({ authorized: true, archived: false });
    expect(await roomParent(PERSONAL_ROOM_ID).authorizeViewer(viewer(PERSONAL_ROOM_ID, PARTICIPANT_ID)))
      .toEqual({ authorized: false, archived: false });

    // Once the child reports its participants, its word replaces the
    // creator's standing: the creator was removed from this room.
    await bootstrapWorkstreamRuntimeEnvironment(TEST_ENV, WORKSPACE_ID, PERSONAL_ROOM_ID, "workstream");
    await provisionWorkstreamObject(TEST_ENV, {
      workspaceId: WORKSPACE_ID,
      workstreamId: PERSONAL_ROOM_ID,
      title: "Private room",
      objective: "",
      scope: "personal",
      createdByUserId: AUTHOR_ID,
      participantUserIds: [PARTICIPANT_ID],
      harnessStatus: "idle",
      titleStatus: "settled",
      emailAddress: null,
      emailRouteStatus: null,
      systemKind: null,
      modelOverride: null,
      now: Date.now(),
    });
    await deliverEffectsToWorkspace(TEST_ENV, conversation(PERSONAL_ROOM_ID));

    expect(await roomParent(PERSONAL_ROOM_ID).authorizeViewer(viewer(PERSONAL_ROOM_ID, PARTICIPANT_ID)))
      .toEqual({ authorized: true, archived: false });
    expect(await roomParent(PERSONAL_ROOM_ID).authorizeViewer(viewer(PERSONAL_ROOM_ID, AUTHOR_ID)))
      .toEqual({ authorized: false, archived: false });
  });

  it("WorkstreamDO admits a personal room's participants and every member of a workspace room", async () => {
    await seedRoom(PERSONAL_ROOM_ID, "personal", [AUTHOR_ID, PARTICIPANT_ID]);
    await seedRoom(WORKSPACE_ROOM_ID, "workspace", [AUTHOR_ID]);

    expect(await roomParent(PERSONAL_ROOM_ID).authorizeViewer(viewer(PERSONAL_ROOM_ID, AUTHOR_ID)))
      .toEqual({ authorized: true, archived: false });
    expect(await roomParent(PERSONAL_ROOM_ID).authorizeViewer(viewer(PERSONAL_ROOM_ID, PARTICIPANT_ID)))
      .toEqual({ authorized: true, archived: false });
    expect(await roomParent(PERSONAL_ROOM_ID).authorizeViewer(viewer(PERSONAL_ROOM_ID, MEMBER_ID)))
      .toEqual({ authorized: false, archived: false });
    expect(await roomParent(WORKSPACE_ROOM_ID).authorizeViewer(viewer(WORKSPACE_ROOM_ID, MEMBER_ID)))
      .toEqual({ authorized: true, archived: false });
    expect(await roomParent(PERSONAL_ROOM_ID).authority({ workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID }))
      .toEqual({ exists: true, authorityGeneration: 1, archived: false });
    expect(await roomParent(PERSONAL_ROOM_ID).listChildren({ workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID }))
      .toEqual({ children: [{ substreamId: "0", kind: "main", createdAt: expect.any(Number) }] });

    await archiveRoom(PERSONAL_ROOM_ID);

    // Reported, not folded in: an archived room is still its participants' to read.
    expect(await roomParent(PERSONAL_ROOM_ID).authorizeViewer(viewer(PERSONAL_ROOM_ID, AUTHOR_ID)))
      .toEqual({ authorized: true, archived: true });
    expect(await roomParent(PERSONAL_ROOM_ID).authority({ workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID }))
      .toEqual({ exists: true, authorityGeneration: 1, archived: true });
  });

  it("AutomationDO admits the author, every member of a workspace automation, and a room automation's participants", async () => {
    await seedRoom(PERSONAL_ROOM_ID, "personal", [AUTHOR_ID, PARTICIPANT_ID]);
    const personal = await seedAutomation("personal", null);
    const shared = await seedAutomation("workspace", null);
    const owned = await seedAutomation("workstream", PERSONAL_ROOM_ID);

    expect(await automationStub(personal).authorizeViewer(viewer(personal, AUTHOR_ID)))
      .toEqual({ authorized: true, archived: false });
    expect(await automationStub(personal).authorizeViewer(viewer(personal, MEMBER_ID)))
      .toEqual({ authorized: false, archived: false });
    expect(await automationStub(shared).authorizeViewer(viewer(shared, MEMBER_ID)))
      .toEqual({ authorized: true, archived: false });
    // The room's automation is the room's: a participant who never wrote it
    // may open it, a member outside the room may not.
    expect(await automationStub(owned).authorizeViewer(viewer(owned, PARTICIPANT_ID)))
      .toEqual({ authorized: true, archived: false });
    expect(await automationStub(owned).authorizeViewer(viewer(owned, MEMBER_ID)))
      .toEqual({ authorized: false, archived: false });
    expect(await automationStub(owned).listChildren({ workspaceId: WORKSPACE_ID, parentId: owned }))
      .toEqual({ children: [{ substreamId: "0", kind: "main", createdAt: expect.any(Number) }] });

    // Archiving the room archives its automation's conversations; deleting an
    // automation archives its own. The author still reads, with the archive
    // reported. A participant who never wrote it does not: WorkspaceDO's
    // participation predicate answers false for an archived room, so the
    // automation's room-scope answer closes with the room. That is what the
    // object does today; whether a former participant should keep reading a
    // finished room's automation, as they keep reading the room itself, is a
    // product decision this assertion exists to surface rather than settle.
    const address = { kind: 'conversation' as const, workspaceId: WORKSPACE_ID, parentId: owned, substreamId: asSubstreamId('0') };
    expect(await createAccessContext(TEST_ENV, { ...AUTH, userId: PARTICIPANT_ID }).check(address)).toMatchObject({ status: 'allowed' });
    await archiveRoom(PERSONAL_ROOM_ID);
    // Archiving the owning room removes inherited automation access; its author still reads.
    expect(await createAccessContext(TEST_ENV, { ...AUTH, userId: PARTICIPANT_ID }).check(address)).toMatchObject({ status: 'denied' });
    expect(await createAccessContext(TEST_ENV, AUTH).check(address)).toMatchObject({ status: 'allowed' });
    expect(await automationStub(owned).authorizeViewer(viewer(owned, AUTHOR_ID)))
      .toEqual({ authorized: true, archived: true });
    expect(await automationStub(owned).authorizeViewer(viewer(owned, PARTICIPANT_ID)))
      .toEqual({ authorized: false, archived: true });
    expect(await automationStub(owned).authority({ workspaceId: WORKSPACE_ID, parentId: owned }))
      .toEqual({ exists: true, authorityGeneration: 1, archived: true });
    await automationStub(personal).remove({
      workspaceId: WORKSPACE_ID,
      automationId: personal,
      actor: { userId: AUTHOR_ID, actorRole: "member", participantOfOwningWorkstream: false },
    });
    expect(await automationStub(personal).authorizeViewer(viewer(personal, AUTHOR_ID)))
      .toEqual({ authorized: false, archived: true });
    expect(await automationStub(personal).authority({ workspaceId: WORKSPACE_ID, parentId: personal }))
      .toEqual({ exists: true, authorityGeneration: 1, archived: true });
  });

  it("carries a parent's archive into the socket admission, and the conversation then refuses a write", async () => {
    await seedRoom(PERSONAL_ROOM_ID, "personal", [AUTHOR_ID]);
    const owned = await seedAutomation("workstream", PERSONAL_ROOM_ID);
    const service = new ConversationService(socketEnv, AUTH);

    const live = await verifySocketTicket(socketEnv, (await service.socketTicket(owned)).ticket);
    expect(live).toMatchObject({ parentKind: "automation", parentId: owned, substreamId: "0" });
    expect(live.admission?.parentArchived).toBe(false);

    await archiveRoom(PERSONAL_ROOM_ID);

    const issued = await service.socketTicket(owned);
    const archived = await verifySocketTicket(socketEnv, issued.ticket);
    expect(archived.admission?.parentArchived).toBe(true);

    // The upgrade the Worker performs with that ticket, against the real
    // conversation object, which admits the reader and refuses the write.
    const response = await new SocketService(socketEnv).upgrade(owned, "0", issued.ticket, new Request(
      `https://api.test/socket/conversations/${owned}/0?ticket=${encodeURIComponent(issued.ticket)}`,
      { headers: { Upgrade: "websocket", Origin: "app://avalon" } },
    ));
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("the upgrade carried no socket");
    socket.accept();
    try {
      const failed = nextFrameOfType(socket, "client_command_failed");
      socket.send(JSON.stringify({
        type: "create_message",
        operationId: "00000000-0000-7000-8000-00000000ad3e",
        payload: { clientMessageId: "archived-parent-write", text: "Still there?" },
      }));
      expect(await failed).toMatchObject({
        command: "create_message",
        clientMessageId: "archived-parent-write",
        error: { status: 409, code: "conversation_parent_archived" },
      });
    } finally {
      socket.close(1000, "done");
    }
    const written = await runInDurableObject(conversation(owned), (_instance, state) =>
      state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM canonical_conversation_turn_details WHERE client_message_id = 'archived-parent-write'`,
      ).one().count);
    expect(written).toBe(0);
  });
});
