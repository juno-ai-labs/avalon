/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { asSpaceId, asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from '@rally/contracts';
import { CreateMessageIssueSchema } from '@rally/contracts/message-issues';
import issueMigration from '../../../packages/db/message-issue-migrations/0001_message_issues.sql?raw';
import type { AuthContext, Env } from '../src/env';
import { MessageIssueService } from '../src/services/message-issue-service';
import { conversationObjectName, workspaceDOName } from '../src/durable-objects/names';
import { bootstrapConversationChildRuntime, bootstrapWorkstreamRuntimeEnvironment, provisionWorkstreamObject } from '../src/services/workstream-runtime-database';
import { seedParticipantMessage, seedWorkspaceControlPlane } from './helpers/substream-fixture';
import { deliverEffectsToWorkspace } from './helpers/conversation-effects';
import { hostedParentStub } from './helpers/hosted-parent';
import { useHeldEffectQueue } from './helpers/effect-queue-hold';
import { SpaceService } from '../src/services/space-service';
import { WorkstreamTranscriptStorage } from '../src/durable-objects/workstream-transcript-storage';
import { placeMembership } from './helpers/space-membership';
import { WorkspaceSpaceStorage } from '../src/durable-objects/workspace-space-storage';

let WORKSPACE_ID = asWorkspaceId('00000000-0000-7000-8000-00000000db10');
let WORKSTREAM_ID = asWorkstreamId('00000000-0000-7000-8000-00000000db13');
const CREATOR_ID = asUserId('00000000-0000-7000-8000-00000000db11');
const OTHER_ID = asUserId('00000000-0000-7000-8000-00000000db12');
const SESSION_ID = '00000000-0000-7000-8000-00000000db14';
const TEST_ENV: Env = env;
const creatorAuth: AuthContext = { sessionId: SESSION_ID, userId: CREATOR_ID, workspaceId: WORKSPACE_ID, region: 'global', role: 'owner' };
const otherAuth: AuthContext = { ...creatorAuth, userId: OTHER_ID, sessionId: 'other-session' };
let fixtureOrdinal = 0;
useHeldEffectQueue();
function parent() { return hostedParentStub(env, WORKSPACE_ID); }
function conversation(substreamId = '0') {
  return env.SUBSTREAM_AGENTS.getByName(conversationObjectName('global', WORKSPACE_ID, WORKSTREAM_ID, asSubstreamId(substreamId)));
}
function request(messageId = 'source-turn-1', substreamId = '0') {
  return CreateMessageIssueSchema.parse({ id: crypto.randomUUID(), target: { kind: 'conversation', parentId: WORKSTREAM_ID, substreamId },
    messageId, blockId: `${messageId}:text:0`, description: 'I expected the correct answer.' });
}
beforeEach(async () => {
  // An old object's deferred effects can outlive reset(). Give each fixture
  // distinct named authorities so those drains cannot write into its successor.
  fixtureOrdinal += 1;
  const suffix = String(fixtureOrdinal).padStart(4, "0");
  WORKSPACE_ID = asWorkspaceId(`00000000-0000-7000-8000-${suffix}0000db10`);
  WORKSTREAM_ID = asWorkstreamId(`00000000-0000-7000-8000-${suffix}0000db13`);
  creatorAuth.workspaceId = WORKSPACE_ID;
  otherAuth.workspaceId = WORKSPACE_ID;
  await reset();
  await env.MESSAGE_ISSUES_DB.exec(issueMigration.replace(/--[^\n]*\n/g, "").replace(/\s*\n\s*/g, " "));
  await seedWorkspaceControlPlane(env.DB, {
    workspaceId: WORKSPACE_ID,
    userId: CREATOR_ID,
    sessionId: SESSION_ID,
  });
  await env.DB.prepare("ALTER TABLE workspaces ADD COLUMN placement_affinity TEXT NOT NULL DEFAULT 'wnam'").run();
  await env.WORKSPACE_DOS.getByName(workspaceDOName("global", WORKSPACE_ID))
    .initializeWorkspace(WORKSPACE_ID, "wnam");
  await env.DB.batch([
    env.DB.prepare(`ALTER TABLE workspaces ADD COLUMN name TEXT DEFAULT 'Test workspace'`),
    env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(otherAuth.sessionId, OTHER_ID, WORKSPACE_ID),
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', '2026-09-04T00:00:00.000Z')`).bind(WORKSPACE_ID, OTHER_ID),
    env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
      VALUES (?, 'other@example.com', 'Other', NULL, 'UTC', '2026-09-04T00:00:00.000Z')`).bind(OTHER_ID),
    env.DB.prepare(`CREATE TABLE workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0
    )`),
    // Bootstrap reads it to refuse a Space or Sidekick id a Channel create claimed.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_create_receipts (
      workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id)
    )`),
    env.DB.prepare(`CREATE TABLE workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT,
      verified_at TEXT, activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL
    )`),
  ]);
  await parent().reserveChild({
    workspaceId: WORKSPACE_ID,
    parentId: WORKSTREAM_ID,
    substreamId: asSubstreamId("0"),
    kind: "main",
    createdByUserId: CREATOR_ID,
    authorityGeneration: 1,
    directory: {
      title: "Source", description: "", scope: "workspace", systemKind: null,
      emailAddress: null, titleStatus: "settled", createdAt: "2026-09-04T00:00:00.000Z",
    },
  });
  await bootstrapWorkstreamRuntimeEnvironment(TEST_ENV, WORKSPACE_ID, WORKSTREAM_ID, "workstream");
  await provisionWorkstreamObject(TEST_ENV, {
    workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, title: "Source", objective: "",
    scope: "workspace", createdByUserId: CREATOR_ID, participantUserIds: [CREATOR_ID],
    harnessStatus: "idle", titleStatus: "settled", emailAddress: null, emailRouteStatus: null,
    systemKind: null, modelOverride: null, now: Date.now(),
  });
  await deliverEffectsToWorkspace(TEST_ENV, conversation());

}, 30_000);

async function seedSourceTurn(): Promise<void> {
  await runInDurableObject(conversation(), async (_instance, state) => seedParticipantMessage(state, {
    id: "source-turn-1", sequence: 1, text: "The source decision", authorUserId: CREATOR_ID,
    attentionOrdinal: 1, now: Date.now(),
  }));
}

describe('message issue reports on real workerd', () => {
  it('stores user and assistant reports in the dedicated D1 database and replays the same receipt', async () => {
    await seedSourceTurn();
    await runInDurableObject(conversation(), async (_instance, state) => seedParticipantMessage(state, {
      id: 'assistant-turn', sequence: 2, text: 'An answer', authorType: 'agent', now: 42,
    }));
    const service = new MessageIssueService(env, creatorAuth);
    const user = request();
    const receipt = await service.create(user);
    expect(await service.create(user)).toEqual(receipt);
    await service.create(request('assistant-turn'));
    const rows = (await env.MESSAGE_ISSUES_DB.prepare('SELECT * FROM message_issues ORDER BY message_id').all()).results;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ workspace_id: WORKSPACE_ID, reporter_user_id: CREATOR_ID,
      message_id: 'assistant-turn', thread_id: WORKSTREAM_ID, breakout_id: null, substream_id: '0',
      description: 'I expected the correct answer.', parent_kind: 'workstream' });
    expect(JSON.parse(String(rows[0]!.metadata_json))).toMatchObject({ authorType: 'agent', messageCreatedAt: 42,
      blockId: 'assistant-turn:text:0', sequenceNumber: 2 });
    expect(JSON.parse(String(rows[1]!.metadata_json))).toMatchObject({ authorType: 'human', authorUserId: CREATOR_ID });
    expect((await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'message_issues'").all()).results).toEqual([]);
    await expect(service.create({ ...user, description: 'Changed description' })).rejects.toMatchObject({ code: 'message_issue_id_conflict' });
  });

  it('stores visible system-authored opening instructions and Sidekick results, excluding internal events', async () => {
    await runInDurableObject(conversation(), async (_instance, state) => {
      const transcript = new WorkstreamTranscriptStorage(state.storage);
      for (const [index, message] of [
        { id: 'opening', messageType: 'system' as const, structured: { kind: 'agent_message' } },
        { id: 'sidekick', messageType: 'automation_activation' as const, structured: null },
        { id: 'internal', messageType: 'system' as const, structured: { kind: 'agent_message' } },
      ].entries()) {
        await transcript.appendParticipantMessage({
          turnId: message.id, actor: 'system', authorUserId: null, authorSnapshot: null,
          clientMessageId: message.id, messageType: message.messageType, text: 'An authored result',
          structuredContentJson: JSON.stringify(message.structured), producedByRunId: null,
          messageSequenceNumber: index + 1, createdAtUtc: '2026-10-22T00:00:00.000Z', attentionOrdinal: null,
        });
      }
    });
    const service = new MessageIssueService(env, creatorAuth);
    await service.create(request('opening'));
    await service.create(request('sidekick'));
    await expect(service.create(request('internal'))).rejects.toMatchObject({ code: 'message_issue_message_not_found' });
    expect((await env.MESSAGE_ISSUES_DB.prepare('SELECT message_id FROM message_issues ORDER BY message_id').all()).results)
      .toEqual([{ message_id: 'opening' }, { message_id: 'sidekick' }]);
  });

  it('retains private-only placement and follows canonical ordering across multiple Channels', async () => {
    await seedSourceTurn();
    const workspace = env.WORKSPACE_DOS.getByName(workspaceDOName('global', WORKSPACE_ID));
    const service = new MessageIssueService(env, creatorAuth);
    for (const [index, id] of ['00000000-0000-7000-8000-00000000db20',
      '00000000-0000-7000-8000-00000000db21', '00000000-0000-7000-8000-00000000db19'].entries()) {
      const spaceId = asSpaceId(id);
      const result = await workspace.reserveSpace({ workspaceId: WORKSPACE_ID, userId: CREATOR_ID, spaceId,
        space: { name: 'Placed Channel', iconKey: 'briefcase', colorKey: 'blue', scope: 'workspace' } });
      expect(result.ok).toBe(true);
      if (index === 0) await runInDurableObject(workspace, (_instance, state) => {
        state.storage.sql.exec("UPDATE spaces SET scope = 'personal' WHERE space_id = ?", spaceId);
      });
      await placeMembership(workspace, { workspaceId: WORKSPACE_ID, userId: CREATOR_ID, spaceId, workstreamId: WORKSTREAM_ID });
      const report = request();
      await service.create(report);
      expect(await env.MESSAGE_ISSUES_DB.prepare('SELECT channel_id FROM message_issues WHERE id = ?').bind(report.id).first())
        .toEqual({ channel_id: id });
    }
  });

  it('refuses a missing message or a conversation the reporter cannot read', async () => {
    await seedSourceTurn();
    const service = new MessageIssueService(env, creatorAuth);
    await expect(service.create(request('missing'))).rejects.toMatchObject({ code: 'message_issue_message_not_found' });
    const owner = parent();
    const operationId = crypto.randomUUID();
    const recipe = {
      policy: { revision: "test-empty-v1", strategy: { id: "empty", version: 1 }, config: {} },
      capture: "none" as const,
      parts: [],
    };
    const reserved = await owner.beginPrivateChildPreparation({
      workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, operationId, creatorUserId: CREATOR_ID, title: "Private breakout",
      sourceSubstreamId: "0" as const, sourceThroughTurnId: null, recipe,
      membershipInitializer: { plugin: { id: "creator-only", version: 1 }, config: {}, memberUserIds: [CREATOR_ID] },
    });
    const hash = "0".repeat(64);
    await owner.savePreparedPrivateChildContext({
      workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, operationId,
      preparedContext: { schemaVersion: 1, recipe, recipeHash: hash, capture: null, captureHash: null, parts: [], contentHash: hash },
    });
    await owner.claimPrivateChildConfirmation({ workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, operationId, actorUserId: CREATOR_ID });
    await bootstrapConversationChildRuntime(env, WORKSPACE_ID, "workstream", WORKSTREAM_ID, reserved.substreamId);
    await provisionWorkstreamObject(env, {
      workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, substreamId: reserved.substreamId,
      title: "Private breakout", objective: "", scope: "personal", createdByUserId: CREATOR_ID,
      participantUserIds: [CREATOR_ID], harnessStatus: "idle", titleStatus: "settled", emailAddress: null,
      emailRouteStatus: null, systemKind: null, modelOverride: null, now: Date.now(),
    });
    await conversation(reserved.substreamId).installPreparedSubstreamContext({
      workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, substreamId: reserved.substreamId, operationId,
    });
    await owner.setPrivateChildTerminalStatus({
      workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, operationId, status: "ready", errorCode: null,
    });
    await deliverEffectsToWorkspace(env, conversation(reserved.substreamId));
    const childId = reserved.substreamId;
    await runInDurableObject(conversation(childId), async (_instance, state) => seedParticipantMessage(state, {
      id: 'source-turn-1', sequence: 1, text: 'Private words', authorUserId: CREATOR_ID,
    }));
    await expect(new MessageIssueService(env, otherAuth).create(request('source-turn-1', childId)))
      .rejects.toMatchObject({ code: 'conversation_not_found' });
    expect((await env.MESSAGE_ISSUES_DB.prepare('SELECT id FROM message_issues').all()).results).toEqual([]);
    const input = request('source-turn-1', childId);
    await service.create(input);
    expect(await env.MESSAGE_ISSUES_DB.prepare('SELECT breakout_id, thread_id FROM message_issues WHERE id = ?').bind(input.id).first())
      .toEqual({ breakout_id: childId, thread_id: WORKSTREAM_ID });
  });

  it('resolves Channel message provenance and refuses messages from another Channel', async () => {
    const general = await new SpaceService(env, creatorAuth).ensureGeneral();
    const posted = await runInDurableObject(parent(), (_instance, state) =>
      new WorkspaceSpaceStorage(state.storage).postMessage(general.id, { author: { kind: 'member', userId: CREATOR_ID }, body: 'Channel announcement' }, 100));
    const service = new MessageIssueService(env, creatorAuth);
    const input = CreateMessageIssueSchema.parse({ id: crypto.randomUUID(), target: { kind: 'channel', channelId: general.id },
      messageId: posted.messageId, description: 'This announcement looks wrong.' });
    await service.create(input);
    await expect(service.create({ ...input, id: crypto.randomUUID(), messageId: 'missing-message' }))
      .rejects.toMatchObject({ code: 'message_issue_message_not_found' });
    expect(await env.MESSAGE_ISSUES_DB.prepare('SELECT channel_id, parent_kind, parent_id FROM message_issues WHERE id = ?').bind(input.id).first())
      .toEqual({ channel_id: general.id, parent_id: general.id, parent_kind: 'space' });
    await expect(service.create({ ...input, id: crypto.randomUUID(), target: { kind: 'channel', channelId: asSpaceId('00000000-0000-7000-8000-00000000db18') } }))
      .rejects.toMatchObject({ code: 'message_issue_message_not_found' });
  });
});
