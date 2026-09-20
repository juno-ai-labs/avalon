/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { asUserId, asSubstreamId } from '@rally/contracts';
import { WORKSPACE_ID, WORKSTREAM_ID, USER_ID, seedWorkspaceControlPlane, boot, seedWorkstreamRoot } from './helpers/substream-fixture';
import { conversationObjectName, workspaceDOName, workstreamDOName } from '../src/durable-objects/names';
import { provisionImpersonationRelationships } from '../src/services/impersonation';
import { demoCatalog, sendDemoMessage } from '../src/services/demo-sidecar';
import type { AuthContext } from '../src/env';

const represented = asUserId('00000000-0000-7000-8000-000000000099');
const auth: AuthContext = { userId: USER_ID, workspaceId: WORKSPACE_ID, sessionId: 'sidecar-session', region: 'global', role: 'member' };
beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: USER_ID, sessionId: auth.sessionId });
  await env.DB.batch([
    env.DB.prepare('ALTER TABLE users ADD COLUMN platform_user_id TEXT'),
    env.DB.prepare("ALTER TABLE workspaces ADD COLUMN name TEXT DEFAULT 'Demo'"),
    env.DB.prepare('UPDATE users SET email = ?, platform_user_id = ? WHERE id = ?').bind('operator@rallywith.ai', USER_ID, USER_ID),
    env.DB.prepare('INSERT INTO users (id, name, email, platform_user_id) VALUES (?, ?, ?, ?)').bind(represented, 'Represented', 'participant@rallywith.ai', represented),
    env.DB.prepare("INSERT INTO workspace_members (workspace_id, user_id, status, role) VALUES (?, ?, 'active', 'member')").bind(WORKSPACE_ID, represented),
    env.DB.prepare('CREATE TABLE demo_operations (operation_id TEXT, workspace_id TEXT, presenter_user_id TEXT, cast_json TEXT, status TEXT, ready_at TEXT, retired_at TEXT)'),
    env.DB.prepare("INSERT INTO demo_operations VALUES ('demo', ?, ?, ?, 'ready', 'now', NULL)").bind(WORKSPACE_ID, USER_ID, JSON.stringify({ presenter: USER_ID, participant: represented })),
    env.DB.prepare('CREATE TABLE impersonation_relationships (workspace_id TEXT, operator_user_id TEXT, represented_user_id TEXT, authority_basis TEXT, created_at TEXT, revoked_at TEXT, PRIMARY KEY(workspace_id, operator_user_id, represented_user_id))'),
  ]);
  await provisionImpersonationRelationships(env.DB, WORKSPACE_ID, [USER_ID, represented], 'demo');
  const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName('global', WORKSPACE_ID)));
  await workspace.initializeWorkspace(WORKSPACE_ID, 'wnam');
  const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName('global', WORKSPACE_ID, WORKSTREAM_ID)));
  const parent = env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(workstreamDOName('global', WORKSPACE_ID, WORKSTREAM_ID)));
  await parent.reserveChild({ workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, substreamId: asSubstreamId('0'), kind: 'main', createdByUserId: USER_ID, authorityGeneration: 1,
    directory: { title: 'Fixture', description: '', scope: 'workspace', systemKind: null, emailAddress: null, titleStatus: 'settled', createdAt: new Date().toISOString() } });
  await boot(stub);
  await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));
});
it('refuses ordinary organizations and revoked relationships before represented admission', async () => {
  const input = { representedUserId: represented, workstreamId: WORKSTREAM_ID, substreamId: asSubstreamId('0'), text: 'Hello', clientMessageId: crypto.randomUUID() };
  await env.DB.prepare("UPDATE impersonation_relationships SET revoked_at = 'now' WHERE operator_user_id = ? AND represented_user_id = ?").bind(USER_ID, represented).run();
  await expect(sendDemoMessage(env, auth, input)).rejects.toMatchObject({ code: 'impersonation_denied' });
  await env.DB.prepare('DELETE FROM demo_operations').run();
  await expect(sendDemoMessage(env, auth, input)).rejects.toMatchObject({ code: 'demo_sidecar_denied' });
});
it('admits and replays a represented turn through ordinary admission with operator audit', async () => {
  const input = { representedUserId: represented, workstreamId: WORKSTREAM_ID, substreamId: asSubstreamId('0'), text: 'Thank you for the update.', clientMessageId: crypto.randomUUID() };
  const first = await sendDemoMessage(env, auth, input);
  const replay = await sendDemoMessage(env, auth, input);
  expect(replay.turnId).toBe(first.turnId);
  const audit = await env.AUDIT_DB.prepare("SELECT actor_user_id, target_id, metadata_json FROM audit_events WHERE action = 'impersonation_admitted'").all<{ actor_user_id: string; target_id: string; metadata_json: string }>();
  expect(audit.results).toHaveLength(2);
  expect(audit.results[0]).toMatchObject({ actor_user_id: USER_ID, target_id: first.turnId });
  expect(JSON.parse(audit.results[0]!.metadata_json)).toMatchObject({ representedUserId: represented });
  const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName('global', WORKSPACE_ID, WORKSTREAM_ID)));
  await runInDurableObject(stub, (_instance, state) => {
    const rows = state.storage.sql.exec('SELECT author_user_id FROM canonical_conversation_turn_details WHERE client_message_id = ?', input.clientMessageId).toArray();
    // Admission may queue processing, but there is exactly one durable input/turn.
    const pending = state.storage.sql.exec('SELECT author_user_id FROM pending_loop_inputs WHERE client_message_id = ?', input.clientMessageId).toArray();
    expect([...rows, ...pending]).toEqual([{ author_user_id: represented }]);
  });
});

it('rechecks the actual operator session at the conversation boundary', async () => {
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(auth.sessionId).run();
  await expect(sendDemoMessage(env, auth, { representedUserId: represented, workstreamId: WORKSTREAM_ID, substreamId: asSubstreamId('0'), text: 'Hello', clientMessageId: crypto.randomUUID() })).rejects.toMatchObject({ status: 401 });
});
it('audits denied attempts without retaining their body', async () => {
  await env.DB.prepare("UPDATE impersonation_relationships SET revoked_at = 'now'").run();
  await expect(sendDemoMessage(env, auth, { representedUserId: represented, workstreamId: WORKSTREAM_ID, substreamId: asSubstreamId('0'), text: 'private body', clientMessageId: crypto.randomUUID() })).rejects.toMatchObject({ status: 403 });
  const events = await env.AUDIT_DB.prepare("SELECT actor_user_id, metadata_json FROM audit_events WHERE action = 'impersonation_denied'").all();
  expect(events.results).toHaveLength(1);
  expect(events.results[0]?.actor_user_id).toBe(USER_ID);
  expect(JSON.stringify(events.results)).not.toContain('private body');
});

it('lists only original-cast destinations and admits self-send with the self relationship', async () => {
  const catalog = await demoCatalog(env, auth);
  expect(catalog.participants.map(person => person.userId).sort()).toEqual([USER_ID, represented].sort());
  expect(catalog.participants.find(person => person.userId === represented)?.destinations).toEqual([{ workstreamId: WORKSTREAM_ID, substreamId: '0', label: 'Fixture' }]);
  const input = { representedUserId: USER_ID, workstreamId: WORKSTREAM_ID, substreamId: asSubstreamId('0'), text: 'My own message', clientMessageId: crypto.randomUUID() };
  await expect(sendDemoMessage(env, auth, input)).resolves.toHaveProperty('turnId');
  await expect(sendDemoMessage(env, auth, { ...input, text: 'Different payload' })).rejects.toMatchObject({ status: 409 });
});
it('denies removed participants and unknown destinations', async () => {
  const input = { representedUserId: represented, workstreamId: '00000000-0000-7000-8000-000000000088', substreamId: asSubstreamId('0'), text: 'Hello', clientMessageId: crypto.randomUUID() };
  await expect(sendDemoMessage(env, auth, input)).rejects.toMatchObject({ status: 404 });
  await env.DB.prepare("UPDATE workspace_members SET status = 'removed' WHERE user_id = ?").bind(represented).run();
  await expect(sendDemoMessage(env, auth, { ...input, workstreamId: WORKSTREAM_ID })).rejects.toMatchObject({ status: 403 });
});
