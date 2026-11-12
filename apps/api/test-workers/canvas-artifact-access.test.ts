import { ArtifactAccessMessageSchema } from '@rally/contracts/artifact-access';
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { reset, runInDurableObject, createExecutionContext, waitOnExecutionContext, runDurableObjectAlarm, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asArtifactId, asUserId, asWorkspaceId, type ArtifactManifest } from '@rally/contracts';
import type { WorkspaceDO } from '../src/durable-objects/workspace-do';
import { artifactHostDOName, workspaceDOName } from '../src/durable-objects/names';
import { applyArtifactAccessChange, consumeAccessRevocationQueue } from '../src/queues/access-revocation-consumer';
import artifactWorker from '../src/artifacts/index';
import { AuthorizationService } from '../src/services/authorization-service';
import { pointArtifactAtVersion } from '../src/services/terminal/site-resource-bridge';

const OWNER=asUserId('00000000-0000-7000-8000-0000000aa001');
const READER=asUserId('00000000-0000-7000-8000-0000000aa002');
const CANVAS='00000000-0000-7000-8000-0000000aa100';
const FILE='00000000-0000-7000-8000-0000000aa200';
const SITE='00000000-0000-7000-8000-0000000aa201';
const SITE_HOST=asArtifactId('00000000-0000-7000-8000-0000000aa202');
let workspaceId=asWorkspaceId(crypto.randomUUID());
const workspace=()=>env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName(env.AVALON_REGION,workspaceId)));
const host=(id:string)=>env.ARTIFACT_HOSTS.get(env.ARTIFACT_HOSTS.idFromName(artifactHostDOName(env.AVALON_REGION,asArtifactId(id))));
const share=(artifactVisibility:'editors'|'participants'|'workspace'|'public', artifactUserIds:string[]=[])=>workspace().canvasSetAudience({workspaceId,canvasId:CANVAS,
  actor:{userId:OWNER,actorRole:'member'},update:{visibility:'creator',userIds:[],artifactVisibility,artifactUserIds:artifactUserIds.map(asUserId)}});
const snapshot=async()=>{
  const delivery=await workspace().canvasArtifactAccessDelivery({workspaceId,canvasId:CANVAS});
  if(!delivery) throw new Error('missing test Canvas');
  return delivery.snapshot;
};
const sync=(artifactId:string,resourceId=artifactId)=>applyArtifactAccessChange(env,{kind:'artifact_access_sync',region:'global',workspaceId,canvasId:CANVAS,artifactId,resourceId});
async function consume(bodies:unknown[]) {
  const batch=createMessageBatch('avalon-do-runtime-test-access-revocations',bodies.map(body=>({id:crypto.randomUUID(),body,timestamp:new Date(),attempts:1})));
  await consumeAccessRevocationQueue(batch,env);
  expect((await getQueueResult(batch,createExecutionContext())).retryMessages).toEqual([]);
}

beforeEach(async()=>{
  await reset();
  workspaceId=asWorkspaceId(crypto.randomUUID());
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE workspaces(id TEXT PRIMARY KEY,name TEXT,abandoned_at TEXT,region TEXT,placement_affinity TEXT,analytics_workspace_id TEXT)'),
    env.DB.prepare("INSERT INTO workspaces VALUES(?,'Access test',NULL,'global','wnam',NULL)").bind(workspaceId),
    env.DB.prepare(`CREATE TABLE workspace_members(workspace_id TEXT,user_id TEXT,access_class TEXT,role TEXT,status TEXT,
      incarnation TEXT,revision INTEGER,joined_at TEXT,last_seen_at TEXT,PRIMARY KEY(workspace_id,user_id))`),
    env.DB.prepare(`INSERT INTO workspace_members VALUES(?1,?2,'member','member','active','owner-incarnation',1,NULL,NULL),
      (?1,?3,'member','member','active','reader-incarnation',1,NULL,NULL)`).bind(workspaceId,OWNER,READER),
    env.DB.prepare('CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,email TEXT)'),
    env.DB.prepare("INSERT INTO users VALUES(?,'Owner',NULL),(?,'Reader',NULL)").bind(OWNER,READER),
  ]);
  await env.PLATFORM_DB.prepare(`CREATE TABLE artifact_hostname_routes(hostname_stub TEXT NOT NULL PRIMARY KEY,region TEXT NOT NULL,
    artifact_id TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(region,artifact_id))`).run();
  await workspace().canvasCreate({workspaceId,canvasId:CANVAS,title:'Access test',createdByUserId:OWNER,authorityGeneration:1});
  await runInDurableObject(workspace(),(_instance:WorkspaceDO,state)=>{
    for(const [id,type,ref,mime] of [[FILE,'generated_file','test-file','text/plain'],[SITE,'generated_site','test-site-manifest','application/vnd.rally.site-manifest+json']]) {
      state.storage.sql.exec(`INSERT INTO resources(id,workspace_id,resource_type,provider,title,mime_type,content_ref,metadata_json,
        attachment_status,publication_parent_id,revision_author_kind,revision_author_user_id,revision_cause,created_at,updated_at)
        VALUES(?,?,?,'avalon_generated','Published output',?,?, '{}','attached',?,'member',?,'created',?,?)`,id,workspaceId,type,mime,ref,CANVAS,OWNER,
        '2026-11-11T12:00:00.000Z','2026-11-11T12:00:00.000Z');
    }
    state.storage.sql.exec(`INSERT INTO artifact_registry(artifact_id,workspace_id,workstream_id,resource_id,mode,stateful,current_version,
      manifest_ref,created_at,updated_at,hostname_stub) VALUES(?,?,?,?,'static',0,1,'test-site-manifest',1,1,'quiet-blue-river-garden')`,SITE_HOST,workspaceId,CANVAS,SITE);
  });
  const manifest:ArtifactManifest={version:1,artifactId:SITE_HOST,artifactVersion:1,mode:'static',stateful:false,serverModuleSha256:null,
    assets:[{path:'index.html',contentType:'text/html',sizeBytes:17,sha256:'a'.repeat(64)}],totalBytes:17,publishedAt:'2026-11-11T12:00:00.000Z'};
  await host(SITE_HOST).recordPublish({artifactId:SITE_HOST,workspaceId,workstreamId:CANVAS,resourceId:SITE,region:'global',manifest});
  await env.PAYLOADS.put('test-file','Published file');
  await env.PAYLOADS.put(`artifact/${SITE_HOST}/v1/assets/index.html`,'<h1>Website</h1>');
  await env.PLATFORM_DB.prepare("INSERT INTO artifact_hostname_routes VALUES('quiet-blue-river-garden','global',?,'2026-11-11T12:00:00Z')").bind(SITE_HOST).run();
});

async function visit(stub:string, path='/',cookie?:string) {
  const ctx=createExecutionContext();
  const response=await artifactWorker.fetch(new Request(`https://${stub}-g.rallyusercontent.com${path}`,{
    headers:cookie?{cookie:`__rally_artifact_session=${cookie}`,'sec-fetch-site':'same-origin'}:{},
  }),{APP_ENV:'test',AVALON_REGION:'global',ARTIFACT_SERVING_DOMAIN:'rallyusercontent.com',ARTIFACT_HOSTS:env.ARTIFACT_HOSTS,
    PLATFORM_DB:env.PLATFORM_DB,PAYLOADS:env.PAYLOADS},ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe('Canvas artifact access propagated to local serving',()=>{
  it('fails closed before the initial projection, then grants public files and sites and revokes both',async()=>{
    expect((await visit('quiet-blue-river-garden')).status).toBe(503);
    const legacy=await host(SITE_HOST).openForViewer({userId:OWNER,displayName:'Owner',appSessionId:'legacy-session'});
    const legacyViewer=await host(SITE_HOST).redeemCode(legacy.code);
    await share('public');
    await sync(SITE_HOST,SITE);
    await sync(FILE);
    expect(await (await visit('quiet-blue-river-garden')).text()).toContain('Website');
    const delivery=await workspace().canvasDetail({workspaceId,canvasId:CANVAS,actor:{userId:OWNER,actorRole:'member'}});
    expect(delivery.artifactVisibility).toBe('public');
    const fileRoute=await env.PLATFORM_DB.prepare('SELECT hostname_stub FROM artifact_hostname_routes WHERE artifact_id=?').bind(FILE).first<{hostname_stub:string}>();
    expect(fileRoute).not.toBeNull();
    expect(await (await visit(fileRoute!.hostname_stub)).text()).toBe('Published file');
    await share('editors');
    // Eventual consistency: the previous local projection remains until delivery.
    expect((await visit('quiet-blue-river-garden')).status).toBe(200);
    await sync(SITE_HOST,SITE); await sync(FILE);
    expect((await visit('quiet-blue-river-garden')).status).toBe(401);
    expect((await visit('quiet-blue-river-garden','/',legacyViewer!.session)).status).toBe(401);
    expect((await visit(fileRoute!.hostname_stub)).status).toBe(401);
  });

  it('artifact-only users can use artifacts but cannot read the conversation; old cookies lose access',async()=>{
    await share('participants',[READER]); await sync(SITE_HOST,SITE);
    await runInDurableObject(workspace(),async instance=>{
      await expect(instance.canvasDetail({workspaceId,canvasId:CANVAS,actor:{userId:READER,actorRole:'member'}})).rejects.toThrow();
    });
    const decision=await new AuthorizationService(env).checkMany({workspaceId,userId:READER,delegation:null},[{kind:'resource',workspaceId,resourceId:SITE}]);
    expect(decision[0]?.status).toBe('allowed');
    const {code}=await host(SITE_HOST).openForViewer({userId:READER,displayName:'Reader',appSessionId:'reader-session'});
    const session=await host(SITE_HOST).redeemCode(code);
    expect(session).not.toBeNull();
    expect((await visit('quiet-blue-river-garden','/',session!.session)).status).toBe(200);
    await share('editors'); await sync(SITE_HOST,SITE);
    expect((await visit('quiet-blue-river-garden','/',session!.session)).status).toBe(403);
    expect((await host(SITE_HOST).checkSession(session!.session)).ok).toBe(true);
  });

  it('rejects duplicate, stale and wrong-owner projections and retains archive tombstones',async()=>{
    await share('public'); const publicAccess=await snapshot(); await host(SITE_HOST).applyAccessSnapshot(publicAccess);
    await share('editors'); const privateAccess=await snapshot(); await host(SITE_HOST).applyAccessSnapshot(privateAccess);
    expect(await host(SITE_HOST).applyAccessSnapshot(publicAccess)).toEqual({applied:false});
    expect(await host(SITE_HOST).applyAccessSnapshot(privateAccess)).toEqual({applied:false});
    expect((await visit('quiet-blue-river-garden')).status).toBe(401);
    await runInDurableObject(host(SITE_HOST),async instance=>{
      await expect(instance.applyAccessSnapshot({...privateAccess,canvasId:crypto.randomUUID(),revision:privateAccess.revision+1})).rejects.toThrow('owner_mismatch');
    });
    await workspace().canvasArchive({workspaceId,canvasId:CANVAS,actor:{userId:OWNER,actorRole:'member'}});
    await host(SITE_HOST).applyAccessSnapshot(await snapshot());
    expect((await visit('quiet-blue-river-garden')).status).toBe(404);
    expect(await host(SITE_HOST).applyAccessSnapshot({...publicAccess,revision:privateAccess.revision+100})).toEqual({applied:false});
  });

  it('initializes current policy before publishing new site bytes',async()=>{
    await share('public'); await sync(SITE_HOST,SITE);
    await share('editors');
    expect((await visit('quiet-blue-river-garden')).status).toBe(200);
    const current=await host(SITE_HOST).currentState();
    await pointArtifactAtVersion(env,{artifactId:SITE_HOST,workspaceId,workstreamId:CANVAS,resourceId:SITE,region:'global',
      manifest:{...current!.manifest,artifactVersion:2}});
    expect((await visit('quiet-blue-river-garden')).status).toBe(401);
    expect((await host(SITE_HOST).currentState())?.version).toBe(2);
    // The older archive fan-out is also a permanent local serving fence.
    await host(SITE_HOST).archiveCanvas({workspaceId,canvasId:CANVAS});
    await share('public'); await sync(SITE_HOST,SITE);
    expect((await visit('quiet-blue-river-garden')).status).toBe(404);
  });

  it('fences file bytes to the policy revision captured with their references',async()=>{
    await share('public'); await sync(FILE);
    const oldAccess=await snapshot();
    await share('editors');
    await runInDurableObject(workspace(),(_instance,state)=>{
      state.storage.sql.exec("UPDATE resources SET content_ref='new-private-file',updated_at='2026-11-11T13:00:00.000Z' WHERE id=?",FILE);
    });
    const delivery=await workspace().canvasArtifactAccessDelivery({workspaceId,canvasId:CANVAS,resourceId:FILE});
    expect(delivery?.file?.versions.at(-1)?.contentRef).toBe('new-private-file');
    await host(FILE).applyAccessSnapshot(delivery!.snapshot);
    await host(FILE).recordFilePublication({workspaceId,canvasId:CANVAS,revision:oldAccess.revision,file:delivery!.file!});
    const {code}=await host(FILE).openForViewer({userId:OWNER,displayName:'Owner',appSessionId:'owner-session'});
    const viewer=await host(FILE).redeemCode(code);
    const stale=await host(FILE).admitRequest({session:viewer!.session});
    expect(stale.allowed && stale.kind==='file' && stale.file.versions.at(-1)?.contentRef).toBe('test-file');
    await host(FILE).recordFilePublication({workspaceId,canvasId:CANVAS,revision:delivery!.snapshot.revision,file:delivery!.file!});
    const fresh=await host(FILE).admitRequest({session:viewer!.session});
    expect(fresh.allowed && fresh.kind==='file' && fresh.file.versions.at(-1)?.contentRef).toBe('new-private-file');
    expect((await host(FILE).admitRequest({session:null})).allowed).toBe(false);
  });

  it('retains transactional retry intent and publishes it through the existing Queue',async()=>{
    const pending=await runInDurableObject(workspace(),(_instance,state)=>state.storage.transactionSync(()=>{
      state.storage.sql.exec("UPDATE canvas_directory SET artifact_visibility='workspace' WHERE canvas_id=?",CANVAS);
      return state.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM _internal_durable_alarms WHERE kind='canvas_artifact_access'").one().n;
    }));
    expect(pending).toBe(1);
    await runDurableObjectAlarm(workspace());
    // Bootstrap itself can schedule one newer revision; a second alarm drains it.
    await runDurableObjectAlarm(workspace());
    const remaining=await runInDurableObject(workspace(),(_instance,state)=>state.storage.sql.exec<{n:number}>(
      "SELECT COUNT(*) AS n FROM _internal_durable_alarms WHERE kind='canvas_artifact_access'").one().n);
    expect(remaining).toBe(0);
    const revision=(await snapshot()).revision;
    const probe=env.QUEUE_PROBE_TEST;
    if(!probe) throw new Error('queue_probe_missing');
    const root=await vi.waitFor(async()=>{
      const roots=(await probe.received()).flatMap(body=>{
        const result=ArtifactAccessMessageSchema.safeParse(body);
        return result.success && result.data.kind==='canvas_artifact_access_changed' && result.data.workspaceId===workspaceId && result.data.revision>=revision ? [result.data] : [];
      });
      expect(roots.length).toBeGreaterThan(0);
      return roots.at(-1)!;
    },{timeout:10_000});
    await consume([root]);
    const children=await vi.waitFor(async()=>{
      const children=(await probe.received()).flatMap(body=>{
        const result=ArtifactAccessMessageSchema.safeParse(body);
        return result.success && result.data.kind==='artifact_access_sync' && result.data.workspaceId===workspaceId ? [result.data] : [];
      });
      expect(new Set(children.map(child=>child.artifactId))).toEqual(new Set([FILE,SITE_HOST]));
      return children;
    },{timeout:10_000});
    await consume(children);
    expect((await host(SITE_HOST).admitRequest({session:null})).allowed).toBe(false);

  });

  it('propagates membership and role changes and fences concurrent sharing saves',async()=>{
    const initial=await share('workspace'); await sync(SITE_HOST,SITE);
    expect((await snapshot()).users.some(person=>person.userId===READER)).toBe(true);
    await workspace().applyMemberStatus({workspaceId,sequence:1,removed:true,relationship:{workspaceId,userId:READER,
      incarnation:'reader-incarnation',revision:2,accessClass:'member',role:'member',status:'active'}});
    expect((await snapshot()).users.some(person=>person.userId===READER)).toBe(false);
    await runInDurableObject(workspace(),async instance=>{
      await expect(instance.canvasSetAudience({workspaceId,canvasId:CANVAS,actor:{userId:OWNER,actorRole:'member'},update:{
      visibility:'creator',userIds:[],artifactVisibility:'public',expectedRevision:(initial.sharingRevision??0)-1,
    }})).rejects.toThrow('Sharing changed');
    });
  });

  it('serves after propagation without product D1 tables or Canvas authority reads',async()=>{
    await share('public'); await sync(SITE_HOST,SITE);
    await env.DB.prepare('DROP TABLE workspace_members').run();
    expect((await visit('quiet-blue-river-garden')).status).toBe(200);
  });
});
