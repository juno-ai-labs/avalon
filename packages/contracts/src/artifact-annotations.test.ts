import { describe, expect, it } from 'vitest';
import { AnnotationSchema, AnnotatedMessageContentSchema, AnnotationsSchema, MESSAGE_MAX_CHARACTERS, isHtmlResource, CreateMessageRequestSchema, annotationAllowedForResource, buildAnnotation } from './index';
const resourceId = '00000000-0000-7000-8000-0000000000a1';
const pin = () => buildAnnotation({ target: { resourceId, version: 4, locator: { type: 'markdown', start: 9, end: 15, headingPath: ['Plans'] } }, content: { exact: '**$12**', source: 'exact', before: 'Starter: ', after: ' yearly', truncated: false }, comment: 'Make this monthly' });
describe('artifact annotations', () => {
  it('admits annotation-only messages with a comment, and refuses empty requests', () => {
    expect(CreateMessageRequestSchema.parse({ text: '', clientMessageId: 'annotated', annotations: [pin()] }).annotations?.[0]?.content.exact).toBe('**$12**');
    expect(CreateMessageRequestSchema.safeParse({ text:'',clientMessageId:'empty',annotations:[{ ...pin(),comment:' ' }] }).success).toBe(false);
  });
  it('requires crop references to be sent as owned draft attachments', () => {
    const imageAttachmentId = '00000000-0000-7000-8000-0000000000a2';
    const annotation = { ...pin(), content: { ...pin().content, imageAttachmentId } };
    expect(CreateMessageRequestSchema.safeParse({text:'Fix',clientMessageId:'crop',annotations:[annotation]}).success).toBe(false);
    expect(CreateMessageRequestSchema.safeParse({text:'Fix',clientMessageId:'crop',annotations:[annotation],attachmentIds:[imageAttachmentId]}).success).toBe(true);
  });
  it('refuses reversed source offsets and image boxes outside their image', () => {
    expect(AnnotationSchema.safeParse({ ...pin(), target: {resourceId,version:1,locator:{type:'text',start:8,end:3,lines:[1,1]}} }).success).toBe(false);
    expect(AnnotationSchema.safeParse({ ...pin(), target: {resourceId,version:1,locator:{type:'region',x:0.8,y:0,w:0.5,h:1}} }).success).toBe(false);
    expect(AnnotationsSchema.parse([pin()])[0]?.target.version).toBe(4);
  });
  it('chooses locator and source policy from the authoritative MIME type', () => {
    expect(annotationAllowedForResource(pin(), {fileName:'plan.md',mimeType:'text/markdown'})).toBe(true);
    expect(annotationAllowedForResource(pin(), {fileName:'plan.pdf',mimeType:'application/pdf'})).toBe(false);
    expect(annotationAllowedForResource({...pin(),content:{...pin().content,source:'converted'}}, {fileName:'plan.md',mimeType:'text/markdown'})).toBe(false);
  });
  it('refuses an unknown color scheme and any page path that could leave the site',()=>{
    const viewport={width:416,height:500,scrollX:0,scrollY:120,devicePixelRatio:2,colorScheme:'dark' as const};
    const element={type:'element' as const,pagePath:'/pricing',css:'main > button:nth-of-type(1)',box:{x:0,y:0,w:1,h:1},visibleText:'Start free',viewport};
    expect(AnnotationSchema.safeParse({...pin(),target:{...pin().target,locator:{...element,viewport:{...viewport,colorScheme:'sepia'}}},content:{...pin().content,source:'rendered'}}).success).toBe(false);
    // A page path is one absolute path: a protocol-relative one would send the recipe to another host.
    expect(AnnotationSchema.safeParse({...pin(),target:{...pin().target,locator:{...element,pagePath:'//evil.example/x'}},content:{...pin().content,source:'rendered'}}).success).toBe(false);
    expect(AnnotationSchema.safeParse({...pin(),target:{...pin().target,locator:{...element,pagePath:'pricing'}},content:{...pin().content,source:'rendered'}}).success).toBe(false);
    // The URL parser would read these as protocol-relative too: a backslash is a slash, and a tab or newline is dropped.
    for (const pagePath of ['/\\evil.example/x', '/\t/evil.example/x', '/\n/evil.example/x', '/a\\b']) {
      expect(AnnotationSchema.safeParse({...pin(),target:{...pin().target,locator:{...element,pagePath}},content:{...pin().content,source:'rendered'}}).success).toBe(false);
      expect(new URL(pagePath, 'http://127.0.0.1:8765').origin === 'http://127.0.0.1:8765' || pagePath === '/a\\b').toBe(pagePath === '/a\\b');
    }
    expect(AnnotationSchema.safeParse({...pin(),target:{...pin().target,locator:{...element,pagePath:'/pricing?plan=team'}},content:{...pin().content,source:'rendered'}}).success).toBe(true);
  });
  it('reads a stored annotation with a key this build does not know, and still refuses one at admission',()=>{
    const stored={kind:'artifact_annotations',annotations:[{...pin(),target:{...pin().target,locator:{type:'element',css:'h1',box:{x:0,y:0,w:1,h:1,later:true},visibleText:'Plans',viewport:{width:400,height:900,scrollX:0,scrollY:0,devicePixelRatio:1,colorScheme:'light',later:true},later:true}},later:true}]};
    const read=AnnotatedMessageContentSchema.safeParse(stored);
    expect(read.success).toBe(true);
    expect(read.success && read.data.annotations[0]?.target.locator).toEqual({type:'element',css:'h1',box:{x:0,y:0,w:1,h:1},visibleText:'Plans',viewport:{width:400,height:900,scrollX:0,scrollY:0,devicePixelRatio:1,colorScheme:'light'}});
    expect(AnnotationsSchema.safeParse(stored.annotations).success).toBe(false);
  });

  it('applies comment limits only to newly admitted content',()=>{
    const annotation={...pin(),comment:'x'.repeat(MESSAGE_MAX_CHARACTERS+1)};
    expect(AnnotationsSchema.safeParse([annotation]).success).toBe(false);
    expect(AnnotatedMessageContentSchema.parse({kind:'artifact_annotations',annotations:[annotation]}).annotations[0]?.comment).toHaveLength(MESSAGE_MAX_CHARACTERS+1);
  });
  it('uses a shared normalized HTML policy for uploads and connectors',()=>{
    expect(isHtmlResource({fileName:'page.htm',mimeType:null})).toBe(true);
    expect(isHtmlResource({fileName:'page.html',mimeType:'application/octet-stream'})).toBe(true);
    expect(isHtmlResource({fileName:'page',mimeType:'TEXT/HTML; charset=UTF-8'})).toBe(true);
    expect(isHtmlResource({fileName:'page.html',mimeType:'image/png'})).toBe(false);
    expect(isHtmlResource({fileName:'page.html',mimeType:'text/plain'})).toBe(false);
  });

});
