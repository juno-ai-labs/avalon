import { describe, expect, it } from 'vitest';
import type { Annotation } from '@rally/contracts';
import { projectParticipantModelMessage, projectParticipantTextMessage } from '../src/services/workstream-participant-model-message';
import { createTestEnv } from './helpers/cloudflare-test';
const resourceId='00000000-0000-7000-8000-000000000001';
const annotation:Annotation={target:{resourceId,version:3,locator:{type:'text',start:0,end:5,lines:[1,1]}},content:{exact:'Price',source:'exact',before:'',after:' $12',truncated:false},comment:'Make this monthly'};
const input={author:{type:'human' as const,userId:'00000000-0000-7000-8000-000000000002',displayName:'Adam'},messageType:'text',text:'',mentions:[],attachments:[],includeAttachmentContents:false,structuredContent:{kind:'artifact_annotations',annotations:[annotation]}};
describe('annotation model projection',()=>{
  it('projects a commented pin even when the message has no text or uploads',async()=>{
    const message=await projectParticipantModelMessage(createTestEnv({}),input);
    expect(message?.role).toBe('user');
    expect(message?.content).toContain('<selected>Price</selected>');
    expect(message?.content).toContain('<comment>Make this monthly</comment>');
    expect(message?.content).toContain('version="3"');
  });
  it('retains pins when overheard text is admitted on a later activation',()=>{
    const message=projectParticipantTextMessage({...input,overheard:true});
    expect(message?.content).toContain('SAID TO THE ROOM, NOT TO RALLY');
    expect(message?.content).toContain('<selected>Price</selected>');
  });
  it('retains the original immutable image alongside a crop when replaying an annotation',async()=>{
    const message=await projectParticipantModelMessage(createTestEnv({}),{...input,structuredContent:{...input.structuredContent,images:[{id:'original-image',workspaceId:'workspace',fileName:'Whole image.png',mimeType:'image/png',sizeBytes:1200,contentRef:'immutable/image-v3.png',modelContentRef:null,modelContentStatus:null}]}});
    expect(message?.content).toEqual(expect.arrayContaining([expect.objectContaining({type:'text',text:expect.stringContaining('Whole image.png')})]));
  });

});
