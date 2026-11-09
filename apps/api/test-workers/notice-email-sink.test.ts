/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * The generic notification sinks on the real Organization object: every kind
 * renders once into a notice, and the email sink takes that notice when the
 * person chose email for the kind, through one template keyed on the intent.
 * A stored Slack choice is read as absent. `docs/push-notifications.md`
 * ("Sinks") owns the design.
 */
import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { asUserId, asWorkspaceId, asWorkstreamId } from '@rally/contracts';
import { workspaceDOName } from '../src/durable-objects/names';
import { deliverPush } from '../src/queues/push-delivery-consumer';
import { sendNoticeEmail } from '../src/services/notice-email';
import type { Notice } from '../src/services/notification-notice';

const workspaceId = asWorkspaceId('00000000-0000-7000-8000-00000000e501');
const canvasId = asWorkstreamId('00000000-0000-7000-8000-00000000e502');
const sidekickId = '00000000-0000-7000-8000-00000000e503';
const userId = asUserId('00000000-0000-7000-8000-00000000e504');
const actorId = asUserId('00000000-0000-7000-8000-00000000e505');
const resourceId = '00000000-0000-7000-8000-00000000e506';
const runId = '00000000-0000-7000-8000-00000000e507';
const messageId = '00000000-0000-7000-8000-00000000e508';
const workspace = () => env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName('global', workspaceId)));
const email = (intentId: string) => ({ workspaceId, recipientUserId: userId, region: 'global' as const, intentId, channel: 'email' as const });
const CANVAS_URL = 'https://app.test/app/global/1111117Hxt1fAWDjNQtG/cv/1111117Hxt1fAWDjNQtH/';
const SIDEKICK_URL = 'https://app.test/app/global/1111117Hxt1fAWDjNQtG/sk/1111117Hxt1fAWDjNQtJ/';

/** One intent per kind, as its producer stores it: its kind, what it is about, and the payload its notice renders from. */
const INTENTS: Array<[intentId: string, kind: string, parentId: string, payload: unknown]> = [
  ['mention:one', 'mention', canvasId, { kind: 'mention_notification', intentId: 'mention:one', messageId, recipientUserId: userId,
    authorUserId: actorId, authorNameSnapshot: 'Avery', workstreamTitleSnapshot: 'Launch plan', messageText: 'Can you **check** this?', occurredAt: '2026-11-08T00:00:00.000Z' }],
  ['participant_added:one', 'participant_added', canvasId, { kind: 'participant_notification', intentId: 'participant_added:one',
    sourceId: 'participant:one', recipientUserId: userId, actorUserId: actorId, actorNameSnapshot: 'Avery', workstreamTitleSnapshot: 'Launch plan',
    workstreamObjectiveSnapshot: 'Ship the launch', titleIsProvisional: false, occurredAt: '2026-11-08T00:00:00.000Z' }],
  ['new_message:one', 'new_message', canvasId, { kind: 'new_message', parentId: canvasId, parentTitle: 'Launch plan', messageId,
    authorName: 'Avery', text: 'Moved the date' }],
  ['artifact_updated:one', 'artifact_updated', canvasId, { kind: 'artifact_updated', parentId: canvasId, parentTitle: 'Launch plan',
    resourceId, artifactTitle: 'Brief', authorName: 'Avery' }],
  ['access_request:one', 'access_request', canvasId, { kind: 'access_request', parentId: canvasId, parentTitle: 'Launch plan',
    requestId: 'r1', requesterName: 'Robin', message: 'Let me in' }],
  ['access_granted:one', 'access_granted', canvasId, { kind: 'access_granted', parentId: canvasId, parentTitle: 'Launch plan',
    requestId: 'r2', deciderName: 'Avery' }],
  ['access_denied:one', 'access_denied', canvasId, { kind: 'access_denied', parentId: canvasId, requestId: 'r3', deciderName: 'Ada' }],
  ['run_finished:one', 'run_finished', sidekickId, { kind: 'run_finished', sidekickId, runId, sidekickName: 'Deploy watcher',
    state: 'completed', reply: 'Deployed.', occurredAt: 1 }],
  ['needs_input:one', 'needs_input', sidekickId, { kind: 'needs_input', sidekickId, runId, sidekickName: 'Deploy watcher',
    state: 'needs_input', reply: 'Which environment?', occurredAt: 1 }],
];

beforeEach(async () => {
  await reset();
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, region TEXT, abandoned_at TEXT, placement_affinity TEXT NOT NULL DEFAULT 'wnam')`),
    env.DB.prepare(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT)`),
    env.DB.prepare(`CREATE TABLE workspace_members (access_class TEXT NOT NULL DEFAULT 'member', workspace_id TEXT, user_id TEXT, status TEXT, role TEXT, revision INTEGER NOT NULL DEFAULT 1, incarnation TEXT NOT NULL DEFAULT 'existing-member')`),
    env.DB.prepare(`INSERT INTO workspaces (id, name, region, abandoned_at) VALUES (?, 'Juno Labs', 'global', NULL)`).bind(workspaceId),
    env.DB.prepare(`INSERT INTO users VALUES (?, 'robin@example.test', 'Robin Lee')`).bind(userId),
    env.DB.prepare(`INSERT INTO workspace_members (workspace_id, user_id, status, role) VALUES (?, ?, 'active', 'member')`).bind(workspaceId, userId),
  ]);
  await workspace().initializeWorkspace(workspaceId, 'wnam');
  await runInDurableObject(workspace(), (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(`INSERT INTO workspace_member_status (user_id, relationship_json, removed_incarnation, active, sequence, updated_at)
      VALUES (?, ?, NULL, 1, 1, 0)`, userId, JSON.stringify({ workspaceId, userId, accessClass: 'member', role: 'member', status: 'active', incarnation: 'i1', revision: 1 }));
    sql.exec(`INSERT INTO canvas_directory (canvas_id, workspace_id, title, created_by_user_id, created_at, updated_at, visibility, authority_generation)
      VALUES (?, ?, 'Launch plan', ?, 0, 0, 'workspace', 1)`, canvasId, workspaceId, actorId);
    sql.exec(`INSERT INTO automation_directory
        (automation_id, workspace_id, author_user_id, source_version, payload_hash, lifecycle, scope, owning_workstream_id, title, description, projected_at, authority_generation, region)
      VALUES (?, ?, ?, 1, 'hash', 'active', 'workspace', NULL, 'Deploy watcher', '', 1, 1, 'global')`, sidekickId, workspaceId, actorId);
    for (const [intentId, kind, parentId, payload] of INTENTS) {
      sql.exec(`INSERT INTO workstream_notification_intents
        (intent_id, workspace_id, workstream_id, recipient_user_id, source_message_id, source_generation,
         source_version, required_directory_version, notification_kind, payload_json, payload_hash, state, attempts, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, 1, 1, ?, ?, 'hash', 'delivered', 0, ?, ?)`,
        intentId, workspaceId, parentId, userId, `source:${intentId}`, kind, JSON.stringify(payload), new Date().toISOString(), new Date().toISOString());
    }
  });
});

it('hands the email sink the one rendered notice for every kind the person chose email for', async () => {
  await workspace().saveMemberPreferences({ workspaceId, userId, preferences: { notify: {
    mentions: ['email'], newMessages: ['email'], added: ['email'], runFinished: ['email'], artifactUpdates: ['email'], accessRequests: ['email'],
  } } });
  const sink = vi.fn<(env: unknown, notice: Notice) => Promise<{ outcome: 'sent' }>>(async () => ({ outcome: 'sent' }));
  for (const [intentId] of INTENTS) expect(await deliverPush(env, email(intentId), undefined, undefined, sink)).toBe(true);
  expect(sink.mock.calls.map(([, notice]) => ({ kind: notice.kind, title: notice.title, body: notice.body, actorName: notice.actorName, url: notice.url })))
    .toEqual([
      { kind: 'mention', title: 'Avery mentioned you in Launch plan', body: 'Can you check this?', actorName: 'Avery', url: CANVAS_URL },
      { kind: 'participant_added', title: 'Avery added you to Launch plan', body: 'Ship the launch', actorName: 'Avery', url: CANVAS_URL },
      { kind: 'new_message', title: 'Avery in Launch plan', body: 'Moved the date', actorName: 'Avery', url: CANVAS_URL },
      { kind: 'artifact_updated', title: 'Avery updated Brief in Launch plan', body: '', actorName: 'Avery', url: `${CANVAS_URL}a/1111117Hxt1fAWDjNQtM/` },
      { kind: 'access_request', title: 'Robin asked to open Launch plan', body: 'Let me in', actorName: 'Robin', url: CANVAS_URL },
      { kind: 'access_granted', title: 'Avery let you into Launch plan', body: '', actorName: 'Avery', url: CANVAS_URL },
      { kind: 'access_denied', title: 'Ada declined your request to open a Canvas', body: '', actorName: 'Ada', url: CANVAS_URL },
      { kind: 'run_finished', title: 'Deploy watcher finished', body: 'Deployed.', actorName: 'Deploy watcher', url: SIDEKICK_URL },
      { kind: 'needs_input', title: 'Deploy watcher needs your input', body: 'Which environment?', actorName: 'Deploy watcher', url: SIDEKICK_URL },
    ]);
});

it('sends no email for a kind left on push, and reads a stored Slack choice as no choice', async () => {
  await workspace().saveMemberPreferences({ workspaceId, userId, preferences: { notify: {
    mentions: ['slack_agent_dm'] as never, added: ['slack_agent_dm', 'email'] as never,
  } } });
  const sink = vi.fn(async () => ({ outcome: 'sent' as const }));
  expect(await deliverPush(env, email('mention:one'), undefined, undefined, sink)).toBe(true);
  expect(await deliverPush(env, email('new_message:one'), undefined, undefined, sink)).toBe(true);
  expect(sink).not.toHaveBeenCalled();
  expect(await deliverPush(env, email('participant_added:one'), undefined, undefined, sink)).toBe(true);
  expect(sink).toHaveBeenCalledTimes(1);
  expect((await workspace().memberPreferences({ workspaceId, userId })).notify).toMatchObject({ mentions: [], added: ['email'] });
});

it('sends one email per notice through Resend, its subject the notice title and its key the intent', async () => {
  const request = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ id: 're_1' }), { status: 200 }));
  const production = { ...env, APP_ENV: 'production' as const, RESEND_API_KEY: 'key', RESEND_NOTIFICATION_FROM_EMAIL: 'Rally <notify@rallywith.ai>' };
  const notice: Notice = { intentId: 'new_message:one', kind: 'new_message', title: 'Avery in Launch plan', body: 'Moved the date',
    actorName: 'Avery', url: CANVAS_URL, workspaceId, recipientUserId: userId, parentId: canvasId, substreamId: '0', replyTo: null };
  expect(await sendNoticeEmail(production, notice, request as unknown as typeof fetch)).toEqual({ outcome: 'sent' });
  const [, init] = request.mock.calls[0]!;
  const body = JSON.parse(String(init.body)) as { to: string[]; subject: string; text: string; tags: Array<{ name: string; value: string }> };
  expect((init.headers as Record<string, string>)['idempotency-key']).toBe(`rally-notice/${workspaceId}/new_message:one`);
  expect(body).toMatchObject({ to: ['robin@example.test'], subject: 'Avery in Launch plan',
    tags: [{ name: 'category', value: 'notification_new_message' }, { name: 'region', value: 'global' }] });
  expect(body.text).toBe([
    'Hi Robin,', '', 'Avery in Launch plan.', '', '"Moved the date"', '', `Open in Rally: ${CANVAS_URL}`, '',
    'You chose email for New messages in Juno Labs. Change it in Rally under Settings, Notifications.',
  ].join('\n'));
});
