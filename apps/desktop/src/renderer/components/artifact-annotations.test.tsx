import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {describe,expect,it,vi} from 'vitest';
import {AnnotationChips,AnnotationDraftProvider,useAnnotationDraft} from './artifact-annotations';
function Fixture():React.JSX.Element {
  const draft=useAnnotationDraft();
  return <><button onClick={()=>draft?.add({target:{resourceId:'00000000-0000-7000-8000-000000000001',version:1,locator:{type:'element',css:'button',box:{x:0,y:0,w:1,h:1},visibleText:'Start free'}},content:{exact:'<button>Start free</button>',source:'rendered',before:'',after:'',truncated:false},comment:''},'Website',()=>false)}>Receive popout pin</button><AnnotationChips/></>;
}
describe('draft annotation editing',()=>{
  it('edits a transferred pin after its original preview has closed',()=>{
    render(<AnnotationDraftProvider><Fixture/></AnnotationDraftProvider>);
    fireEvent.click(screen.getByRole('button',{name:'Receive popout pin'}));
    fireEvent.click(screen.getByRole('button',{name:/Start free/u}));
    const editor=screen.getByRole('textbox',{name:'Comment on pin 1'});
    fireEvent.change(editor,{target:{value:'Use Try Rally'}});
    fireEvent.keyDown(editor,{key:'Enter',keyCode:229});
    expect(editor).toBeVisible();
    fireEvent.keyDown(editor,{key:'Enter'});
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('Use Try Rally')).toBeVisible();
  });
});

it('manual reattachment preserves the authored comment and cancellation preserves the original',()=>{
  let draft:ReturnType<typeof useAnnotationDraft>;
  function Observe():React.JSX.Element|null {draft=useAnnotationDraft();return null;}
  render(<AnnotationDraftProvider><Observe/><AnnotationChips/></AnnotationDraftProvider>);
  const annotation={target:{resourceId:'00000000-0000-7000-8000-000000000001',version:1,locator:{type:'text' as const,start:0,end:3,lines:[1,1] as [number,number]}},content:{exact:'Old',source:'exact' as const,before:'',after:'',truncated:false},comment:'Please clarify'};
  act(()=>{draft!.add(annotation,'Notes',()=>false);});
  const original=draft!.pins[0]!;
  act(()=>{draft!.repair(original);});
  let candidate='';
  act(()=>{candidate=draft!.add({...annotation,target:{...annotation.target,version:2},content:{...annotation.content,exact:'New'},comment:''},'Notes',()=>false,undefined,true);});
  expect(draft!.selections.find((pin)=>pin.id===candidate)?.annotation.comment).toBe('Please clarify');
  act(()=>{draft!.discard(candidate);});
  expect(draft!.repairing).toBeNull();
  expect(draft!.pins[0]?.annotation.content.exact).toBe('Old');
  act(()=>{draft!.repair(original);});
  act(()=>{candidate=draft!.add({...annotation,target:{...annotation.target,version:2},content:{...annotation.content,exact:'New'},comment:''},'Notes',()=>false,undefined,true);});
  act(()=>{draft!.confirm(candidate);});
  expect(draft!.pins).toHaveLength(1);
  expect(draft!.pins[0]).toMatchObject({id:original.id,annotation:{comment:'Please clarify',target:{version:2},content:{exact:'New'}},original:{target:{version:1},content:{exact:'Old'}}});
});

it('a repaired comment can be reopened and confirmed again without deleting it',()=>{
  let draft:ReturnType<typeof useAnnotationDraft>;
  function Observe():React.JSX.Element|null {draft=useAnnotationDraft();return null;}
  render(<AnnotationDraftProvider><Observe/></AnnotationDraftProvider>);
  const annotation={target:{resourceId:'00000000-0000-7000-8000-000000000001',version:1,locator:{type:'file' as const}},content:{exact:'',source:'exact' as const,before:'',after:'',truncated:false},comment:'Keep this'};
  act(()=>{draft!.add(annotation,'Notes',()=>false);});
  const original=draft!.pins[0]!;
  act(()=>draft!.repair(original));
  let candidate='';
  const staleReveal=vi.fn(()=>true);
  act(()=>{candidate=draft!.add({...annotation,target:{...annotation.target,version:2}},'Notes',staleReveal,undefined,true);});
  act(()=>draft!.confirm(candidate));
  const open=vi.fn();
  act(()=>{draft!.setPreviewOpener(open);draft!.reveal(draft!.pins[0]!);});
  expect(staleReveal).not.toHaveBeenCalled();
  expect(open).toHaveBeenCalled();
  act(()=>draft!.confirm(original.id));
  expect(draft!.pins).toHaveLength(1);
  expect(draft!.pins[0]?.annotation.comment).toBe('Keep this');
  expect(draft!.pins[0]?.repairOf).toBeUndefined();
});

it.each(['edit','remove','send'] as const)('a detached transfer preserves a later %s while its image uploads',async(action)=>{
  let draft:ReturnType<typeof useAnnotationDraft>;
  let receive!:Parameters<NonNullable<NonNullable<typeof window.rally>['onArtifactAnnotations']>>[0];
  let finish!:(id:string)=>void;
  const upload=vi.fn(()=>new Promise<string>((resolve)=>{finish=resolve;}));
  const complete=vi.fn(async()=>{});
  vi.stubGlobal('rally',{registerAnnotationComposer:async()=>{},onArtifactAnnotations:(listener:typeof receive)=>{receive=listener;return ()=>{};},completeArtifactAnnotationTransfer:complete});
  function Observe():React.JSX.Element|null {draft=useAnnotationDraft();return null;}
  const view=render(<AnnotationDraftProvider scopeKey={crypto.randomUUID()} upload={upload}><Observe/></AnnotationDraftProvider>);
  try {
    const annotation={target:{resourceId:'00000000-0000-7000-8000-000000000001',version:1,locator:{type:'file' as const}},content:{exact:'',source:'exact' as const,before:'',after:'',truncated:false,imageAttachmentId:'00000000-0000-7000-8000-000000000002'},comment:'Original'};
    act(()=>draft!.add(annotation,'Notes',()=>false));
    const original=draft!.pins[0]!;
    act(()=>receive({transferId:'transfer',scope:draft!.scopeKey!,name:'Notes',pins:[{id:original.id,generation:original.generation!,annotation,image:new Uint8Array([1,2,3])}]}));
    expect(upload).toHaveBeenCalledTimes(1);
    act(()=>{if(action==='edit')draft!.comment(original.id,'Newer comment');else if(action==='remove')draft!.remove(original.id);else draft!.clearAccepted([original]);});
    await act(async()=>{finish('00000000-0000-7000-8000-000000000003');});
    await waitFor(()=>expect(complete).toHaveBeenCalledWith('transfer',true));
    if(action==='edit')expect(draft!.pins[0]?.annotation.comment).toBe('Newer comment');
    else expect(draft!.pins).toHaveLength(0);
  } finally {view.unmount();vi.unstubAllGlobals();}
});
