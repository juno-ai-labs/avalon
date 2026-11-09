/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Reporting a message in a Canvas's Chat, on real workerd: the report lands
 * in the dedicated D1 database with the message's provenance, a replay
 * answers the same receipt, a changed replay is a conflict, internal events
 * are not reportable, and someone who cannot open the Canvas cannot report
 * from it.
 */

import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { asUserId, asWorkspaceId } from '@rally/contracts';
import { CreateMessageIssueSchema } from '@rally/contracts/message-issues';
import issueMigration from '../../../packages/db/message-issue-migrations/0001_message_issues.sql?raw';
import canvasIssueMigration from '../../../packages/db/message-issue-migrations/0002_message_issues_canvas.sql?raw';
import type { AuthContext, Env } from '../src/env';
import { MessageIssueService } from '../src/services/message-issue-service';
import { createCanvas } from '../src/services/canvas-service';
import { conversationObjectName, workspaceDOName } from '../src/durable-objects/names';
import { WorkstreamTranscriptStorage } from '../src/durable-objects/workstream-transcript-storage';
import { seedParticipantMessage, seedWorkspaceControlPlane } from './helpers/substream-fixture';

let WORKSPACE_ID = asWorkspaceId('00000000-0000-7000-8000-00000000db10');
let CANVAS_ID = '00000000-0000-7000-8000-00000000db13';
const CREATOR_ID = asUserId('00000000-0000-7000-8000-00000000db11');
const OTHER_ID = asUserId('00000000-0000-7000-8000-00000000db12');
const SESSION_ID = '00000000-0000-7000-8000-00000000db14';
const TEST_ENV: Env = env;
const creatorAuth: AuthContext = { sessionId: SESSION_ID, userId: CREATOR_ID, workspaceId: WORKSPACE_ID, region: 'global', role: 'owner' };
const otherAuth: AuthContext = { ...creatorAuth, userId: OTHER_ID, sessionId: 'other-session', role: 'member' };

function conversation() {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName('global', WORKSPACE_ID, CANVAS_ID)));
}
function workspace() { return env.WORKSPACE_DOS.getByName(workspaceDOName('global', WORKSPACE_ID)); }
function request(messageId = 'source-turn-1') {
  return CreateMessageIssueSchema.parse({ id: crypto.randomUUID(), target: { kind: 'conversation', parentId: CANVAS_ID, substreamId: '0' },
    messageId, blockId: `${messageId}:text:0`, description: 'I expected the correct answer.' });
}

beforeEach(async () => {
  // Fresh ids per case: an earlier case's deferred effects must not land in the next case's objects.
  WORKSPACE_ID = asWorkspaceId(crypto.randomUUID());
  creatorAuth.workspaceId = WORKSPACE_ID;
  otherAuth.workspaceId = WORKSPACE_ID;
  await reset();
  for (const migration of [issueMigration, canvasIssueMigration]) {
    await env.MESSAGE_ISSUES_DB.exec(migration.replace(/--[^\n]*\n/g, "").replace(/\s*\n\s*/g, " "));
  }
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: CREATOR_ID, sessionId: SESSION_ID });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`).bind(otherAuth.sessionId, OTHER_ID, WORKSPACE_ID),
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, access_class, last_seen_at)
      VALUES (?, ?, 'active', 'member', 'member', '2026-09-04T00:00:00.000Z')`).bind(WORKSPACE_ID, OTHER_ID),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_create_receipts (
      workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT,
      verified_at TEXT, activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_email_routes (
      local_part TEXT PRIMARY KEY COLLATE NOCASE, region TEXT NOT NULL,
      workspace_id TEXT NOT NULL, workstream_id TEXT, automation_subscription_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
  ]);
  // The creator's alone: the other member cannot open it.
  CANVAS_ID = (await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR_ID, title: 'Source' })).canvasId;
}, 30_000);

async function seedSourceTurn(): Promise<void> {
  await runInDurableObject(conversation(), async (_instance, state) => seedParticipantMessage(state, {
    id: 'source-turn-1', sequence: 1, text: 'The source decision', authorUserId: CREATOR_ID,
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
      message_id: 'assistant-turn', thread_id: null, breakout_id: null, substream_id: '0', parent_id: CANVAS_ID,
      description: 'I expected the correct answer.', parent_kind: 'canvas' });
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

  it('refuses a missing message, and a Canvas the reporter cannot open', async () => {
    await seedSourceTurn();
    const service = new MessageIssueService(env, creatorAuth);
    await expect(service.create(request('missing'))).rejects.toMatchObject({ code: 'message_issue_message_not_found' });
    await expect(new MessageIssueService(env, otherAuth).create(request()))
      .rejects.toMatchObject({ code: 'conversation_not_found' });
    expect((await env.MESSAGE_ISSUES_DB.prepare('SELECT id FROM message_issues').all()).results).toEqual([]);
    await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID,
      actor: { userId: CREATOR_ID, actorRole: 'member' }, update: { visibility: 'participants', userIds: [OTHER_ID] } });
    const input = request();
    await new MessageIssueService(env, otherAuth).create(input);
    expect(await env.MESSAGE_ISSUES_DB.prepare('SELECT reporter_user_id, parent_id FROM message_issues WHERE id = ?').bind(input.id).first())
      .toEqual({ reporter_user_id: OTHER_ID, parent_id: CANVAS_ID });
  });
});
