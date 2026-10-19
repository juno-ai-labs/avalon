/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { asUserId, asWorkspaceId, asWorkstreamId, artifactAssetKey, type Annotation } from '@rally/contracts';
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
    await runInDurableObject(workspace(),(_instance,state)=>{state.storage.sql.exec("UPDATE resources SET attachment_status = 'attached' WHERE id = ?",resourceId);});
    await expect(new ResourceService(env,{...auth,userId:asUserId('00000000-0000-7000-8000-00000000a906')}).annotationTarget(resourceId,1)).rejects.toMatchObject({code:'resource_not_found'});
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
  it('retains both image versions and their saved model metadata',async()=>{
    await runInDurableObject(workspace(),(_instance,state)=>{
      state.storage.sql.exec("UPDATE resources SET title='Plan.png',mime_type='image/png',content_ref='image/v2',model_content_ref='image/model-v2',model_mime_type='image/png',model_metadata_json='{}' WHERE id=?",resourceId);
      state.storage.sql.exec("UPDATE resources SET content_ref='image/v3',model_content_ref='image/model-v3' WHERE id=?",resourceId);
    });
    const imagePin={...annotation,content:{...annotation.content,source:'exact' as const},target:{resourceId,version:2,locator:{type:'region' as const,x:0,y:0,w:1,h:1}}};
    const content=await new ResourceService(env,auth).annotationContent([imagePin,{...imagePin,target:{...imagePin.target,version:3}}]);
    expect(content.images).toEqual(expect.arrayContaining([
      expect.objectContaining({id:resourceId,resourceVersion:2,contentRef:'image/v2',modelContentRef:'image/model-v2',modelMimeType:'image/png',modelMetadataJson:'{}'}),
      expect.objectContaining({id:resourceId,resourceVersion:3,contentRef:'image/v3',modelContentRef:'image/model-v3',modelMimeType:'image/png'}),
    ]));
    expect(content.images).toHaveLength(2);
  });

  it('reads the exact saved text preview without requiring a model derivative',async()=>{
    await env.PAYLOADS.put('annotations/original','# Saved plans',{httpMetadata:{contentType:'text/markdown'}});
    const response=await new ResourceService(env,auth).versionPreview(resourceId,1);
    expect(response.headers.get('content-type')).toBe('text/markdown');
    expect(await response.text()).toBe('# Saved plans');
    await env.PAYLOADS.put('annotations/csv','Plan,Price\nStarter,12',{httpMetadata:{contentType:'text/csv'}});
    await runInDurableObject(workspace(),(_instance,state)=>{state.storage.sql.exec("UPDATE resources SET title='Plan.csv',mime_type='text/csv',content_ref='annotations/csv' WHERE id=?",resourceId);});
    expect(await (await new ResourceService(env,auth).versionPreview(resourceId,2)).text()).toBe('Plan,Price\nStarter,12');

  });

  it('reuses a saved browser image when the source needs normalization',async()=>{
    const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII='),(c)=>c.charCodeAt(0));
    await env.PAYLOADS.put('annotations/model.png',png);
    await env.PAYLOADS.put('annotations/original.heic','unavailable decoder fixture');
    await runInDurableObject(workspace(),(_instance,state)=>{state.storage.sql.exec("UPDATE resources SET title='Plan.heic',mime_type='image/heic',content_ref='annotations/original.heic',model_content_ref='annotations/model.png',model_mime_type='image/png' WHERE id=?",resourceId);});
    const response=await new ResourceService(env,auth).versionPreview(resourceId,2);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...png]);
  });

  it('serves only registered frozen HTML without executing site code',async()=>{
    const artifactId='00000000-0000-7000-8000-00000000a999';
    await runInDurableObject(workspace(),(_instance,state)=>{state.storage.sql.exec("INSERT INTO artifact_registry(artifact_id,workspace_id,workstream_id,resource_id,mode,current_version,manifest_ref,created_at,updated_at) VALUES (?,?,?,?,'active',7,'annotations/site-manifest',0,0)",artifactId,workspaceId,workstreamId,resourceId);});
    await env.PAYLOADS.put('annotations/site-manifest',JSON.stringify({version:1,artifactId,artifactVersion:7,mode:'active',stateful:false,serverModuleSha256:'a'.repeat(64),assets:[{path:'index.html',contentType:'text/html',sizeBytes:18,sha256:'b'.repeat(64)},{path:'private.json',contentType:'application/json',sizeBytes:2,sha256:'c'.repeat(64)}],totalBytes:20,publishedAt:'2026-10-19T00:00:00.000Z'}));
    await env.PAYLOADS.put(artifactAssetKey(artifactId,7,'index.html'),'<h1>Old plans</h1>');
    await env.PAYLOADS.put(artifactAssetKey(artifactId,7,'private.json'),'{}');
    await runInDurableObject(workspace(),(_instance,state)=>{state.storage.sql.exec("UPDATE resources SET title='Site',mime_type='application/vnd.rally.site-manifest+json',content_ref='annotations/site-manifest' WHERE id=?",resourceId);});
    const service=new ResourceService(env,auth);
    const response=await service.annotationSitePreview(resourceId,2,'/');
    expect(await response.text()).toBe('<h1>Old plans</h1>');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(service.annotationSitePreview(resourceId,2,'/private.json')).rejects.toMatchObject({code:'annotation_original_page_unavailable'});
    await runInDurableObject(workspace(),(_instance,state)=>{state.storage.sql.exec('UPDATE artifact_registry SET artifact_id=? WHERE resource_id=?','00000000-0000-7000-8000-00000000a998',resourceId);});
    await expect(service.annotationSitePreview(resourceId,2,'/')).rejects.toMatchObject({code:'artifact_not_found'});
  });

});
