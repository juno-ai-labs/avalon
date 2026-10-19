/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { asUserId, asWorkspaceId, asWorkstreamId, type Annotation } from '@rally/contracts';
import { workspaceDOName, conversationObjectName } from '../src/durable-objects/names';
import { ResourceService } from '../src/services/resource-service';
import { WorkstreamTranscriptStorage } from '../src/durable-objects/workstream-transcript-storage';
import { seedWorkspaceControlPlane, boot, seedWorkstreamRoot } from './helpers/substream-fixture';
const workspaceId = asWorkspaceId('00000000-0000-7000-8000-00000000a901');
const userId = asUserId('00000000-0000-7000-8000-00000000a902');
const workstreamId = asWorkstreamId('00000000-0000-7000-8000-00000000a903');
const resourceId = '00000000-0000-7000-8000-00000000a904';
const auth = { workspaceId, userId, sessionId:'00000000-0000-7000-8000-00000000a905', region:'global' as const,role:'member' as const };
const workspace = () => env.WORKSPACE_DOS.getByName(workspaceDOName('global',workspaceId));
const annotation: Annotation = { target:{resourceId,version:1,locator:{type:'markdown',start:0,end:9,headingPath:['Plans']}},content:{exact:'# Plans\n\n',source:'exact',before:'',after:'Old pricing',truncated:false},comment:'Make this monthly' };
beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB,{workspaceId,userId,sessionId:auth.sessionId});
  await workspace().initializeWorkspace(workspaceId,'wnam');
  await runInDurableObject(workspace(), (_instance,state) => {
    state.storage.sql.exec('DELETE FROM resources WHERE id = ?',resourceId);
    state.storage.sql.exec(`INSERT INTO resources (id,workspace_id,resource_type,provider,title,mime_type,content_ref,metadata_json,attachment_status,uploaded_by_user_id,created_at,updated_at)
      VALUES (?,?,'uploaded_file','avalon_upload','Plan.md','text/markdown','annotations/original','{}','attached',?,'2026-10-19T00:00:00.000Z','2026-10-19T00:00:00.000Z')`,resourceId,workspaceId,userId);
  });
});
describe('annotation targets and durable participant facts', () => {
  it('admits an existing owned attachment without reserving it and refuses missing versions',async () => {
    const service = new ResourceService(env,auth);
    expect(await service.annotationTarget(resourceId,1)).toMatchObject({title:'Plan.md',mimeType:'text/markdown',image:null});
    await expect(service.annotationTarget(resourceId,99)).rejects.toMatchObject({code:'resource_version_not_found'});
    await runInDurableObject(workspace(),(_instance,state) => {
      expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM pending_attachment_reservations WHERE resource_id = ?',resourceId).one().n).toBe(0);
    });
  });
  it('refuses another person’s private draft and the sender’s own unsent draft',async () => {
    await runInDurableObject(workspace(),(_instance,state) => { state.storage.sql.exec("UPDATE resources SET attachment_status = 'draft' WHERE id = ?",resourceId); });
    await expect(new ResourceService(env,auth).annotationTarget(resourceId,1)).rejects.toMatchObject({code:'annotation_target_draft'});
    await expect(new ResourceService(env,{...auth,userId:asUserId('00000000-0000-7000-8000-00000000a906')}).annotationTarget(resourceId,1)).rejects.toBeDefined();
  });
  it('retains every annotation in the canonical fact and opening snapshot',async () => {
    const stub = env.SUBSTREAM_AGENTS.getByName(conversationObjectName('global',workspaceId,workstreamId));
    await boot(stub);
    await runInDurableObject(stub,async (_instance,state) => {
      seedWorkstreamRoot(state);
      const storage = new WorkstreamTranscriptStorage(state.storage);
      await storage.appendParticipantMessage({turnId:'00000000-0000-7000-8000-00000000a907',actor:'human',authorUserId:userId,authorSnapshot:{displayName:'Author',avatarUrl:null},clientMessageId:'annotation-fact',messageType:'text',text:'',structuredContentJson:JSON.stringify({kind:'artifact_annotations',annotations:[annotation],names:{[resourceId]:'Plan.md'}}),createdAtUtc:'2026-10-19T00:00:00.000Z',producedByRunId:null,attentionOrdinal:1});
      const snapshot = storage.createOpeningSnapshot({unreadHighWaterAttentionOrdinal:null});
      expect(snapshot.ranges.flatMap((r) => r.turns).flatMap((t) => t.blocks)).toContainEqual(expect.objectContaining({type:'text',text:'',structuredContent:{kind:'artifact_annotations',annotations:[annotation],names:{[resourceId]:'Plan.md'}}}));
    });
  });
});
