import { asSubstreamId } from '@rally/contracts';
import type { DemoCatalog, DemoMessageRequest } from '@rally/contracts/demo-sidecar';
import type { AuthContext, Env } from '../env';
import { ApiError } from '../lib/api-error';
import { WorkstreamObjectCreateMessageInputSchema } from '../durable-objects/workstream-object-product';
import { WorkstreamDirectoryService } from './workstream-directory-service';
import { ConversationService } from './conversation-service';
import { provisionImpersonationRelationships, requireDemoOperator, requireImpersonationRelationship, representedDemoAuth } from './impersonation';

export async function demoCatalog(env: Env, auth: AuthContext): Promise<DemoCatalog> {
  const demo = await requireDemoOperator(env.DB, auth.workspaceId, auth.userId, env.AVALON_REGION);
  // Also enables pre-existing demos from their immutable cast. Revocations survive.
  await provisionImpersonationRelationships(env.DB, auth.workspaceId, demo.cast, demo.operationId);
  const participants: DemoCatalog['participants'] = [];
  for (const userId of demo.cast) {
    let represented: AuthContext;
    try { represented = await representedDemoAuth(env, auth, userId); }
    catch (error) { if (error instanceof ApiError && error.status === 403) continue; throw error; }
    const person = await env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(userId).first<{ name: string }>();
    if (!person) continue;
    const destinations: DemoCatalog['participants'][number]['destinations'] = [];
    const conversations = new ConversationService(env, represented);
    const directory = new WorkstreamDirectoryService(env, represented);
    let cursor: string | undefined;
    do {
      // Existing directory page size; paginate to completion, never cap the catalog.
      const page = await directory.list(100, cursor);
      for (const room of page.items) {
        try {
          const parent = await conversations.authorizeViewer(room.id);
          if (parent.archived || parent.kind !== 'workstream') continue;
          destinations.push({ workstreamId: room.id, substreamId: asSubstreamId('0'), label: room.title });
          for (const substreamId of await conversations.children(room.id)) {
            if (substreamId === '0') continue;
            try {
              const child = await conversations.authorizeViewer(room.id, substreamId);
              if (!child.archived) destinations.push({ workstreamId: room.id, substreamId: asSubstreamId(substreamId), label: `${room.title} / Breakout ${substreamId}` });
            } catch (error) { if (!(error instanceof ApiError && (error.status === 403 || error.status === 404))) throw error; }
          }
        } catch (error) { if (!(error instanceof ApiError && (error.status === 403 || error.status === 404))) throw error; }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    participants.push({ userId, name: person.name, destinations });
  }
  const labels = await env.DB.prepare('SELECT w.name AS workspaceName, u.name AS operatorName FROM workspaces w JOIN users u ON u.id = ? WHERE w.id = ?')
    .bind(auth.userId, auth.workspaceId).first<{ workspaceName: string; operatorName: string }>();
  if (!labels) throw new ApiError(403, 'demo_sidecar_denied', 'Demo sidecar is unavailable');
  return { workspaceId: auth.workspaceId, ...labels, participants };
}

export async function sendDemoMessage(env: Env, operator: AuthContext, input: DemoMessageRequest) {
  const auditId = crypto.randomUUID();
  let basis: string | null = null;
  const metadata = (code?: string) => JSON.stringify({ representedUserId: input.representedUserId, authorityBasis: basis,
    clientMessageId: input.clientMessageId, substreamId: input.substreamId, authMechanism: 'session', ...(code ? { code } : {}) });
  const audit = async (action: string, targetId: string, code?: string) => {
    await env.AUDIT_DB.prepare(`INSERT INTO audit_events
      (id, workspace_id, actor_type, actor_user_id, workstream_id, action, target_type, target_id, metadata_json, created_at)
      VALUES (?, ?, 'user', ?, ?, ?, 'message', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET action = excluded.action, target_id = excluded.target_id, metadata_json = excluded.metadata_json`)
      .bind(auditId, operator.workspaceId, operator.userId, input.workstreamId, action, targetId, metadata(code), new Date().toISOString()).run();
  };
  try {
    const auth = await representedDemoAuth(env, operator, input.representedUserId);
    basis = await requireImpersonationRelationship(env.DB, operator.workspaceId, operator.userId, auth.userId);
    const conversations = new ConversationService(env, auth);
    const parent = await conversations.authorizeViewer(input.workstreamId, input.substreamId);
    if (parent.kind !== 'workstream') throw new ApiError(403, 'impersonation_denied', 'Choose a Channel or Breakout');
    const client = await conversations.writableClient(input.workstreamId, input.substreamId);
    await audit('impersonation_attempt', input.clientMessageId);
    const result = await client.createMessage(WorkstreamObjectCreateMessageInputSchema.parse({ text: input.text, clientMessageId: input.clientMessageId }));
    await audit('impersonation_admitted', result.turn.turnId);
    return { turnId: result.turn.turnId };
  } catch (error) {
    const denied = error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404);
    await audit(denied ? 'impersonation_denied' : 'impersonation_failed', input.clientMessageId,
      error instanceof ApiError ? error.code : 'admission_failed');
    throw error;
  }
}
